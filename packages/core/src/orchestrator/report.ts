import type { Project, Run } from '../storage/types.js';
import type { ExecOutcome, TestPlan } from '../modes/types.js';
import type { TriageResult } from '../triage/types.js';

/** One triaged failure, attached to the report. */
export interface ReportTriageEntry {
  title: string;
  error: string;
  triage: TriageResult;
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
  generatedAt: string;
}

export function buildReport(input: {
  run: Run;
  project: Project;
  plan: TestPlan;
  outcome: ExecOutcome | null;
  triage: ReportTriageEntry[];
  artifacts?: string[];
}): RunReport {
  return {
    run: input.run,
    project: input.project,
    plan: input.plan,
    outcome: input.outcome,
    triage: input.triage,
    artifacts: input.artifacts ?? [],
    generatedAt: new Date().toISOString(),
  };
}

/** Render a self-contained, dependency-free HTML report. */
export function renderReportHtml(report: RunReport): string {
  const { run, project, plan, outcome, triage } = report;
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

  const resultRows = (outcome?.results ?? [])
    .map(
      (r) =>
        `<tr class="status-${esc(r.status)}"><td>${esc(r.title)}</td><td>${esc(r.status)}</td><td>${
          r.durationMs != null ? esc(String(r.durationMs)) + ' ms' : ''
        }</td><td>${esc(r.error ?? '')}</td></tr>`,
    )
    .join('');

  const triageRows = triage
    .map(
      (t) =>
        `<tr><td>${esc(t.title)}</td><td>${esc(t.triage.verdict)}</td><td>${esc(
          (t.triage.confidence * 100).toFixed(0),
        )}%</td><td>${esc(t.triage.rationale)}</td></tr>`,
    )
    .join('');

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
  section { margin-bottom: 1rem; }
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
  </div>

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
