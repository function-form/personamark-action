import { describe, expect, it } from "vitest";

import type { Runner } from "./actions.ts";
import type { PreviewRun } from "./api.ts";
import { parseFailOn, runFailures } from "./policy.ts";
import { run } from "./run.ts";
import { parsePairs } from "./runs.ts";

const KEY = `pm_${"A".repeat(43)}`;
const DANA = "3f2b8c1e-7a4d-4e9b-8c21-5d6f7a8b9c0d";
const CAKE = "8b0f3c2e-4f0a-4f7e-9f61-0d1d3a8f5b21";
const SAM = "5a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const RUN_URL = "https://work.personamark.app/organizations/o/projects/p/personas/runs/r0";
const PREVIEW = "https://site-git-x-acme.vercel.app/";

const figures = (outcome: string, score: number, blocking = 0) => ({
  outcome,
  score,
  steps: 6,
  areas: { completion: { score: 30, max: 30 } },
  friction: { total: blocking, blocking, moderate: 0, minor: 0, steps: blocking ? [3] : [] },
});

const previewRun = (overrides: Partial<PreviewRun> = {}): PreviewRun => ({
  id: "r1",
  jobId: "j2",
  status: "succeeded",
  stage: null,
  stalled: false,
  error: null,
  personaId: DANA,
  goalId: CAKE,
  run: figures("gave_up", 40, 1),
  production: { ...figures("completed", 82), url: RUN_URL },
  scoreChange: -42,
  ...overrides,
});

const previewComparison = {
  comparedWith: { id: "a0", createdAt: "2026-11-04T00:00:00Z" },
  score: { now: 90, before: 90, change: 0 },
  areas: [],
  counts: { new: 0, regressed: 0, recurring: 0, fixed: 0, newHigh: 0 },
  changedChecks: [],
  new: [],
  regressed: [],
  fixed: [],
  preview: {
    id: "p1",
    createdAt: "2026-11-11T00:00:00Z",
    previewOrigin: "https://site-git-x-acme.vercel.app",
    ref: "feat/x",
    sha: null,
    pullRequest: 12,
    partial: false,
    capped: false,
  },
  productionAuditUrl: "https://work.personamark.app/a0",
};

function fakeRunner(inputs: Record<string, string>) {
  const outputs: Record<string, string> = {};
  const logs: string[] = [];
  const summaries: string[] = [];
  const runner: Runner = {
    input: (name) => inputs[name] ?? "",
    output: (name, value) => {
      outputs[name] = value;
    },
    summary: (markdown) => {
      summaries.push(markdown);
    },
    info: (message) => logs.push(`info ${message}`),
    warning: (message) => logs.push(`warning ${message}`),
    error: (message) => logs.push(`error ${message}`),
  };
  return { runner, outputs, logs, summaries };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake PersonaMark: a preview that's done at once, and a run read in turn from `reads`. */
function fakeApi(reads: Partial<PreviewRun>[], start: () => Response = () => json({ previewRunId: "r1", jobId: "j2" }, 202)) {
  const calls: { call: string; body?: unknown }[] = [];
  let read = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({
      call: `${init?.method ?? "GET"} ${path}`,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (path === "/api/v1/previews") return json({ previewId: "p1", jobId: "j1" }, 202);
    if (path === "/api/v1/previews/p1") {
      return json({ id: "p1", jobId: "j1", status: "succeeded", stage: null, stalled: false, error: null });
    }
    if (path === "/api/v1/previews/p1/compare") return json(previewComparison);
    if (path === "/api/v1/preview-runs") return start();
    if (path === "/api/v1/preview-runs/r1") return json(previewRun(reads[Math.min(read++, reads.length - 1)]));
    if (path === "/api/v1/personas") {
      return json({
        personas: [{ id: DANA, name: "Dana" }],
        goals: [{ id: CAKE, sentence: "Order a birthday cake for Saturday.", signsIn: false }],
      });
    }
    return json({ error: "nope" }, 404);
  }) as typeof fetch;
  return { impl, calls };
}

function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async (ms: number) => void (time += ms), env: { GITHUB_HEAD_REF: "feat/x" } };
}

describe("parsePairs", () => {
  it("reads pairs a line or comma-separated, skipping blanks, comments and repeats", () => {
    expect(parsePairs(`\n# checkout\n${DANA}:${CAKE}\n${SAM} : ${CAKE}, ${DANA}:${CAKE}\n`)).toEqual([
      { personaId: DANA, goalId: CAKE },
      { personaId: SAM, goalId: CAKE },
    ]);
    expect(parsePairs("")).toEqual([]);
  });

  it("refuses what isn't a pair of ids, and more than five pairs", () => {
    expect(() => parsePairs("Dana:cake")).toThrow(/persona-id>:<goal-id/);
    expect(() => parsePairs(`${DANA}`)).toThrow();
    expect(() => parsePairs(`${DANA}:${CAKE}:${SAM}`)).toThrow();
    const six = Array.from({ length: 6 }, (_, n) => `${DANA.slice(0, -1)}${n}:${CAKE}`).join("\n");
    expect(() => parsePairs(six)).toThrow(/at most 5/);
  });
});

describe("runFailures", () => {
  it("fails run-failed only when production reached the goal or has no run", () => {
    const rules = parseFailOn("run-failed");
    expect(runFailures("Dana", previewRun(), rules)).toEqual([
      "Dana didn't reach the goal on the preview, though it does on production.",
    ]);
    const neverWorked = previewRun({ production: { ...figures("gave_up", 30), url: RUN_URL } });
    expect(runFailures("Dana", neverWorked, rules)).toEqual([]);
    expect(runFailures("Dana", previewRun({ production: null }), rules)).toHaveLength(1);
    expect(runFailures("Dana", previewRun({ status: "failed", run: null }), rules)).toEqual([
      "Dana failed to run on the preview.",
    ]);
    expect(runFailures("Dana", previewRun({ run: figures("completed", 80) }), rules)).toEqual([]);
  });

  it("fails run-score-drop on a big enough drop, never on one that can't be compared", () => {
    const rules = parseFailOn("run-score-drop:10");
    expect(runFailures("Dana", previewRun(), rules)).toEqual([
      "Dana scored 42 lower on the preview, 40 against production's 82.",
    ]);
    expect(runFailures("Dana", previewRun({ scoreChange: -9 }), rules)).toEqual([]);
    expect(runFailures("Dana", previewRun({ scoreChange: null }), rules)).toEqual([]);
  });
});

describe("run with personas", () => {
  it("runs each pair on the preview beside its audit, and reports them under it", async () => {
    const { runner, outputs, summaries } = fakeRunner({
      "api-key": KEY,
      "preview-url": PREVIEW,
      "pull-request": "12",
      personas: `${DANA}:${CAKE}`,
      "fail-on": "run-failed",
    });
    const api = fakeApi([{ status: "running", run: null, scoreChange: null }, {}]);
    const code = await run({ runner, fetch: api.impl, ...fakeClock() });
    expect(code).toBe(1);
    expect(api.calls).toContainEqual({
      call: "POST /api/v1/preview-runs",
      body: { url: PREVIEW, persona_id: DANA, goal_id: CAKE, ref: "feat/x", pull_request: 12 },
    });
    const markdown = summaries[0] ?? "";
    expect(markdown).toContain("PersonaMark preview audit of #12 · feat/x");
    expect(markdown).toContain("## Persona runs on the preview");
    expect(markdown).toContain(
      `| Dana | Order a birthday cake for Saturday. | Gave up | 40 | −42 | 1 blocking | [82, completed](${RUN_URL}) |`,
    );
    expect(markdown).toContain(`> Dana at "Order a birthday cake for Saturday." didn't reach the goal on the preview`);
    expect(JSON.parse(outputs.runs ?? "[]")).toEqual([
      { personaId: DANA, goalId: CAKE, previewRunId: "r1", status: "succeeded", outcome: "gave_up", score: 40, scoreChange: -42 },
    ]);
    // The preview audit's own outputs are still there.
    expect(outputs).toMatchObject({ "preview-id": "p1", score: "90" });
  });

  it("passes when the runs only report", async () => {
    const { runner } = fakeRunner({ "api-key": KEY, "preview-url": PREVIEW, personas: `${DANA}:${CAKE}` });
    expect(await run({ runner, fetch: fakeApi([{}]).impl, ...fakeClock() })).toBe(0);
  });

  it("warns about a run that didn't finish in time, and still reports the audit", async () => {
    const { runner, logs, summaries } = fakeRunner({
      "api-key": KEY,
      "preview-url": PREVIEW,
      personas: `${DANA}:${CAKE}`,
      "timeout-minutes": "1",
    });
    const api = fakeApi([{ status: "running", run: null, scoreChange: null }]);
    expect(await run({ runner, fetch: api.impl, ...fakeClock() })).toBe(0);
    expect(logs.some((line) => line.startsWith("warning The persona run of Dana") && line.includes("1 minutes"))).toBe(true);
    expect(summaries[0]).toContain("| Still going |");
    expect(summaries[0]).toContain("Score **90**");
  });

  it("fails with PersonaMark's reason when a pair can't run on the preview", async () => {
    const { runner, logs } = fakeRunner({ "api-key": KEY, "preview-url": PREVIEW, personas: `${DANA}:${CAKE}` });
    const api = fakeApi([], () =>
      json({ error: "That goal signs in with a test account, and this site doesn't allow logins on previews." }, 422),
    );
    expect(await run({ runner, fetch: api.impl, ...fakeClock() })).toBe(1);
    expect(logs.at(-1)).toBe(
      "error Could not start the persona run 3f2b8c1e at 8b0f3c2e: That goal signs in with a test account, and this site doesn't allow logins on previews.",
    );
  });

  it("waits on the same pair's run already going on the preview", async () => {
    const { runner, logs } = fakeRunner({ "api-key": KEY, "preview-url": PREVIEW, personas: `${DANA}:${CAKE}` });
    const api = fakeApi([{}], () => json({ error: "Already running.", previewRunId: "r1", jobId: "j2" }, 409));
    expect(await run({ runner, fetch: api.impl, ...fakeClock() })).toBe(0);
    expect(logs).toContain("info The persona run 3f2b8c1e at 8b0f3c2e was already going on this preview; waiting on it (r1).");
  });

  it("needs a preview for personas, and pairs it can read", async () => {
    const without = fakeRunner({ "api-key": KEY, personas: `${DANA}:${CAKE}` });
    expect(await run({ runner: without.runner })).toBe(1);
    expect(without.logs).toEqual(["error personas runs on a preview, so it needs preview-url."]);
    const odd = fakeRunner({ "api-key": KEY, "preview-url": PREVIEW, personas: "Dana:cake" });
    expect(await run({ runner: odd.runner })).toBe(1);
  });
});
