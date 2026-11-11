import { describe, expect, it } from "vitest";

import type { Runner } from "./actions.ts";
import type { Comparison, Job } from "./api.ts";
import { failures, parseFailOn } from "./policy.ts";
import { POLL_MS, run } from "./run.ts";
import { summarize } from "./summary.ts";

const KEY = `pm_${"A".repeat(43)}`;
const AUDIT_URL = "https://work.personamark.app/organizations/o/sites/s/audits/a1";

const comparison = (overrides: Partial<Comparison> = {}): Comparison => ({
  audit: { id: "a1", createdAt: "2026-11-11T00:00:00Z", score: 84, partial: false, capped: false, url: AUDIT_URL },
  comparedWith: { id: "a0", createdAt: "2026-11-04T00:00:00Z" },
  score: { now: 84, before: 90, change: -6 },
  areas: [
    { area: "on_page", label: "On-page", now: 70, before: 75, change: -5 },
    { area: "performance", label: "Performance", now: null, before: null, change: null },
  ],
  counts: { new: 1, regressed: 0, recurring: 3, fixed: 1, newHigh: 1 },
  changedChecks: [],
  new: [{ check: "title-missing", title: "Pages have no title", severity: "high", pages: 1, urls: ["https://example.com/"] }],
  regressed: [],
  fixed: [{ check: "h1-missing", title: "Pages have no H1", severity: "low", pages: 1, urls: ["https://example.com/about"] }],
  ...overrides,
});

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

/** A fake PersonaMark: the start answer, then each job read in turn, then the comparison. */
function fakeApi(start: Response, jobs: Partial<Job>[], compare: Comparison = comparison()) {
  const calls: string[] = [];
  let read = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.startsWith("/api/v1/")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    }
    if (path === "/api/v1/audits") return start;
    if (path.startsWith("/api/v1/jobs/")) {
      const job = jobs[Math.min(read++, jobs.length - 1)];
      return json({ id: "job1", stage: null, stalled: false, error: null, auditId: null, auditUrl: null, ...job });
    }
    if (path.endsWith("/compare")) return json(compare);
    return json({ error: "nope" }, 404);
  }) as typeof fetch;
  return { impl, calls };
}

/** A clock that moves on by a poll each time the action sleeps, outside any GitHub run. */
function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async (ms: number) => void (time += ms), env: {} };
}

describe("run", () => {
  it("starts an audit, waits for it, and reports the comparison", async () => {
    const { runner, outputs, logs, summaries } = fakeRunner({ "api-key": KEY, "fail-on": "none" });
    const api = fakeApi(json({ jobId: "job1" }, 202), [
      { status: "queued" },
      { status: "running", stage: "crawling" },
      { status: "succeeded", auditId: "a1" },
    ]);
    const code = await run({ runner, fetch: api.impl, ...fakeClock() });
    expect(code).toBe(0);
    expect(api.calls).toEqual([
      "POST /api/v1/audits",
      "GET /api/v1/jobs/job1",
      "GET /api/v1/jobs/job1",
      "GET /api/v1/jobs/job1",
      "GET /api/v1/audits/a1/compare",
    ]);
    expect(outputs).toEqual({
      "job-id": "job1",
      "audit-id": "a1",
      "audit-url": AUDIT_URL,
      score: "84",
      "score-change": "-6",
      "new-high": "1",
    });
    expect(logs).toContain("info Audit running: crawling");
    expect(summaries[0]).toContain("Score **84** (−6 since Nov 4, 2026).");
  });

  it("comments the summary, and only warns when GitHub refuses", async () => {
    const { runner, logs } = fakeRunner({ "api-key": KEY, "github-token": "ghs_x" });
    const api = fakeApi(json({ jobId: "job1" }, 202), [{ status: "succeeded", auditId: "a1" }]);
    const env = { GITHUB_REPOSITORY: "acme/site", GITHUB_SHA: "abc123", GITHUB_API_URL: "https://api.github.com" };
    const code = await run({ runner, fetch: api.impl, ...fakeClock(), env });
    expect(code).toBe(0);
    expect(api.calls).toContain("GET /repos/acme/site/commits/abc123/pulls");
    expect(logs.some((line) => line.startsWith("warning Couldn't comment") && line.includes("pull-requests: write"))).toBe(true);
  });

  it("doesn't comment when told not to", async () => {
    const { runner, logs } = fakeRunner({ "api-key": KEY, "github-token": "ghs_x", comment: "false" });
    const api = fakeApi(json({ jobId: "job1" }, 202), [{ status: "succeeded", auditId: "a1" }]);
    const env = { GITHUB_REPOSITORY: "acme/site", GITHUB_SHA: "abc123" };
    expect(await run({ runner, fetch: api.impl, ...fakeClock(), env })).toBe(0);
    expect(api.calls.some((call) => call.includes("/repos/"))).toBe(false);
    expect(logs.some((line) => line.startsWith("warning"))).toBe(false);
  });

  it("waits on the audit already going instead of failing", async () => {
    const { runner, logs } = fakeRunner({ "api-key": KEY });
    const api = fakeApi(json({ error: "An audit is already running.", jobId: "job1" }, 409), [
      { status: "succeeded", auditId: "a1" },
    ]);
    expect(await run({ runner, fetch: api.impl, ...fakeClock() })).toBe(0);
    expect(logs[0]).toBe("info An audit was already going; waiting on it (job1).");
  });

  it("fails on a new high issue or a big enough drop when asked to", async () => {
    const { runner, logs } = fakeRunner({ "api-key": KEY, "fail-on": "new-high, score-drop:5" });
    const api = fakeApi(json({ jobId: "job1" }, 202), [{ status: "succeeded", auditId: "a1" }]);
    expect(await run({ runner, fetch: api.impl, ...fakeClock() })).toBe(1);
    expect(logs).toContain("error 1 issue of high severity is new or back.");
    expect(logs).toContain("error The score fell by 6, from 90 to 84.");
  });

  it("gives up waiting at the timeout, passing unless asked to fail", async () => {
    const queued = () => fakeApi(json({ jobId: "job1" }, 202), [{ status: "queued", stalled: true }]);

    const relaxed = fakeRunner({ "api-key": KEY, "timeout-minutes": "1" });
    const clock = fakeClock();
    expect(await run({ runner: relaxed.runner, fetch: queued().impl, ...clock })).toBe(0);
    expect(clock.now()).toBe(Math.ceil(60_000 / POLL_MS) * POLL_MS);
    expect(relaxed.logs.at(-1)).toMatch(/^warning The audit didn't finish within 1 minutes and is still queued/);

    const strict = fakeRunner({ "api-key": KEY, "timeout-minutes": "1", "fail-on": "new-high" });
    expect(await run({ runner: strict.runner, fetch: queued().impl, ...fakeClock() })).toBe(1);
  });

  it("only starts the audit when told not to wait", async () => {
    const { runner, outputs } = fakeRunner({ "api-key": KEY, wait: "false" });
    const api = fakeApi(json({ jobId: "job1" }, 202), []);
    expect(await run({ runner, fetch: api.impl, ...fakeClock() })).toBe(0);
    expect(api.calls).toEqual(["POST /api/v1/audits"]);
    expect(outputs).toEqual({ "job-id": "job1" });
  });

  it("fails with PersonaMark's reason when the key is refused", async () => {
    const { runner, logs } = fakeRunner({ "api-key": KEY });
    const api = fakeApi(json({ error: "Send a live API key." }, 401), []);
    expect(await run({ runner, fetch: api.impl, ...fakeClock() })).toBe(1);
    expect(logs).toEqual(["error Could not start an audit: Send a live API key."]);
  });

  it("refuses an empty key and a fail-on it doesn't understand", async () => {
    expect(await run({ runner: fakeRunner({}).runner })).toBe(1);
    const odd = fakeRunner({ "api-key": KEY, "fail-on": "score-drop" });
    expect(await run({ runner: odd.runner })).toBe(1);
  });
});

describe("parseFailOn and failures", () => {
  it("reads the rules and fails only on what they name", () => {
    expect(parseFailOn("none")).toEqual({ newHigh: false, scoreDrop: null });
    expect(parseFailOn(" New-High ,score-drop:3")).toEqual({ newHigh: true, scoreDrop: 3 });
    expect(() => parseFailOn("score-drop:0")).toThrow();
    expect(failures(comparison(), parseFailOn("score-drop:7"))).toEqual([]);
    // A change that can't be compared never fails a drop rule.
    const rescored = comparison({ score: { now: 50, before: 90, change: null } });
    expect(failures(rescored, parseFailOn("score-drop:1"))).toEqual([]);
  });
});

describe("summarize", () => {
  it("leads with the score, then areas, then what's new and fixed", () => {
    const markdown = summarize(comparison(), []);
    expect(markdown).toContain("1 new, 0 back, 1 fixed, 3 still there.");
    expect(markdown).toContain("| On-page | 70 | −5 |");
    expect(markdown).not.toContain("Performance");
    expect(markdown).toContain("| Pages have no title | high | 1 | https://example.com/ |");
    expect(markdown).toContain("### Fixed");
    expect(markdown).toContain(`[Open the audit in PersonaMark](${AUDIT_URL})`);
  });

  it("says when there's nothing to compare with", () => {
    expect(summarize(comparison({ comparedWith: null }), [])).toContain("the site's first complete audit");
    expect(
      summarize(comparison({ score: { now: 84, before: 90, change: null } }), []),
    ).toContain("scored by different rules");
  });
});
