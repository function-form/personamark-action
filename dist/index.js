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
  async #request(method, path, data) {
    const response = await this.fetchImpl(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        accept: "application/json",
        ...data === void 0 ? {} : { "content-type": "application/json" }
      },
      ...data === void 0 ? {} : { body: JSON.stringify(data) }
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
  /** Starts a preview audit, or joins the one of the same preview already going. */
  async startPreview(request) {
    try {
      const { previewId } = await this.#request("POST", "/previews", request);
      return { previewId, joined: false };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && typeof error.body.previewId === "string") {
        return { previewId: error.body.previewId, joined: true };
      }
      throw error;
    }
  }
  preview(previewId) {
    return this.#request("GET", `/previews/${encodeURIComponent(previewId)}`);
  }
  comparePreview(previewId) {
    return this.#request("GET", `/previews/${encodeURIComponent(previewId)}/compare`);
  }
};

// src/comment.ts
var MARKER = "<!-- personamark-audit -->";
var GitHubError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
async function postComment(target, markdown, fetchImpl = fetch) {
  const base = `${target.apiUrl.replace(/\/+$/, "")}/repos/${target.repository}`;
  const call = async (method, path, body2) => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...body2 ? { "content-type": "application/json" } : {}
      },
      ...body2 ? { body: JSON.stringify(body2) } : {}
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new GitHubError(response.status, detail.message ?? `HTTP ${response.status}`);
    }
    return await response.json();
  };
  const body = `${MARKER}
${markdown}`;
  const pulls = await call("GET", `/commits/${target.sha}/pulls`);
  const pull = pulls[0];
  if (pull) {
    const comments = await call(
      "GET",
      `/issues/${pull.number}/comments?per_page=100`
    );
    const ours = comments.findLast((comment2) => comment2.body?.startsWith(MARKER));
    const saved2 = ours ? await call("PATCH", `/issues/comments/${ours.id}`, { body }) : await call("POST", `/issues/${pull.number}/comments`, { body });
    return { on: "pull", number: pull.number, url: saved2.html_url };
  }
  const saved = await call("POST", `/commits/${target.sha}/comments`, { body });
  return { on: "commit", url: saved.html_url };
}

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
function auditHeadline({ score, comparedWith }) {
  if (!comparedWith) return `Score **${score.now}**. This is the site's first complete audit.`;
  if (score.change === null) {
    return `Score **${score.now}**. The audit of ${date(comparedWith.createdAt)} was scored by different rules, so the two don't compare.`;
  }
  return `Score **${score.now}** (${signed(score.change)} since ${date(comparedWith.createdAt)}).`;
}
function previewHeadline({ score, comparedWith }) {
  if (!comparedWith || score.before === null) {
    return `Score **${score.now}**. There's no complete production audit to compare with yet.`;
  }
  if (score.change === null) {
    return `Score **${score.now}**, against production's ${score.before}. The two were scored by different rules, so they don't compare.`;
  }
  return `Score **${score.now}**, ${signed(score.change)} against production's ${score.before} (the audit of ${date(comparedWith.createdAt)}). Both leave out PageSpeed, which can't reach a preview.`;
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
function render(comparison, failed, view) {
  const { counts } = comparison;
  const areas = comparison.areas.filter((row) => row.now !== null || row.before !== null);
  const lines = [
    `## ${view.title}`,
    ``,
    view.partial ? `Score **${comparison.score.now}**, from a partial audit, so it isn't compared.` : view.headline(comparison),
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
      `Some checks changed since the audit compared with, so what they found isn't called new or fixed.`,
      ``
    );
  }
  if (view.link) lines.push(`[${view.link.label}](${view.link.url})`);
  return lines.join("\n");
}
function summarize(comparison, failed) {
  return render(comparison, failed, {
    title: "PersonaMark audit",
    partial: comparison.audit.partial,
    headline: auditHeadline,
    link: { label: "Open the audit in PersonaMark", url: comparison.audit.url }
  });
}
function summarizePreview(comparison, failed) {
  const { preview } = comparison;
  const what = [
    preview.pullRequest === null ? null : `#${preview.pullRequest}`,
    preview.ref,
    preview.sha?.slice(0, 7) ?? null
  ].filter((part) => part !== null);
  return render(comparison, failed, {
    title: `PersonaMark preview audit${what.length > 0 ? ` of ${what.join(" \xB7 ")}` : ""}`,
    partial: preview.partial,
    headline: previewHeadline,
    link: comparison.productionAuditUrl ? { label: "Open the production audit in PersonaMark", url: comparison.productionAuditUrl } : null
  });
}

// src/run.ts
var POLL_MS = 2e4;
var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var FINISHED = ["succeeded", "failed", "cancelled"];
async function comment(runner2, env, markdown, fetchImpl) {
  if ((runner2.input("comment") || "true").toLowerCase() === "false") return;
  const token = runner2.input("github-token");
  const repository = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  if (!token || !repository || !sha) {
    runner2.warning("Not commenting: there's no GitHub token, repository or commit to comment on.");
    return;
  }
  try {
    const posted = await postComment(
      { token, repository, sha, apiUrl: env.GITHUB_API_URL || "https://api.github.com" },
      markdown,
      fetchImpl
    );
    runner2.info(`Commented on ${posted.on === "pull" ? `pull request #${posted.number}` : "the commit"}: ${posted.url}`);
  } catch (error) {
    const denied = error instanceof GitHubError && (error.status === 403 || error.status === 404);
    runner2.warning(
      denied ? `Couldn't comment (${error.message}). Give the job \`pull-requests: write\`, and \`contents: write\` to comment on a commit with no pull request, or set comment: false.` : `Couldn't comment: ${error.message}`
    );
  }
}
async function run({
  runner: runner2,
  fetch: fetchImpl = fetch,
  sleep = wait,
  now = Date.now,
  env = process.env
}) {
  const key = runner2.input("api-key");
  if (!key) {
    runner2.error("api-key is empty. Pass a PersonaMark API key from a secret.");
    return 1;
  }
  const baseUrl = runner2.input("base-url") || "https://work.personamark.app";
  const shouldWait = (runner2.input("wait") || "true").toLowerCase() !== "false";
  const timeoutMinutes = Number(runner2.input("timeout-minutes") || "30");
  const previewUrl = runner2.input("preview-url");
  const pullRequest = runner2.input("pull-request");
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
  if (pullRequest && !/^[1-9]\d{0,9}$/.test(pullRequest)) {
    runner2.error("pull-request must be a pull request's number.");
    return 1;
  }
  const what = previewUrl ? "preview audit" : "audit";
  const unchecked = (message) => {
    if (failsOnSomething(rules)) {
      runner2.error(message);
      return 1;
    }
    runner2.warning(message);
    return 0;
  };
  const api = new PersonaMark(baseUrl, key, fetchImpl);
  let id;
  let poll;
  try {
    if (previewUrl) {
      const ref = runner2.input("ref") || env.GITHUB_HEAD_REF || "";
      const sha = env.GITHUB_SHA ?? "";
      const started = await api.startPreview({
        url: previewUrl,
        ...ref ? { ref } : {},
        .../^[0-9a-f]{7,40}$/.test(sha) ? { sha } : {},
        ...pullRequest ? { pull_request: Number(pullRequest) } : {}
      });
      id = started.previewId;
      poll = () => api.preview(id);
      runner2.output("preview-id", id);
      runner2.info(started.joined ? `This preview was already being audited; waiting on it (${id}).` : `Started a preview audit (${id}).`);
    } else {
      const started = await api.startAudit();
      id = started.jobId;
      poll = () => api.job(id);
      runner2.output("job-id", id);
      runner2.info(started.joined ? `An audit was already going; waiting on it (${id}).` : `Started an audit (${id}).`);
    }
  } catch (error) {
    runner2.error(`Could not start the ${what}: ${error.message}`);
    return 1;
  }
  if (!shouldWait) return 0;
  const deadline = now() + timeoutMinutes * 6e4;
  let progress = null;
  let said = "";
  let warnedStalled = false;
  while (now() < deadline) {
    try {
      progress = await poll();
    } catch (error) {
      const status = error.status;
      if (status === 401 || status === 404) {
        runner2.error(`Could not follow the ${what}: ${error.message}`);
        return 1;
      }
      runner2.info(`Could not read the ${what}'s progress (${error.message}); trying again.`);
    }
    if (progress) {
      const line = progress.stage ? `${progress.status}: ${progress.stage}` : progress.status;
      if (line !== said) runner2.info(`${previewUrl ? "Preview audit" : "Audit"} ${line}`);
      said = line;
      if (progress.stalled && !warnedStalled) {
        runner2.info(`The ${what} has been queued for a while; PersonaMark's worker may be busy or off.`);
        warnedStalled = true;
      }
      if (FINISHED.includes(progress.status)) break;
    }
    await sleep(POLL_MS);
  }
  if (!progress || !FINISHED.includes(progress.status)) {
    return unchecked(
      `The ${what} didn't finish within ${timeoutMinutes} minutes${progress?.status === "queued" ? " and is still queued, so PersonaMark's worker may be off" : ""}. It carries on, and its results will be in PersonaMark.`
    );
  }
  if (progress.status !== "succeeded") {
    return unchecked(
      `The ${what} ${progress.status === "cancelled" ? "was cancelled" : `failed: ${progress.error ?? "no reason given"}`}.`
    );
  }
  let comparison;
  let markdown;
  let link;
  const failed = [];
  if (previewUrl) {
    const compared = await api.comparePreview(id);
    failed.push(...failures(compared, rules));
    comparison = compared;
    markdown = summarizePreview(compared, failed);
    link = compared.productionAuditUrl;
  } else {
    const job = progress;
    if (!job.auditId) return unchecked("The audit finished without saving one.");
    const compared = await api.compare(job.auditId);
    failed.push(...failures(compared, rules));
    comparison = compared;
    markdown = summarize(compared, failed);
    link = compared.audit.url;
    runner2.output("audit-id", compared.audit.id);
  }
  if (link) runner2.output("audit-url", link);
  runner2.output("score", String(comparison.score.now));
  runner2.output("score-change", comparison.score.change === null ? "" : String(comparison.score.change));
  runner2.output("new-high", String(comparison.counts.newHigh));
  runner2.summary(markdown);
  await comment(runner2, env, markdown, fetchImpl);
  runner2.info(`Score ${comparison.score.now}.${link ? ` ${link}` : ""}`);
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
