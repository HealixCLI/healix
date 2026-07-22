import { relative, sep } from 'node:path';
import type { Project, Run, TestCase } from '../storage/types.js';
import type { ExecOutcome, ExecStepItem, TestPlan } from '../modes/types.js';
import type { TriageResult } from '../triage/types.js';
import type { ExternalDependency } from '../target/types.js';
import type { FunctionalityUnit } from '../target/functionality-index.js';

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

/**
 * Serializable snapshot of the coverage-feedback loop's final state (see
 * orchestrator/coverage.ts's CoverageResult) — a plain object instead of a
 * Set, so it survives JSON.stringify/report.json round-tripping intact.
 */
export interface ReportCoverageSummary {
  ratio: number;
  target: number;
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
  /** Persisted TestCase rows for this run, used to enrich the Results table with description/details. */
  tests: TestCase[];
  /** Artifact files collected from the mode after execution (relative paths). */
  artifacts: string[];
  /** External dependencies detected/mocked for this run (empty when mocking wasn't enabled). */
  dependencies: ExternalDependency[];
  /** How many requests the local mock server actually intercepted, keyed by dependency id. */
  mockedRequestCounts: Record<string, number>;
  /** Item-level generation accounting across GENERATE and any gap-fill iterations. */
  generation?: GenerationStats;
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
  tests?: TestCase[];
  artifacts?: string[];
  dependencies?: ExternalDependency[];
  mockedRequestCounts?: Record<string, number>;
  generation?: GenerationStats;
  coverage?: ReportCoverageSummary | null;
}): RunReport {
  return {
    run: input.run,
    project: input.project,
    plan: input.plan,
    outcome: input.outcome,
    triage: input.triage,
    tests: input.tests ?? [],
    artifacts: input.artifacts ?? [],
    dependencies: input.dependencies ?? [],
    mockedRequestCounts: input.mockedRequestCounts ?? {},
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

/** Last path segment, for display only — avoids printing a full local filesystem path into the report. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Scales ms -> s -> "Xm Ys" -> "Xh Ym" so a slow scenario reads as "23m 52s" instead of a raw "1432300 ms". */
function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = ms / 1000;
  // Round once, up front, so the sub-minute display and the minute/hour
  // branch boundary agree (otherwise e.g. 59.96s would print "60.0s" while
  // still taking the seconds-only branch instead of rolling over to "1m 0s").
  const roundedSeconds = Math.round(totalSeconds);
  if (roundedSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
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

/**
 * suggestedPatch's shape depends on the verdict (see TriageResult) — a
 * corrected test snippet reads naturally as code, but an app-bug
 * recommendation is prose (the triage engine never sees the app's own
 * source), so it gets its own label and isn't wrapped in a <code> block.
 */
function renderSuggestedFix(verdict: TriageResult['verdict'], patch: string, className = ''): string {
  const cls = className ? ` class="${className}"` : '';
  if (verdict === 'test_is_wrong') {
    return `<div${cls}><strong>Suggested test fix:</strong> <code>${esc(patch)}</code></div>`;
  }
  return `<div${cls}><strong>Recommended fix:</strong> ${esc(patch)}</div>`;
}

const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_EXT = /\.(webm|mp4|mov)$/i;

/**
 * Evidence for one test row — screenshot(s), video, and anything else
 * captured (trace.zip, error-context.md, …). `reportDir` is the absolute
 * directory report.html itself is written to (runDir/reports); artifact
 * paths are absolute on disk, so we link to them relative to that directory
 * rather than embedding data (this stays a single file, but still resolves
 * correctly as long as the report is opened from alongside the run's suite/
 * folder — the same layout it was generated in). Without a reportDir (older
 * callers, unit tests) we fall back to the original plain-basename listing,
 * since we have no safe path to link to.
 */
function renderArtifacts(artifacts: string[] | undefined, reportDir: string | undefined): string {
  if (!artifacts || artifacts.length === 0) return '';
  if (!reportDir) {
    return `<div class="hist">${artifacts.map((a) => esc(baseName(a))).join(', ')}</div>`;
  }
  const items = artifacts.map((abs) => ({
    href: relative(reportDir, abs).split(sep).join('/'),
    name: baseName(abs),
  }));
  const images = items.filter((i) => IMG_EXT.test(i.name));
  const videos = items.filter((i) => VIDEO_EXT.test(i.name));
  const other = items.filter((i) => !IMG_EXT.test(i.name) && !VIDEO_EXT.test(i.name));
  const imgHtml = images
    .map(
      (i) =>
        `<a href="${esc(i.href)}" target="_blank" rel="noopener"><img src="${esc(i.href)}" alt="${esc(
          i.name,
        )}" class="ev-thumb" /></a>`,
    )
    .join('');
  const videoHtml = videos
    .map((i) => `<video controls preload="metadata" class="ev-video" src="${esc(i.href)}"></video>`)
    .join('');
  const otherHtml = other.map((i) => `<a class="ev-file" href="${esc(i.href)}">${esc(i.name)}</a>`).join('');
  return `<div class="evidence">${imgHtml}${videoHtml}${otherHtml}</div>`;
}

/**
 * Step-by-step breakdown (click, fill, navigate, assert...) for one result —
 * present for both passed and failed tests, not just failures, since seeing
 * what a test actually DID is useful regardless of outcome. Collapsed by
 * default so it doesn't dominate the row; absent entirely for older suites
 * scaffolded before the steps reporter existed.
 */
/**
 * One step's <li> — a human-authored test.step(...) task gets its own nested
 * <details> revealing the raw actions (click/fill/expect/etc.) performed
 * inside it, so a reader gets the high-level task name by default and can
 * drop into the technical blow-by-blow only when they want to.
 */
function renderStepItem(s: ExecStepItem): string {
  const errBlock = s.error ? `<div class="step-err">${esc(s.error.split('\n')[0] ?? s.error)}</div>` : '';
  const children =
    s.steps && s.steps.length > 0
      ? `<details class="substeps"><summary>${s.steps.length} action${s.steps.length === 1 ? '' : 's'}</summary><ol>${s.steps
          .map(renderStepItem)
          .join('')}</ol></details>`
      : '';
  return `<li${s.error ? ' class="step-failed"' : ''}>${esc(s.title)} <span class="hist">${esc(
    formatDuration(s.durationMs),
  )}</span>${errBlock}${children}</li>`;
}

function renderSteps(steps: ExecStepItem[] | undefined): string {
  if (!steps || steps.length === 0) {
    // Genuinely nothing ran (e.g. auth-setup's "no credentials configured"
    // check throwing before any page action) as well as older suites from
    // before the steps reporter existed both land here — say so explicitly,
    // matching the desktop UI's equivalent, rather than leaving the cell
    // blank (reads as a bug, not an accurate "there were none to record").
    return '<span class="hist">No steps recorded.</span>';
  }
  const items = steps.map(renderStepItem).join('');
  return `<details class="steps"><summary>${steps.length} step${steps.length === 1 ? '' : 's'}</summary><ol>${items}</ol></details>`;
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
      ${triage.triage.suggestedPatch ? renderSuggestedFix(triage.triage.verdict, triage.triage.suggestedPatch) : ''}
    </div>`
    : '';
  return `<div class="err-summary">${esc(summary)}</div>${triageBlock}${detailsBlock}`;
}

/**
 * Render a self-contained, dependency-free HTML report.
 *
 * `opts.reportDir` — the absolute directory this HTML will be written to
 * (runDir/reports) — enables linking each result row to its own evidence
 * (screenshot/video/trace) relative to that location; omit it (e.g. in unit
 * tests, or if the report is rendered before its final location is known) to
 * fall back to a plain basename listing with no links.
 */
export function renderReportHtml(report: RunReport, opts: { reportDir?: string } = {}): string {
  const { reportDir } = opts;
  const { run, project, plan, outcome, triage, tests, dependencies, mockedRequestCounts, coverage } = report;
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

  const dependencyRows = dependencies
    .map((d) => {
      const mocked = d.mockStrategy !== 'undeterminable';
      const requestCount = mockedRequestCounts[d.id] ?? 0;
      const statusLabel = mocked
        ? `mocked (${d.mockStrategy})${requestCount > 0 ? ` — ${requestCount} request(s) intercepted` : ''}`
        : `not mocked${d.note ? ` — ${d.note}` : ''}`;
      return `<tr class="${mocked ? '' : 'rejected'}"><td>${esc(d.label)}</td><td>${esc(d.category)}</td><td>${esc(
        d.source,
      )}</td><td>${esc(statusLabel)}</td></tr>`;
    })
    .join('');

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
  // Persisted TestCase rows are also keyed by title (the same title a result
  // row carries once updateTestTitle has run) so the Results table can show
  // the scenario's description/intent without needing testId on ExecResultItem.
  const testByTitle = new Map<string, TestCase>(tests.map((t) => [t.title, t]));

  const resultRows = (outcome?.results ?? [])
    .map((r) => {
      const matchedTest = testByTitle.get(r.title);
      const descriptionCell =
        [matchedTest?.description, matchedTest?.details].filter(Boolean).length > 0
          ? `${matchedTest?.description ? esc(matchedTest.description) : ''}${
              matchedTest?.details ? `<div class="hist">${esc(matchedTest.details)}</div>` : ''
            }`
          : '';
      return `<tr class="status-${esc(r.status)}"><td>${esc(r.title)}</td><td>${esc(r.status)}</td><td>${esc(
        formatDuration(r.durationMs),
      )}</td><td>${descriptionCell}</td><td>${renderErrorCell(r.error, triageByTitle.get(r.title))}</td><td>${renderSteps(
        r.steps,
      )}</td><td>${renderArtifacts(r.artifacts, reportDir)}</td></tr>`;
    })
    .join('');

  const triageRows = triage
    .map(
      (t) =>
        `<tr><td>${esc(t.title)}</td><td>${esc(t.triage.verdict)}</td><td>${esc(
          (t.triage.confidence * 100).toFixed(0),
        )}%</td><td>${esc(t.triage.rationale)}${
          t.triage.suggestedPatch ? renderSuggestedFix(t.triage.verdict, t.triage.suggestedPatch, 'hist') : ''
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
  section.degraded { border: 1px solid #9a670066; background: #9a67000f; border-radius: 8px; padding: .25rem 1rem 1rem; }
  section.degraded h2 { color: #9a6700; }
  section.degraded ul { margin: 0; padding-left: 1.25rem; }
  .err-summary { font-weight: 600; }
  .diagnosis { margin-top: .35rem; font-size: .8rem; }
  .diagnosis .hist { display: inline; }
  .verdict-app_is_wrong { background: #cf222e30; }
  .verdict-test_is_wrong { background: #9a670030; }
  .verdict-environment { background: #9a670030; }
  .verdict-flaky { background: #9a670030; }
  .verdict-ambiguous { background: #88848430; }
  details summary { cursor: pointer; font-size: .75rem; color: #888; }
  .evidence { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .35rem; }
  .ev-thumb { width: 96px; height: 64px; object-fit: cover; border-radius: 4px; border: 1px solid #8884; }
  .ev-video { width: 160px; max-height: 100px; border-radius: 4px; border: 1px solid #8884; background: #000; }
  .ev-file { font-size: .75rem; color: #888; align-self: center; border: 1px solid #8884; border-radius: 4px;
    padding: .1rem .4rem; text-decoration: none; }
  .ev-file:hover { color: inherit; }
  .steps ol { margin: .35rem 0 0; padding-left: 1.1rem; font-size: .78rem; }
  .steps li { margin-bottom: .2rem; }
  .steps li.step-failed { color: #cf222e; }
  .steps .step-err { font-size: .7rem; color: #cf222e; opacity: .85; }
  .substeps { margin-top: .2rem; }
  .substeps summary { color: #888; font-size: .7rem; }
  .substeps ol { margin: .25rem 0 0; padding-left: 1rem; }
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
      <thead><tr><th>Title</th><th>Status</th><th>Duration</th><th>Description</th><th>Error</th><th>Steps</th><th>Evidence</th></tr></thead>
      <tbody>${resultRows || '<tr><td colspan="7"><em>No results.</em></td></tr>'}</tbody>
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

  ${
    dependencies.length > 0
      ? `<section>
    <h2>External dependencies</h2>
    <p>${dependencies.filter((d) => d.mockStrategy !== 'undeterminable').length} of ${dependencies.length} detected dependenc${dependencies.length === 1 ? 'y was' : 'ies were'} mocked for this run.</p>
    <table>
      <thead><tr><th>Dependency</th><th>Category</th><th>Detected via</th><th>Status</th></tr></thead>
      <tbody>${dependencyRows}</tbody>
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
