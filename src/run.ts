import type { Runner } from "./actions.ts";
import { PersonaMark, type ComparisonCore, type Job } from "./api.ts";
import { GitHubError, postComment } from "./comment.ts";
import { failsOnSomething, failures, parseFailOn } from "./policy.ts";
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

/** Where something is: a job or a preview, polled the same way. */
interface Progress {
  status: Job["status"];
  stage: string | null;
  stalled: boolean;
  error: string | null;
}

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
  try {
    rules = parseFailOn(runner.input("fail-on") || "none");
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
  const what = previewUrl ? "preview audit" : "audit";
  // When the result can't be checked, the step passes unless something was asked of it.
  const unchecked = (message: string) => {
    if (failsOnSomething(rules)) {
      runner.error(message);
      return 1;
    }
    runner.warning(message);
    return 0;
  };

  const api = new PersonaMark(baseUrl, key, fetchImpl);

  // Starting: a production audit, or a preview labelled with the commit and branch it came from.
  let id: string;
  let poll: () => Promise<Progress>;
  try {
    if (previewUrl) {
      const ref = runner.input("ref") || env.GITHUB_HEAD_REF || "";
      const sha = env.GITHUB_SHA ?? "";
      const started = await api.startPreview({
        url: previewUrl,
        ...(ref ? { ref } : {}),
        ...(/^[0-9a-f]{7,40}$/.test(sha) ? { sha } : {}),
        ...(pullRequest ? { pull_request: Number(pullRequest) } : {}),
      });
      id = started.previewId;
      poll = () => api.preview(id);
      runner.output("preview-id", id);
      runner.info(started.joined ? `This preview was already being audited; waiting on it (${id}).` : `Started a preview audit (${id}).`);
    } else {
      const started = await api.startAudit();
      id = started.jobId;
      poll = () => api.job(id);
      runner.output("job-id", id);
      runner.info(started.joined ? `An audit was already going; waiting on it (${id}).` : `Started an audit (${id}).`);
    }
  } catch (error) {
    runner.error(`Could not start the ${what}: ${(error as Error).message}`);
    return 1;
  }
  if (!shouldWait) return 0;

  const deadline = now() + timeoutMinutes * 60_000;
  let progress: Progress | null = null;
  let said = "";
  let warnedStalled = false;
  while (now() < deadline) {
    try {
      progress = await poll();
    } catch (error) {
      // A blip shouldn't end a half-hour wait; a refused key or a missing job should.
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 404) {
        runner.error(`Could not follow the ${what}: ${(error as Error).message}`);
        return 1;
      }
      runner.info(`Could not read the ${what}'s progress (${(error as Error).message}); trying again.`);
    }
    if (progress) {
      const line = progress.stage ? `${progress.status}: ${progress.stage}` : progress.status;
      if (line !== said) runner.info(`${previewUrl ? "Preview audit" : "Audit"} ${line}`);
      said = line;
      if (progress.stalled && !warnedStalled) {
        runner.info(`The ${what} has been queued for a while; PersonaMark's worker may be busy or off.`);
        warnedStalled = true;
      }
      if (FINISHED.includes(progress.status)) break;
    }
    await sleep(POLL_MS);
  }

  if (!progress || !FINISHED.includes(progress.status)) {
    return unchecked(
      `The ${what} didn't finish within ${timeoutMinutes} minutes${progress?.status === "queued" ? " and is still queued, so PersonaMark's worker may be off" : ""}. It carries on, and its results will be in PersonaMark.`,
    );
  }
  if (progress.status !== "succeeded") {
    return unchecked(
      `The ${what} ${progress.status === "cancelled" ? "was cancelled" : `failed: ${progress.error ?? "no reason given"}`}.`,
    );
  }

  let comparison: ComparisonCore;
  let markdown: string;
  let link: string | null;
  const failed: string[] = [];
  if (previewUrl) {
    const compared = await api.comparePreview(id);
    failed.push(...failures(compared, rules));
    comparison = compared;
    markdown = summarizePreview(compared, failed);
    link = compared.productionAuditUrl;
  } else {
    const job = progress as Job;
    if (!job.auditId) return unchecked("The audit finished without saving one.");
    const compared = await api.compare(job.auditId);
    failed.push(...failures(compared, rules));
    comparison = compared;
    markdown = summarize(compared, failed);
    link = compared.audit.url;
    runner.output("audit-id", compared.audit.id);
  }
  if (link) runner.output("audit-url", link);
  runner.output("score", String(comparison.score.now));
  runner.output("score-change", comparison.score.change === null ? "" : String(comparison.score.change));
  runner.output("new-high", String(comparison.counts.newHigh));
  runner.summary(markdown);
  await comment(runner, env, markdown, fetchImpl);
  runner.info(`Score ${comparison.score.now}.${link ? ` ${link}` : ""}`);
  for (const reason of failed) runner.error(reason);
  return failed.length > 0 ? 1 : 0;
}
