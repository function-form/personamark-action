import type { Runner } from "./actions.ts";
import { PersonaMark, type ComparisonCore, type Job, type Pairs, type PreviewRun } from "./api.ts";
import { GitHubError, postComment } from "./comment.ts";
import { failsOnSomething, failures, parseFailOn, runFailures } from "./policy.ts";
import { pairName, parsePairs, summarizeRuns, type Pair, type RunRow } from "./runs.ts";
import { summarize, summarizePreview } from "./summary.ts";

export const POLL_MS = 20_000;

export interface Deps {
  runner: Runner;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The runner's environment, for the repository and commit to comment on. */
  env?: NodeJS.ProcessEnv;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FINISHED: readonly Job["status"][] = ["succeeded", "failed", "cancelled"];

/** Where something is: a job, a preview or a preview run, polled the same way. */
interface Progress {
  status: Job["status"];
  stage: string | null;
  stalled: boolean;
  error: string | null;
}

/** One thing the step waits on, and what it last said about it. */
interface Tracked<T extends Progress> {
  label: string;
  poll: () => Promise<T>;
  progress: T | null;
  said: string;
  warnedStalled: boolean;
}

const track = <T extends Progress>(label: string, poll: () => Promise<T>): Tracked<T> => ({
  label,
  poll,
  progress: null,
  said: "",
  warnedStalled: false,
});

const finished = (tracked: Tracked<Progress>) =>
  tracked.progress !== null && FINISHED.includes(tracked.progress.status);

/**
 * Comments the summary on the deployed commit's pull request, or the commit. A comment is a
 * convenience, so failing to post one only warns, with what the job's permissions need.
 */
async function comment(runner: Runner, env: NodeJS.ProcessEnv, markdown: string, fetchImpl: typeof fetch) {
  if ((runner.input("comment") || "true").toLowerCase() === "false") return;
  const token = runner.input("github-token");
  const repository = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  if (!token || !repository || !sha) {
    runner.warning("Not commenting: there's no GitHub token, repository or commit to comment on.");
    return;
  }
  try {
    const posted = await postComment(
      { token, repository, sha, apiUrl: env.GITHUB_API_URL || "https://api.github.com" },
      markdown,
      fetchImpl,
    );
    runner.info(`Commented on ${posted.on === "pull" ? `pull request #${posted.number}` : "the commit"}: ${posted.url}`);
  } catch (error) {
    const denied = error instanceof GitHubError && (error.status === 403 || error.status === 404);
    runner.warning(
      denied
        ? `Couldn't comment (${error.message}). Give the job \`pull-requests: write\`, and \`contents: write\` to comment on a commit with no pull request, or set comment: false.`
        : `Couldn't comment: ${(error as Error).message}`,
    );
  }
}

/** Runs the action. Returns the exit code: 0 passed, 1 failed. */
export async function run({
  runner,
  fetch: fetchImpl = fetch,
  sleep = wait,
  now = Date.now,
  env = process.env,
}: Deps): Promise<number> {
  const key = runner.input("api-key");
  if (!key) {
    runner.error("api-key is empty. Pass a PersonaMark API key from a secret.");
    return 1;
  }
  const baseUrl = runner.input("base-url") || "https://work.personamark.app";
  const shouldWait = (runner.input("wait") || "true").toLowerCase() !== "false";
  const timeoutMinutes = Number(runner.input("timeout-minutes") || "30");
  const previewUrl = runner.input("preview-url");
  const pullRequest = runner.input("pull-request");
  let rules;
  let pairs: Pair[];
  try {
    rules = parseFailOn(runner.input("fail-on") || "none");
    pairs = parsePairs(runner.input("personas"));
  } catch (error) {
    runner.error((error as Error).message);
    return 1;
  }
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    runner.error("timeout-minutes must be a positive number.");
    return 1;
  }
  if (pullRequest && !/^[1-9]\d{0,9}$/.test(pullRequest)) {
    runner.error("pull-request must be a pull request's number.");
    return 1;
  }
  if (pairs.length > 0 && !previewUrl) {
    runner.error("personas runs on a preview, so it needs preview-url.");
    return 1;
  }
  const what = previewUrl ? "preview audit" : "audit";
  // When a result can't be checked, the step passes unless something was asked of it.
  const unchecked = (message: string) => {
    if (failsOnSomething(rules)) {
      runner.error(message);
      return 1;
    }
    runner.warning(message);
    return 0;
  };

  const api = new PersonaMark(baseUrl, key, fetchImpl);

  // Starting: a production audit, or a preview labelled with the commit and branch it came from,
  // and any persona runs on that preview beside it.
  let audit: Tracked<Progress>;
  let previewId: string | null = null;
  const runs: { pair: Pair; tracked: Tracked<PreviewRun> }[] = [];
  try {
    if (previewUrl) {
      const ref = runner.input("ref") || env.GITHUB_HEAD_REF || "";
      const sha = env.GITHUB_SHA ?? "";
      const label = {
        ...(ref ? { ref } : {}),
        ...(/^[0-9a-f]{7,40}$/.test(sha) ? { sha } : {}),
        ...(pullRequest ? { pull_request: Number(pullRequest) } : {}),
      };
      const started = await api.startPreview({ url: previewUrl, ...label });
      const id = started.previewId;
      previewId = id;
      audit = track("Preview audit", () => api.preview(id));
      runner.output("preview-id", id);
      runner.info(started.joined ? `This preview was already being audited; waiting on it (${id}).` : `Started a preview audit (${id}).`);

      for (const pair of pairs) {
        const name = `${pair.personaId.slice(0, 8)} at ${pair.goalId.slice(0, 8)}`;
        let begun;
        try {
          begun = await api.startPreviewRun({ url: previewUrl, persona_id: pair.personaId, goal_id: pair.goalId, ...label });
        } catch (error) {
          runner.error(`Could not start the persona run ${name}: ${(error as Error).message}`);
          return 1;
        }
        const runId = begun.previewRunId;
        runs.push({ pair, tracked: track(`Persona run ${name}`, () => api.previewRun(runId)) });
        runner.info(
          begun.joined
            ? `The persona run ${name} was already going on this preview; waiting on it (${runId}).`
            : `Started the persona run ${name} (${runId}).`,
        );
      }
    } else {
      const started = await api.startAudit();
      const id = started.jobId;
      audit = track("Audit", () => api.job(id));
      runner.output("job-id", id);
      runner.info(started.joined ? `An audit was already going; waiting on it (${id}).` : `Started an audit (${id}).`);
    }
  } catch (error) {
    runner.error(`Could not start the ${what}: ${(error as Error).message}`);
    return 1;
  }
  if (!shouldWait) return 0;

  const everything: Tracked<Progress>[] = [audit, ...runs.map(({ tracked }) => tracked)];
  const deadline = now() + timeoutMinutes * 60_000;
  while (now() < deadline) {
    for (const tracked of everything.filter((item) => !finished(item))) {
      try {
        tracked.progress = await tracked.poll();
      } catch (error) {
        // A blip shouldn't end a half-hour wait; a refused key or a missing job should.
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 404) {
          runner.error(`Could not follow the ${tracked.label.toLowerCase()}: ${(error as Error).message}`);
          return 1;
        }
        runner.info(`Could not read the ${tracked.label.toLowerCase()}'s progress (${(error as Error).message}); trying again.`);
        continue;
      }
      const { progress } = tracked;
      const line = progress.stage ? `${progress.status}: ${progress.stage}` : progress.status;
      if (line !== tracked.said) runner.info(`${tracked.label} ${line}`);
      tracked.said = line;
      if (progress.stalled && !tracked.warnedStalled) {
        runner.info(`The ${tracked.label.toLowerCase()} has been queued for a while; PersonaMark's worker may be busy or off.`);
        tracked.warnedStalled = true;
      }
    }
    if (everything.every(finished)) break;
    await sleep(POLL_MS);
  }

  // The audit's result, or why there isn't one.
  const progress = audit.progress;
  let auditProblem: string | null = null;
  if (!progress || !FINISHED.includes(progress.status)) {
    auditProblem = `The ${what} didn't finish within ${timeoutMinutes} minutes${progress?.status === "queued" ? " and is still queued, so PersonaMark's worker may be off" : ""}. It carries on, and its results will be in PersonaMark.`;
  } else if (progress.status !== "succeeded") {
    auditProblem = `The ${what} ${progress.status === "cancelled" ? "was cancelled" : `failed: ${progress.error ?? "no reason given"}`}.`;
  } else if (!previewId && !(progress as Job).auditId) {
    auditProblem = "The audit finished without saving one.";
  }
  // Without persona runs, an audit that can't be checked ends the step, as it always has.
  if (auditProblem && runs.length === 0) return unchecked(auditProblem);

  let code = 0;
  const failed: string[] = [];
  const sections: string[] = [];
  let comparison: ComparisonCore | null = null;
  let link: string | null = null;
  if (auditProblem) {
    code = Math.max(code, unchecked(auditProblem));
    sections.push(`## PersonaMark preview audit\n\n${auditProblem}`);
  } else if (previewId) {
    const compared = await api.comparePreview(previewId);
    const reasons = failures(compared, rules);
    failed.push(...reasons);
    comparison = compared;
    sections.push(summarizePreview(compared, reasons));
    link = compared.productionAuditUrl;
  } else {
    const compared = await api.compare((progress as Job).auditId as string);
    failed.push(...failures(compared, rules));
    comparison = compared;
    sections.push(summarize(compared, failed));
    link = compared.audit.url;
    runner.output("audit-id", compared.audit.id);
  }

  if (runs.length > 0) {
    const names: Pairs | null = await api.pairs().catch(() => null);
    const rows: RunRow[] = [];
    const runReasons: string[] = [];
    for (const { pair, tracked } of runs) {
      const result = tracked.progress;
      const done = finished(tracked);
      rows.push({ pair, result, unfinished: !done });
      const { persona, goal } = pairName(pair, names);
      const who = `${persona} at "${goal}"`;
      if (!done || !result) {
        code = Math.max(
          code,
          unchecked(`The persona run of ${who} didn't finish within ${timeoutMinutes} minutes. It carries on in PersonaMark.`),
        );
        continue;
      }
      runReasons.push(...runFailures(who, result, rules));
    }
    failed.push(...runReasons);
    sections.push(summarizeRuns(rows, names, runReasons));
    runner.output(
      "runs",
      JSON.stringify(
        rows.map(({ pair, result }) => ({
          personaId: pair.personaId,
          goalId: pair.goalId,
          previewRunId: result?.id ?? null,
          status: result?.status ?? null,
          outcome: result?.run?.outcome ?? null,
          score: result?.run?.score ?? null,
          scoreChange: result?.scoreChange ?? null,
        })),
      ),
    );
  }

  if (link) runner.output("audit-url", link);
  if (comparison) {
    runner.output("score", String(comparison.score.now));
    runner.output("score-change", comparison.score.change === null ? "" : String(comparison.score.change));
    runner.output("new-high", String(comparison.counts.newHigh));
  }
  const markdown = sections.join("\n\n");
  runner.summary(markdown);
  await comment(runner, env, markdown, fetchImpl);
  if (comparison) runner.info(`Score ${comparison.score.now}.${link ? ` ${link}` : ""}`);
  for (const reason of failed) runner.error(reason);
  return failed.length > 0 ? 1 : code;
}
