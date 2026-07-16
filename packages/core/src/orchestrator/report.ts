import type { Project, Run } from '../storage/types.js';
import type { ExecOutcome, TestPlan } from '../modes/types.js';
import type { TriageResult } from '../triage/types.js';
import type { FunctionalityUnit } from '../target/functionality-index.js';

/** One triaged failure, attached to the report. */
export interface ReportTriageEntry {
  title: string;
  error: string;
  triage: TriageResult;
}

/**
 * Serializable snapshot of the coverage-feedback loop's final state (see
 * orchestrator/coverage.ts's CoverageResult) — a plain object instead of a
 * Set, so it survives JSON.stringify/report.json round-tripping intact.
 */
export interface ReportCoverageSummary {
  ratio: number;
  coveredCount: number;
  totalCount: number;
  uncovered: FunctionalityUnit[];
}

/** Serializable run report written to reports/report.json. */
export interface RunReport {
  run: Run;
  project: Project;
  plan: TestPlan;
  outcome: ExecOutcome | null;
  triage: ReportTriageEntry[];
  /** Artifact files collected from the mode after execution (relative paths). */
  artifacts: string[];
  /** Functionality-unit coverage reached by the coverage-feedback loop; null when it didn't run (e.g. reuse mode, or no functionality inventory). */
  coverage: ReportCoverageSummary | null;
  generatedAt: string;
}

export function buildReport(input: {
  run: Run;
  project: Project;
  plan: TestPlan;
  outcome: ExecOutcome | null;
  triage: ReportTriageEntry[];
  artifacts?: string[];
  coverage?: ReportCoverageSummary | null;
}): RunReport {
  return {
    run: input.run,
    project: input.project,
    plan: input.plan,
    outcome: input.outcome,
    triage: input.triage,
    artifacts: input.artifacts ?? [],
    coverage: input.coverage ?? null,
    generatedAt: new Date().toISOString(),
  };
}

/** Last path segment, for display only — avoids printing a full local filesystem path into the report. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

const VERDICT_LABEL: Record<TriageResult['verdict'], string> = {
  app_is_wrong: 'App defect',
  test_is_wrong: 'Test defect',
  environment: 'Environment',
  flaky: 'Flaky',
  ambiguous: 'Ambiguous',
};

/**
 * Split a raw Playwright error blob into a one-line summary (for the row
 * itself) and the remaining call log / stack trace (tucked behind a
 * <details> toggle) — a full multi-paragraph dump inline made the Results
 * table unreadable at a glance.
 */
function splitErrorText(raw: string): { summary: string; rest: string } {
  const lines = raw.split('\n');
  const summary = (lines[0] ?? '').trim() || raw.trim();
  const rest = lines.slice(1).join('\n').trim();
  return { summary, rest };
}

function renderErrorCell(error: string | undefined, triage: ReportTriageEntry | undefined): string {
  if (!error) return '';
  const { summary, rest } = splitErrorText(error);
  const detailsBlock = rest
    ? `<details><summary>Full details</summary><pre>${esc(rest)}</pre></details>`
    : '';
  const triageBlock = triage
    ? `<div class="diagnosis"><span class="tag verdict-${esc(triage.triage.verdict)}">${esc(
        VERDICT_LABEL[triage.triage.verdict] ?? triage.triage.verdict,
      )}</span> <span class="hist">${esc((triage.triage.confidence * 100).toFixed(0))}% confidence</span>
      <div>${esc(triage.triage.rationale)}</div>
      ${
        triage.triage.suggestedPatch
          ? `<div><strong>Suggested fix:</strong> <code>${esc(triage.triage.suggestedPatch)}</code></div>`
          : ''
      }
    </div>`
    : '';
  return `<div class="err-summary">${esc(summary)}</div>${triageBlock}${detailsBlock}`;
}

/** Render a self-contained, dependency-free HTML report. */
export function renderReportHtml(report: RunReport): string {
  const { run, project, plan, outcome, triage, coverage } = report;
  const total = outcome ? outcome.results.length : 0;
  const passed = outcome?.passed ?? 0;
  const failed = outcome?.failed ?? 0;
  const blocked = outcome?.blocked ?? 0;
  const flaky = outcome?.flaky ?? 0;

  const planRows = plan.items
    .map((it) => {
      const rejected = it.status === 'rejected';
      const statusBadge =
        it.status && it.status !== 'approved' ? ` <span class="tag">${esc(it.status)}</span>` : '';
      const editCount = it.edits?.length ?? 0;
      const revisionCount = it.revisions?.length ?? 0;
      const historyNote =
        editCount > 0 || revisionCount > 0
          ? `<div class="hist">${editCount} edit(s), ${revisionCount} revision(s)</div>`
          : '';
      return `<tr class="${rejected ? 'rejected' : ''}"><td>${esc(it.title)}${statusBadge}</td><td>${esc(
        it.tier,
      )}</td><td>${esc(it.reqTag ?? '')}</td><td>${esc(it.intent)}${historyNote}</td></tr>`;
    })
    .join('');

  // Triage is keyed by title so a failed row can show its verdict/rationale
  // inline instead of forcing readers to cross-reference a separate table.
  const triageByTitle = new Map<string, ReportTriageEntry>(triage.map((t) => [t.title, t]));

  const resultRows = (outcome?.results ?? [])
    .map((r) => {
      const artifactNote =
        r.artifacts && r.artifacts.length > 0
          ? `<div class="hist">${r.artifacts.map((a) => esc(baseName(a))).join(', ')}</div>`
          : '';
      return `<tr class="status-${esc(r.status)}"><td>${esc(r.title)}</td><td>${esc(r.status)}</td><td>${
        r.durationMs != null ? esc(String(r.durationMs)) + ' ms' : ''
      }</td><td>${renderErrorCell(r.error, triageByTitle.get(r.title))}${artifactNote}</td></tr>`;
    })
    .join('');

  const triageRows = triage
    .map(
      (t) =>
        `<tr><td>${esc(t.title)}</td><td>${esc(t.triage.verdict)}</td><td>${esc(
          (t.triage.confidence * 100).toFixed(0),
        )}%</td><td>${esc(t.triage.rationale)}${
          t.triage.suggestedPatch
            ? `<div class="hist"><strong>Suggested fix:</strong> <code>${esc(t.triage.suggestedPatch)}</code></div>`
            : ''
        }</td></tr>`,
    )
    .join('');

  const coverageSection =
    coverage != null
      ? `<section>
    <h2>Coverage</h2>
    <p>${coverage.coveredCount}/${coverage.totalCount} functionality unit(s) covered (${Math.round(
      coverage.ratio * 100,
    )}%).</p>
    ${
      coverage.uncovered.length > 0
        ? `<table>
      <thead><tr><th>Uncovered unit</th><th>Kind</th><th>File</th></tr></thead>
      <tbody>${coverage.uncovered
        .map((u) => `<tr><td>${esc(u.label)}</td><td>${esc(u.kind)}</td><td>${esc(u.file)}</td></tr>`)
        .join('')}</tbody>
    </table>`
        : ''
    }
  </section>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Healix Report — ${esc(project.name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 2rem; }
  h1 { margin: 0 0 .25rem; }
  .sub { color: #888; margin-bottom: 1.5rem; }
  .cards { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 2rem; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: .75rem 1rem; min-width: 90px; }
  .card .n { font-size: 1.6rem; font-weight: 700; }
  .pass { color: #1a7f37; } .fail { color: #cf222e; } .warn { color: #9a6700; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8883; vertical-align: top; }
  th { font-weight: 600; }
  tr.status-failed td { background: #cf222e14; }
  tr.status-passed td:nth-child(2) { color: #1a7f37; }
  tr.rejected td { opacity: .55; text-decoration: line-through; }
  .tag { display: inline-block; font-size: .7rem; text-transform: uppercase; letter-spacing: .02em;
    padding: 0 .35rem; border-radius: 4px; background: #8884; text-decoration: none; }
  .hist { font-size: .75rem; color: #888; margin-top: .15rem; text-decoration: none; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: .75rem; margin: .35rem 0 0; }
  section { margin-bottom: 1rem; }
  .err-summary { font-weight: 600; }
  .diagnosis { margin-top: .35rem; font-size: .8rem; }
  .diagnosis .hist { display: inline; }
  .verdict-app_is_wrong { background: #cf222e30; }
  .verdict-test_is_wrong { background: #9a670030; }
  .verdict-environment { background: #9a670030; }
  .verdict-flaky { background: #9a670030; }
  .verdict-ambiguous { background: #88848430; }
  details summary { cursor: pointer; font-size: .75rem; color: #888; }
</style>
</head>
<body>
  <h1>Healix Test Report</h1>
  <div class="sub">${esc(project.name)} &middot; run <code>${esc(run.id)}</code> &middot; status <strong>${esc(
    run.status,
  )}</strong></div>

  <div class="cards">
    <div class="card"><div class="n">${total}</div><div>total</div></div>
    <div class="card"><div class="n pass">${passed}</div><div>passed</div></div>
    <div class="card"><div class="n fail">${failed}</div><div>failed</div></div>
    <div class="card"><div class="n warn">${blocked}</div><div>blocked</div></div>
    <div class="card"><div class="n warn">${flaky}</div><div>flaky</div></div>
    ${
      coverage != null
        ? `<div class="card"><div class="n">${Math.round(coverage.ratio * 100)}%</div><div>coverage</div></div>`
        : ''
    }
  </div>

  ${coverageSection}

  <section>
    <h2>Plan</h2>
    <p>${esc(plan.summary)}</p>
    <table>
      <thead><tr><th>Title</th><th>Tier</th><th>Req</th><th>Intent</th></tr></thead>
      <tbody>${planRows || '<tr><td colspan="4"><em>No plan items.</em></td></tr>'}</tbody>
    </table>
  </section>

  <section>
    <h2>Results</h2>
    <table>
      <thead><tr><th>Title</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
      <tbody>${resultRows || '<tr><td colspan="4"><em>No results.</em></td></tr>'}</tbody>
    </table>
  </section>

  ${
    triage.length > 0
      ? `<section>
    <h2>Triage</h2>
    <table>
      <thead><tr><th>Title</th><th>Verdict</th><th>Confidence</th><th>Rationale</th></tr></thead>
      <tbody>${triageRows}</tbody>
    </table>
  </section>`
      : ''
  }

  <div class="sub">Generated ${esc(report.generatedAt)}</div>
</body>
</html>`;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
