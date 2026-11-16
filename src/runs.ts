import type { Pairs, PreviewRun, RunFigures } from "./api.ts";

/** A persona and the goal it tries, by their PersonaMark ids. */
export interface Pair {
  personaId: string;
  goalId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** More than this many runs a pull request is a lot of model calls; PersonaMark caps a key at 24 a day anyway. */
export const MAX_PAIRS = 5;

/**
 * Reads the `personas` input: `<persona-id>:<goal-id>` pairs, one a line or comma-separated, as
 * `GET /api/v1/personas` lists the ids. Throws on anything else.
 */
export function parsePairs(text: string): Pair[] {
  const pairs: Pair[] = [];
  for (const part of text.split(/[\n,]/).map((line) => line.trim())) {
    if (part === "" || part.startsWith("#")) continue;
    const [personaId, goalId, ...rest] = part.split(":").map((id) => id.trim());
    if (!personaId || !goalId || rest.length > 0 || !UUID.test(personaId) || !UUID.test(goalId)) {
      throw new Error(
        `personas doesn't understand "${part}". Give <persona-id>:<goal-id> pairs, one a line, with the ids from GET /api/v1/personas.`,
      );
    }
    const pair = { personaId: personaId.toLowerCase(), goalId: goalId.toLowerCase() };
    if (!pairs.some((p) => p.personaId === pair.personaId && p.goalId === pair.goalId)) pairs.push(pair);
  }
  if (pairs.length > MAX_PAIRS) {
    throw new Error(`personas names ${pairs.length} pairs; give at most ${MAX_PAIRS}, since each run costs model calls.`);
  }
  return pairs;
}

/** PersonaMark's words for a run's outcome. */
const OUTCOMES: Record<string, string> = {
  completed: "Completed",
  gave_up: "Gave up",
  step_limit: "Hit the step limit",
  time_limit: "Hit the time limit",
  stopped: "Stopped for safety",
  cancelled: "Cancelled",
};

export const outcomeLabel = (outcome: string | null | undefined) =>
  outcome ? (OUTCOMES[outcome] ?? outcome) : "Didn't finish";

const signed = (change: number) => (change > 0 ? `+${change}` : change < 0 ? `−${-change}` : "±0");

/** Table cells can't hold a pipe or a line break. */
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll(/[\r\n]+/g, " ");

const shorten = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** "1 blocking, 2 minor", or "none". */
function problems(friction: RunFigures["friction"]) {
  const parts = [
    friction.blocking > 0 ? `${friction.blocking} blocking` : null,
    friction.moderate > 0 ? `${friction.moderate} moderate` : null,
    friction.minor > 0 ? `${friction.minor} minor` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** A pair's names, from the site's personas and goals, or its ids when they're gone. */
export function pairName(pair: Pair, names: Pairs | null): { persona: string; goal: string } {
  const persona = names?.personas.find((p) => p.id === pair.personaId)?.name ?? pair.personaId.slice(0, 8);
  const goal = names?.goals.find((g) => g.id === pair.goalId)?.sentence ?? pair.goalId.slice(0, 8);
  return { persona, goal };
}

/** One run as the step left it: finished and read, or why it wasn't. */
export interface RunRow {
  pair: Pair;
  result: PreviewRun | null;
  /** Set when the step stopped waiting before it finished. */
  unfinished: boolean;
}

/** The persona runs' section of the summary, after the preview audit's. */
export function summarizeRuns(rows: RunRow[], names: Pairs | null, failed: string[]): string {
  const lines = [
    `## Persona runs on the preview`,
    ``,
    ...failed.map((reason) => `> [!CAUTION]\n> ${reason}\n`),
    `| Persona | Goal | Outcome | Score | Change | Problems | Production |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const { pair, result, unfinished } of rows) {
    const { persona, goal } = pairName(pair, names);
    const run = result?.run ?? null;
    const production = result?.production ?? null;
    const outcome = unfinished
      ? "Still going"
      : result?.status === "failed"
        ? `Didn't run: ${result.error ?? "no reason given"}`
        : result?.status === "cancelled"
          ? "Cancelled"
          : outcomeLabel(run?.outcome);
    const before = production
      ? `[${production.score ?? "not scored"}, ${outcomeLabel(production.outcome).toLowerCase()}](${production.url})`
      : "no scored run yet";
    lines.push(
      `| ${cell(persona)} | ${cell(shorten(goal))} | ${cell(outcome)} | ${run?.score ?? ""} | ${
        result?.scoreChange === null || result?.scoreChange === undefined ? "" : signed(result.scoreChange)
      } | ${run ? problems(run.friction) : ""} | ${before} |`,
    );
  }
  lines.push(
    ``,
    `Each run is compared with the same persona's last scored run at the goal on production. Scores are an AI model's judgement, not a measurement, so a few points either way can be noise.`,
  );
  return lines.join("\n");
}
