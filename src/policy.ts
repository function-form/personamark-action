import type { ComparisonCore } from "./api.ts";

/** When the step fails, from the `fail-on` input. */
export interface FailOn {
  newHigh: boolean;
  /** Fail when the score fell by at least this much, or null not to. */
  scoreDrop: number | null;
}

export const NEVER: FailOn = { newHigh: false, scoreDrop: null };

/** Reads `none`, `new-high` and `score-drop:<n>`, comma-separated. Throws on anything else. */
export function parseFailOn(text: string): FailOn {
  const rules = { ...NEVER };
  for (const part of text.split(",").map((rule) => rule.trim().toLowerCase())) {
    if (part === "" || part === "none") continue;
    if (part === "new-high") {
      rules.newHigh = true;
      continue;
    }
    const drop = /^score-drop:(\d{1,3})$/.exec(part);
    if (drop?.[1] && Number(drop[1]) > 0) {
      rules.scoreDrop = Number(drop[1]);
      continue;
    }
    throw new Error(
      `fail-on doesn't understand "${part}". Use none, new-high or score-drop:<n>, comma-separated.`,
    );
  }
  return rules;
}

export const failsOnSomething = (rules: FailOn) => rules.newHigh || rules.scoreDrop !== null;

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
