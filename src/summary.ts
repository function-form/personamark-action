import type { CheckGroup, Comparison, ComparisonCore, PreviewComparison } from "./api.ts";

/** Checks listed per table; the rest are counted, and the audit has them all. */
const ROWS = 10;

const date = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(iso),
  );

const signed = (change: number) => (change > 0 ? `+${change}` : change < 0 ? `−${-change}` : "±0");

/** Table cells can't hold a pipe or a line break. PersonaMark's text has neither, but be sure. */
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll(/[\r\n]+/g, " ");

/** What the summary is about, which changes its title, its first line and its link. */
interface View {
  title: string;
  partial: boolean;
  headline: (comparison: ComparisonCore) => string;
  link: { label: string; url: string } | null;
}

function auditHeadline({ score, comparedWith }: ComparisonCore): string {
  if (!comparedWith) return `Score **${score.now}**. This is the site's first complete audit.`;
  if (score.change === null) {
    return `Score **${score.now}**. The audit of ${date(comparedWith.createdAt)} was scored by different rules, so the two don't compare.`;
  }
  return `Score **${score.now}** (${signed(score.change)} since ${date(comparedWith.createdAt)}).`;
}

function previewHeadline({ score, comparedWith }: ComparisonCore): string {
  if (!comparedWith || score.before === null) {
    return `Score **${score.now}**. There's no complete production audit to compare with yet.`;
  }
  if (score.change === null) {
    return `Score **${score.now}**, against production's ${score.before}. The two were scored by different rules, so they don't compare.`;
  }
  return `Score **${score.now}**, ${signed(score.change)} against production's ${score.before} (the audit of ${date(comparedWith.createdAt)}). Both leave out PageSpeed, which can't reach a preview.`;
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

function render(comparison: ComparisonCore, failed: string[], view: View): string {
  const { counts } = comparison;
  const areas = comparison.areas.filter((row) => row.now !== null || row.before !== null);
  const lines = [
    `## ${view.title}`,
    ``,
    view.partial
      ? `Score **${comparison.score.now}**, from a partial audit, so it isn't compared.`
      : view.headline(comparison),
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
      `Some checks changed since the audit compared with, so what they found isn't called new or fixed.`,
      ``,
    );
  }
  if (view.link) lines.push(`[${view.link.label}](${view.link.url})`);
  return lines.join("\n");
}

/** The job summary for a finished audit of the site. */
export function summarize(comparison: Comparison, failed: string[]): string {
  return render(comparison, failed, {
    title: "PersonaMark audit",
    partial: comparison.audit.partial,
    headline: auditHeadline,
    link: { label: "Open the audit in PersonaMark", url: comparison.audit.url },
  });
}

/** The job summary for a finished preview audit, against production. */
export function summarizePreview(comparison: PreviewComparison, failed: string[]): string {
  const { preview } = comparison;
  const what = [
    preview.pullRequest === null ? null : `#${preview.pullRequest}`,
    preview.ref,
    preview.sha?.slice(0, 7) ?? null,
  ].filter((part) => part !== null);
  return render(comparison, failed, {
    title: `PersonaMark preview audit${what.length > 0 ? ` of ${what.join(" · ")}` : ""}`,
    partial: preview.partial,
    headline: previewHeadline,
    link: comparison.productionAuditUrl
      ? { label: "Open the production audit in PersonaMark", url: comparison.productionAuditUrl }
      : null,
  });
}
