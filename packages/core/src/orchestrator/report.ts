import type { Project, Run } from '../storage/types.js';
import type { ExecOutcome, TestPlan } from '../modes/types.js';
import type { TriageResult } from '../triage/types.js';

/** One triaged failure, attached to the report. */
export interface ReportTriageEntry {
  title: string;
  error: string;
  triage: TriageResult;
}

/** How many planned items actually got a generated spec vs. were silently dropped. */
export interface GenerationStats {
  requestedItems: number;
  acceptedItems: number;
}

/** Final coverage-feedback-loop ratio vs. its target, when the loop ran. */
export interface CoverageStats {
  ratio: number;
  target: number;
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
  /** Item-level generation accounting across GENERATE and any gap-fill iterations. */
  generation?: GenerationStats;
  /** Final coverage-feedback-loop result, or null when the loop didn't run. */
  coverage?: CoverageStats | null;
  generatedAt: string;
}

export function buildReport(input: {
  run: Run;
  project: Project;
  plan: TestPlan;
  outcome: ExecOutcome | null;
  triage: ReportTriageEntry[];
  artifacts?: string[];
  generation?: GenerationStats;
  coverage?: CoverageStats | null;
}): RunReport {
  return {
    run: input.run,
    project: input.project,
    plan: input.plan,
    outcome: input.outcome,
    triage: input.triage,
    artifacts: input.artifacts ?? [],
    generation: input.generation,
    coverage: input.coverage ?? null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Human-readable degradation notes for this report, or an empty array when
 * nothing degraded. Covers three independent silent-failure paths that used
 * to look identical to a normal, fully-AI-authored run:
 *   1. planSource === 'fallback' — every planning attempt failed and this is
 *      synthesizePlan()'s minimal hardcoded smoke plan.
 *   2. plan.fallbackReason present with planSource still 'ai' — a batched
 *      plan where some (not all) batches failed; the rest is real AI content.
 *   3. generation.acceptedItems < requestedItems — items were planned but
 *      silently dropped after failed generation attempts.
 *   4. coverage.ratio < coverage.target — the coverage-feedback loop stopped
 *      short of its target.
 */
export function degradationNotes(report: RunReport): string[] {
  const notes: string[] = [];
  if (report.plan.planSource === 'fallback') {
    notes.push(
      `AI planning failed; this run used a minimal fallback plan instead of a full AI-generated one` +
        (report.plan.fallbackReason ? ` (reason: ${report.plan.fallbackReason}).` : '.'),
    );
  } else if (report.plan.fallbackReason) {
    notes.push(`Part of the plan could not be AI-generated (${report.plan.fallbackReason}).`);
  }
  const gen = report.generation;
  if (gen && gen.acceptedItems < gen.requestedItems) {
    const dropped = gen.requestedItems - gen.acceptedItems;
    notes.push(
      `Generated ${gen.acceptedItems}/${gen.requestedItems} planned spec(s); ${dropped} dropped after failed generation attempts.`,
    );
  }
  const cov = report.coverage;
  if (cov && cov.ratio < cov.target) {
    notes.push(
      `Coverage-feedback loop stopped at ${Math.round(cov.ratio * 100)}% (target ${Math.round(cov.target * 100)}%).`,
    );
  }
  return notes;
}

/** Render a self-contained, dependency-free HTML report. */
export function renderReportHtml(report: RunReport): string {
  const { run, project, plan, outcome, triage } = report;
  const total = outcome ? outcome.results.length : 0;
  const passed = outcome?.passed ?? 0;
  const failed = outcome?.failed ?? 0;
  const blocked = outcome?.blocked ?? 0;
  const flaky = outcome?.flaky ?? 0;
  const notes = degradationNotes(report);
  const degradationBanner =
    notes.length > 0
      ? `<section class="degraded">
    <h2>⚠ This run's suite may be smaller than intended</h2>
    <ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
  </section>`
      : '';

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
  section.degraded { border: 1px solid #9a670066; background: #9a67000f; border-radius: 8px; padding: .25rem 1rem 1rem; }
  section.degraded h2 { color: #9a6700; }
  section.degraded ul { margin: 0; padding-left: 1.25rem; }
</style>
</head>
<body>
  <h1>Healix Test Report</h1>
  <div class="sub">${esc(project.name)} &middot; run <code>${esc(run.id)}</code> &middot; status <strong>${esc(
    run.status,
  )}</strong></div>

  ${degradationBanner}

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
