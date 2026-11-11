// src/actions.ts
import { appendFileSync } from "node:fs";
import { EOL } from "node:os";
var escapeData = (text) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
function processRunner(env = process.env) {
  return {
    input: (name) => (env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`] ?? "").trim(),
    output(name, value) {
      const file = env.GITHUB_OUTPUT;
      if (!file) return;
      const delimiter = `pm_${crypto.randomUUID()}`;
      appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
    },
    summary(markdown) {
      const file = env.GITHUB_STEP_SUMMARY;
      if (file) appendFileSync(file, `${markdown}${EOL}`);
    },
    info: (message) => {
      console.log(message);
    },
    warning: (message) => {
      console.log(`::warning::${escapeData(message)}`);
    },
    error: (message) => {
      console.log(`::error::${escapeData(message)}`);
    }
  };
}

// src/api.ts
var ApiError = class extends Error {
  constructor(status, message, body = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
  status;
  body;
};
var PersonaMark = class {
  constructor(baseUrl, key, fetchImpl = fetch) {
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.#base = `${baseUrl.replace(/\/+$/, "")}/api/v1`;
  }
  key;
  fetchImpl;
  #base;
  async #request(method, path) {
    const response = await this.fetchImpl(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json" }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new ApiError(response.status, message, body);
    }
    return body;
  }
  /** Starts an audit, or joins the one already going. */
  async startAudit() {
    try {
      const { jobId } = await this.#request("POST", "/audits");
      return { jobId, joined: false };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && typeof error.body.jobId === "string") {
        return { jobId: error.body.jobId, joined: true };
      }
      throw error;
    }
  }
  job(jobId) {
    return this.#request("GET", `/jobs/${encodeURIComponent(jobId)}`);
  }
  compare(auditId) {
    return this.#request("GET", `/audits/${encodeURIComponent(auditId)}/compare`);
  }
};

// src/policy.ts
var NEVER = { newHigh: false, scoreDrop: null };
function parseFailOn(text) {
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
      `fail-on doesn't understand "${part}". Use none, new-high or score-drop:<n>, comma-separated.`
    );
  }
  return rules;
}
var failsOnSomething = (rules) => rules.newHigh || rules.scoreDrop !== null;
function failures(comparison, rules) {
  const reasons = [];
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

// src/summary.ts
var ROWS = 10;
var date = (iso) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
  new Date(iso)
);
var signed = (change) => change > 0 ? `+${change}` : change < 0 ? `\u2212${-change}` : "\xB10";
var cell = (text) => text.replaceAll("|", "\\|").replaceAll(/[\r\n]+/g, " ");
function headline(comparison) {
  const { score, comparedWith, audit } = comparison;
  if (audit.partial) return `Score **${score.now}**, from a partial audit, so it isn't compared.`;
  if (!comparedWith) return `Score **${score.now}**. This is the site's first complete audit.`;
  if (score.change === null) {
    return `Score **${score.now}**. The audit of ${date(comparedWith.createdAt)} was scored by different rules, so the two don't compare.`;
  }
  return `Score **${score.now}** (${signed(score.change)} since ${date(comparedWith.createdAt)}).`;
}
function checkTable(title, groups, withExample) {
  if (groups.length === 0) return [];
  const rows = groups.slice(0, ROWS).map((group) => {
    const example = withExample && group.urls[0] ? ` | ${cell(group.urls[0])}` : withExample ? " | " : "";
    return `| ${cell(group.title)} | ${group.severity} | ${group.pages}${example} |`;
  });
  const more = groups.length > ROWS ? [``, `And ${groups.length - ROWS} more checks.`] : [];
  return [
    `### ${title}`,
    ``,
    withExample ? `| Check | Severity | Pages | For example |` : `| Check | Severity | Pages |`,
    withExample ? `| --- | --- | --- | --- |` : `| --- | --- | --- |`,
    ...rows,
    ...more,
    ``
  ];
}
function summarize(comparison, failed) {
  const { counts } = comparison;
  const areas = comparison.areas.filter((row) => row.now !== null || row.before !== null);
  const lines = [
    `## PersonaMark audit`,
    ``,
    headline(comparison),
    ``,
    ...failed.map((reason) => `> [!CAUTION]
> ${reason}
`),
    `${counts.new} new, ${counts.regressed} back, ${counts.fixed} fixed, ${counts.recurring} still there.`,
    ``
  ];
  if (areas.length > 0) {
    lines.push(`| Area | Score | Change |`, `| --- | --- | --- |`);
    for (const row of areas) {
      lines.push(
        `| ${cell(row.label)} | ${row.now ?? "not measured"} | ${row.change === null ? "" : signed(row.change)} |`
      );
    }
    lines.push(``);
  }
  lines.push(
    ...checkTable("New", comparison.new, true),
    ...checkTable("Back again", comparison.regressed, true),
    ...checkTable("Fixed", comparison.fixed, false)
  );
  if (comparison.changedChecks.length > 0 && comparison.comparedWith) {
    lines.push(
      `Some checks changed since the audit before, so what they found isn't called new or fixed.`,
      ``
    );
  }
  lines.push(`[Open the audit in PersonaMark](${comparison.audit.url})`);
  return lines.join("\n");
}

// src/run.ts
var POLL_MS = 2e4;
var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function run({ runner: runner2, fetch: fetchImpl = fetch, sleep = wait, now = Date.now }) {
  const key = runner2.input("api-key");
  if (!key) {
    runner2.error("api-key is empty. Pass a PersonaMark API key from a secret.");
    return 1;
  }
  const baseUrl = runner2.input("base-url") || "https://work.personamark.app";
  const shouldWait = (runner2.input("wait") || "true").toLowerCase() !== "false";
  const timeoutMinutes = Number(runner2.input("timeout-minutes") || "30");
  let rules;
  try {
    rules = parseFailOn(runner2.input("fail-on") || "none");
  } catch (error) {
    runner2.error(error.message);
    return 1;
  }
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    runner2.error("timeout-minutes must be a positive number.");
    return 1;
  }
  const unchecked = (message) => {
    if (failsOnSomething(rules)) {
      runner2.error(message);
      return 1;
    }
    runner2.warning(message);
    return 0;
  };
  const api = new PersonaMark(baseUrl, key, fetchImpl);
  let jobId;
  try {
    const started = await api.startAudit();
    jobId = started.jobId;
    runner2.info(started.joined ? `An audit was already going; waiting on it (${jobId}).` : `Started an audit (${jobId}).`);
  } catch (error) {
    runner2.error(`Could not start an audit: ${error.message}`);
    return 1;
  }
  runner2.output("job-id", jobId);
  if (!shouldWait) return 0;
  const deadline = now() + timeoutMinutes * 6e4;
  let job = null;
  let said = "";
  let warnedStalled = false;
  while (now() < deadline) {
    try {
      job = await api.job(jobId);
    } catch (error) {
      const status = error.status;
      if (status === 401 || status === 404) {
        runner2.error(`Could not follow the audit: ${error.message}`);
        return 1;
      }
      runner2.info(`Could not read the audit's progress (${error.message}); trying again.`);
    }
    if (job) {
      const progress = job.stage ? `${job.status}: ${job.stage}` : job.status;
      if (progress !== said) runner2.info(`Audit ${progress}`);
      said = progress;
      if (job.stalled && !warnedStalled) {
        runner2.info("The audit has been queued for a while; PersonaMark's worker may be busy or off.");
        warnedStalled = true;
      }
      if (["succeeded", "failed", "cancelled"].includes(job.status)) break;
    }
    await sleep(POLL_MS);
  }
  if (!job || !["succeeded", "failed", "cancelled"].includes(job.status)) {
    return unchecked(
      `The audit didn't finish within ${timeoutMinutes} minutes${job?.status === "queued" ? " and is still queued, so PersonaMark's worker may be off" : ""}. It carries on, and its results will be in PersonaMark.`
    );
  }
  if (job.status !== "succeeded" || !job.auditId) {
    return unchecked(`The audit ${job.status === "cancelled" ? "was cancelled" : `failed: ${job.error ?? "no reason given"}`}.`);
  }
  const comparison = await api.compare(job.auditId);
  const failed = failures(comparison, rules);
  runner2.output("audit-id", comparison.audit.id);
  runner2.output("audit-url", comparison.audit.url);
  runner2.output("score", String(comparison.score.now));
  runner2.output("score-change", comparison.score.change === null ? "" : String(comparison.score.change));
  runner2.output("new-high", String(comparison.counts.newHigh));
  runner2.summary(summarize(comparison, failed));
  runner2.info(`Score ${comparison.score.now}. ${comparison.audit.url}`);
  for (const reason of failed) runner2.error(reason);
  return failed.length > 0 ? 1 : 0;
}

// src/index.ts
var runner = processRunner();
try {
  process.exitCode = await run({ runner });
} catch (error) {
  runner.error(`PersonaMark audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
