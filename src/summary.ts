import type { CheckGroup, Comparison } from "./api.ts";

/** Checks listed per table; the rest are counted, and the audit has them all. */
const ROWS = 10;

const date = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(iso),
  );

const signed = (change: number) => (change > 0 ? `+${change}` : change < 0 ? `−${-change}` : "±0");

/** Table cells can't hold a pipe or a line break. PersonaMark's text has neither, but be sure. */
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll(/[\r\n]+/g, " ");

function headline(comparison: Comparison): string {
  const { score, comparedWith, audit } = comparison;
  if (audit.partial) return `Score **${score.now}**, from a partial audit, so it isn't compared.`;
  if (!comparedWith) return `Score **${score.now}**. This is the site's first complete audit.`;
  if (score.change === null) {
    return `Score **${score.now}**. The audit of ${date(comparedWith.createdAt)} was scored by different rules, so the two don't compare.`;
  }
  return `Score **${score.now}** (${signed(score.change)} since ${date(comparedWith.createdAt)}).`;
}

function checkTable(title: string, groups: CheckGroup[], withExample: boolean): string[] {
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
    ``,
  ];
}

/** The job summary for a finished audit. */
export function summarize(comparison: Comparison, failed: string[]): string {
  const { counts } = comparison;
  const areas = comparison.areas.filter((row) => row.now !== null || row.before !== null);
  const lines = [
    `## PersonaMark audit`,
    ``,
    headline(comparison),
    ``,
    ...failed.map((reason) => `> [!CAUTION]\n> ${reason}\n`),
    `${counts.new} new, ${counts.regressed} back, ${counts.fixed} fixed, ${counts.recurring} still there.`,
    ``,
  ];
  if (areas.length > 0) {
    lines.push(`| Area | Score | Change |`, `| --- | --- | --- |`);
    for (const row of areas) {
      lines.push(
        `| ${cell(row.label)} | ${row.now ?? "not measured"} | ${row.change === null ? "" : signed(row.change)} |`,
      );
    }
    lines.push(``);
  }
  lines.push(
    ...checkTable("New", comparison.new, true),
    ...checkTable("Back again", comparison.regressed, true),
    ...checkTable("Fixed", comparison.fixed, false),
  );
  if (comparison.changedChecks.length > 0 && comparison.comparedWith) {
    lines.push(
      `Some checks changed since the audit before, so what they found isn't called new or fixed.`,
      ``,
    );
  }
  lines.push(`[Open the audit in PersonaMark](${comparison.audit.url})`);
  return lines.join("\n");
}
