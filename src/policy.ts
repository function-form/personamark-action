import type { ComparisonCore, PreviewRun } from "./api.ts";

/** When the step fails, from the `fail-on` input. */
export interface FailOn {
  newHigh: boolean;
  /** Fail when the score fell by at least this much, or null not to. */
  scoreDrop: number | null;
  /** Fail when a persona run on the preview didn't reach its goal, where production's did. */
  runFailed: boolean;
  /** Fail when a persona run's score fell by at least this much against production's. */
  runScoreDrop: number | null;
}

export const NEVER: FailOn = { newHigh: false, scoreDrop: null, runFailed: false, runScoreDrop: null };

/**
 * Reads `none`, `new-high`, `score-drop:<n>`, `run-failed` and `run-score-drop:<n>`,
 * comma-separated. Throws on anything else.
 */
export function parseFailOn(text: string): FailOn {
  const rules = { ...NEVER };
  for (const part of text.split(",").map((rule) => rule.trim().toLowerCase())) {
    if (part === "" || part === "none") continue;
    if (part === "new-high") {
      rules.newHigh = true;
      continue;
    }
    if (part === "run-failed") {
      rules.runFailed = true;
      continue;
    }
    const drop = /^(run-)?score-drop:(\d{1,3})$/.exec(part);
    if (drop?.[2] && Number(drop[2]) > 0) {
      if (drop[1]) rules.runScoreDrop = Number(drop[2]);
      else rules.scoreDrop = Number(drop[2]);
      continue;
    }
    throw new Error(
      `fail-on doesn't understand "${part}". Use none, new-high, score-drop:<n>, run-failed or run-score-drop:<n>, comma-separated.`,
    );
  }
  return rules;
}

export const failsOnSomething = (rules: FailOn) =>
  rules.newHigh || rules.scoreDrop !== null || rules.runFailed || rules.runScoreDrop !== null;

/** Why the step fails for this comparison, or nothing when it passes. */
export function failures(comparison: ComparisonCore, rules: FailOn): string[] {
  const reasons: string[] = [];
  const { newHigh } = comparison.counts;
  if (rules.newHigh && newHigh > 0) {
    reasons.push(`${newHigh} issue${newHigh === 1 ? "" : "s"} of high severity ${newHigh === 1 ? "is" : "are"} new or back.`);
  }
  const change = comparison.score.change;
  if (rules.scoreDrop !== null && change !== null && -change >= rules.scoreDrop) {
    reasons.push(`The score fell by ${-change}, from ${comparison.score.before} to ${comparison.score.now}.`);
  }
  return reasons;
}

/**
 * Why the step fails for one finished persona run, named by `who`. A run that didn't reach its
 * goal fails `run-failed` unless production's last run of the pair didn't either, since then the
 * pull request didn't break it.
 */
export function runFailures(who: string, previewRun: PreviewRun, rules: FailOn): string[] {
  const reasons: string[] = [];
  const reached = previewRun.status === "succeeded" && previewRun.run?.outcome === "completed";
  const productionReached = previewRun.production?.outcome === "completed";
  if (rules.runFailed && !reached && (productionReached || previewRun.production === null)) {
    reasons.push(
      previewRun.status === "succeeded"
        ? `${who} didn't reach the goal on the preview${productionReached ? ", though it does on production" : ""}.`
        : `${who} ${previewRun.status === "cancelled" ? "was cancelled" : "failed to run"} on the preview.`,
    );
  }
  const change = previewRun.scoreChange;
  if (rules.runScoreDrop !== null && change !== null && -change >= rules.runScoreDrop) {
    reasons.push(
      `${who} scored ${-change} lower on the preview, ${previewRun.run?.score} against production's ${previewRun.production?.score}.`,
    );
  }
  return reasons;
}
