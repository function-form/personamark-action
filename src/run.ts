import type { Runner } from "./actions.ts";
import { PersonaMark, type Job } from "./api.ts";
import { failsOnSomething, failures, parseFailOn } from "./policy.ts";
import { summarize } from "./summary.ts";

export const POLL_MS = 20_000;

export interface Deps {
  runner: Runner;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs the action. Returns the exit code: 0 passed, 1 failed. */
export async function run({ runner, fetch: fetchImpl = fetch, sleep = wait, now = Date.now }: Deps): Promise<number> {
  const key = runner.input("api-key");
  if (!key) {
    runner.error("api-key is empty. Pass a PersonaMark API key from a secret.");
    return 1;
  }
  const baseUrl = runner.input("base-url") || "https://work.personamark.app";
  const shouldWait = (runner.input("wait") || "true").toLowerCase() !== "false";
  const timeoutMinutes = Number(runner.input("timeout-minutes") || "30");
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
  let jobId: string;
  try {
    const started = await api.startAudit();
    jobId = started.jobId;
    runner.info(started.joined ? `An audit was already going; waiting on it (${jobId}).` : `Started an audit (${jobId}).`);
  } catch (error) {
    runner.error(`Could not start an audit: ${(error as Error).message}`);
    return 1;
  }
  runner.output("job-id", jobId);
  if (!shouldWait) return 0;

  const deadline = now() + timeoutMinutes * 60_000;
  let job: Job | null = null;
  let said = "";
  let warnedStalled = false;
  while (now() < deadline) {
    try {
      job = await api.job(jobId);
    } catch (error) {
      // A blip shouldn't end a half-hour wait; a refused key or a missing job should.
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 404) {
        runner.error(`Could not follow the audit: ${(error as Error).message}`);
        return 1;
      }
      runner.info(`Could not read the audit's progress (${(error as Error).message}); trying again.`);
    }
    if (job) {
      const progress = job.stage ? `${job.status}: ${job.stage}` : job.status;
      if (progress !== said) runner.info(`Audit ${progress}`);
      said = progress;
      if (job.stalled && !warnedStalled) {
        runner.info("The audit has been queued for a while; PersonaMark's worker may be busy or off.");
        warnedStalled = true;
      }
      if (["succeeded", "failed", "cancelled"].includes(job.status)) break;
    }
    await sleep(POLL_MS);
  }

  if (!job || !["succeeded", "failed", "cancelled"].includes(job.status)) {
    return unchecked(
      `The audit didn't finish within ${timeoutMinutes} minutes${job?.status === "queued" ? " and is still queued, so PersonaMark's worker may be off" : ""}. It carries on, and its results will be in PersonaMark.`,
    );
  }
  if (job.status !== "succeeded" || !job.auditId) {
    return unchecked(`The audit ${job.status === "cancelled" ? "was cancelled" : `failed: ${job.error ?? "no reason given"}`}.`);
  }

  const comparison = await api.compare(job.auditId);
  const failed = failures(comparison, rules);
  runner.output("audit-id", comparison.audit.id);
  runner.output("audit-url", comparison.audit.url);
  runner.output("score", String(comparison.score.now));
  runner.output("score-change", comparison.score.change === null ? "" : String(comparison.score.change));
  runner.output("new-high", String(comparison.counts.newHigh));
  runner.summary(summarize(comparison, failed));
  runner.info(`Score ${comparison.score.now}. ${comparison.audit.url}`);
  for (const reason of failed) runner.error(reason);
  return failed.length > 0 ? 1 : 0;
}
