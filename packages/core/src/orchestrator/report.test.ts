import { describe, expect, it } from 'vitest';
import { buildReport, degradationNotes, renderReportHtml, type RunReport } from './report.js';
import type { Project, Run } from '../storage/types.js';
import type { ExecOutcome, TestPlan } from '../modes/types.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_test',
    projectId: 'prj_test',
    provider: null,
    mode: 'playwright',
    suiteMode: 'fresh',
    baseRunId: null,
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    pauseReason: null,
    ...overrides,
  };
}

function makeProject(): Project {
  return {
    id: 'prj_test',
    name: 'Demo',
    mode: 'playwright',
    repoPath: null,
    baseUrl: 'https://app.example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    testUsername: null,
    testPassword: null,
  };
}

const REAL_PLAN: TestPlan = {
  summary: 'A real plan.',
  items: [
    { id: 'pli_1', title: 'Home loads', tier: 'tierA-public', intent: 'Landing renders.', scenarios: [] },
  ],
  planSource: 'ai',
};

describe('degradationNotes', () => {
  it('is empty for a normal AI-authored plan with full generation and coverage', () => {
    const report = buildReport({
      run: makeRun(),
      project: makeProject(),
      plan: REAL_PLAN,
      outcome: null,
      triage: [],
      generation: { requestedItems: 5, acceptedItems: 5 },
      coverage: { ratio: 0.9, target: 0.8, coveredCount: 9, totalCount: 10, uncovered: [] },
    });
    expect(degradationNotes(report)).toEqual([]);
  });

  it('flags a fallback (smoke) plan with its reason', () => {
    const report = buildReport({
      run: makeRun(),
      project: makeProject(),
      plan: { ...REAL_PLAN, planSource: 'fallback', fallbackReason: 'unparseable plan response (truncated)' },
      outcome: null,
      triage: [],
    });
    const notes = degradationNotes(report);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('fallback plan');
    expect(notes[0]).toContain('truncated');
  });

  it('flags a partially-degraded batched plan (planSource still ai) via fallbackReason alone', () => {
    const report = buildReport({
      run: makeRun(),
      project: makeProject(),
      plan: { ...REAL_PLAN, planSource: 'ai', fallbackReason: '1/3 batch(es) failed: batch 2/3: timeout' },
      outcome: null,
      triage: [],
    });
    const notes = degradationNotes(report);
    expect(notes.some((n) => n.includes('batch 2/3'))).toBe(true);
  });

  it('flags dropped generation items', () => {
    const report = buildReport({
      run: makeRun(),
      project: makeProject(),
      plan: REAL_PLAN,
      outcome: null,
      triage: [],
      generation: { requestedItems: 20, acceptedItems: 14 },
    });
    const notes = degradationNotes(report);
    expect(notes.some((n) => n.includes('14/20') && n.includes('6 dropped'))).toBe(true);
  });

  it('flags a coverage-feedback loop that stopped short of its target', () => {
    const report = buildReport({
      run: makeRun(),
      project: makeProject(),
      plan: REAL_PLAN,
      outcome: null,
      triage: [],
      coverage: { ratio: 0.62, target: 0.8, coveredCount: 6, totalCount: 10, uncovered: [] },
    });
    const notes = degradationNotes(report);
    expect(notes.some((n) => n.includes('62%') && n.includes('80%'))).toBe(true);
  });

  it('does not flag a coverage loop that met its target', () => {
    const report = buildReport({
      run: makeRun(),
      project: makeProject(),
      plan: REAL_PLAN,
      outcome: null,
      triage: [],
      coverage: { ratio: 0.85, target: 0.8, coveredCount: 17, totalCount: 20, uncovered: [] },
    });
    expect(degradationNotes(report)).toEqual([]);
  });
});

describe('renderReportHtml degradation banner', () => {
  it('omits the banner section for a healthy report', () => {
    const report = buildReport({
      run: makeRun(),
      project: makeProject(),
      plan: REAL_PLAN,
      outcome: null,
      triage: [],
    });
    const html = renderReportHtml(report);
    expect(html).not.toContain('may be smaller than intended');
  });

  it('renders the banner with each note for a degraded report', () => {
    const report: RunReport = buildReport({
      run: makeRun(),
      project: makeProject(),
      plan: { ...REAL_PLAN, planSource: 'fallback', fallbackReason: 'no ready provider' },
      outcome: null,
      triage: [],
      generation: { requestedItems: 10, acceptedItems: 3 },
    });
    const html = renderReportHtml(report);
    expect(html).toContain('may be smaller than intended');
    expect(html).toContain('no ready provider');
    expect(html).toContain('3/10');
  });
});

const run: Run = {
  id: 'run_1',
  projectId: 'prj_1',
  status: 'failed',
  provider: null,
  mode: 'playwright',
  startedAt: null,
  finishedAt: null,
  createdAt: new Date(0).toISOString(),
  suiteMode: 'fresh',
  baseRunId: null,
  pauseReason: null,
};

const project: Project = {
  id: 'prj_1',
  name: 'Demo',
  mode: 'playwright',
  baseUrl: 'https://app.example.test',
  repoPath: null,
  createdAt: new Date(0).toISOString(),
  archivedAt: null,
  testUsername: null,
  testPassword: null,
};

const plan: TestPlan = { summary: 'One feature.', items: [] };

describe('report — failure diagnostics, coverage, artifacts', () => {
  it("surfaces a failed result's artifact basenames (not full local paths) alongside its error", () => {
    const outcome: ExecOutcome = {
      passed: 0,
      failed: 1,
      blocked: 0,
      flaky: 0,
      results: [
        {
          title: '[REQ:REQ-1] positive: fails',
          status: 'failed',
          durationMs: 5,
          error: 'expect(locator).toBeVisible() failed',
          artifacts: [
            'C:\\runs\\r1\\suite\\test-results\\foo\\trace.zip',
            'C:\\runs\\r1\\suite\\test-results\\foo\\test-failed-1.png',
          ],
        },
      ],
    };
    const report = buildReport({ run, project, plan, outcome, triage: [] });
    const html = renderReportHtml(report);
    expect(html).toContain('trace.zip');
    expect(html).toContain('test-failed-1.png');
    // The full local filesystem path must never leak into the report.
    expect(html).not.toContain('C:\\runs\\r1');
  });

  it('renders an app-bug recommendation as prose under "Recommended fix", not a <code> test-patch block', () => {
    const outcome: ExecOutcome = {
      passed: 0,
      failed: 1,
      blocked: 0,
      flaky: 0,
      results: [{ title: '[REQ:REQ-1] positive: fails', status: 'failed', durationMs: 5, error: 'boom' }],
    };
    const report = buildReport({
      run,
      project,
      plan,
      outcome,
      triage: [
        {
          title: '[REQ:REQ-1] positive: fails',
          error: 'boom',
          triage: {
            verdict: 'app_is_wrong',
            confidence: 0.8,
            rationale: 'Assertion failed on a real element.',
            suggestedPatch: 'Fix the missing aria-label on the submit button.',
          },
        },
      ],
    });
    const html = renderReportHtml(report);
    expect(html).toContain('Recommended fix');
    expect(html).toContain('Fix the missing aria-label on the submit button.');
    // Prose recommendation, not wrapped in a <code> block like a test patch.
    expect(html).not.toContain('<code>Fix the missing aria-label on the submit button.</code>');
  });

  it('renders a test-code suggestion under "Suggested test fix" wrapped in <code>, for test_is_wrong verdicts', () => {
    const outcome: ExecOutcome = {
      passed: 0,
      failed: 1,
      blocked: 0,
      flaky: 0,
      results: [
        { title: '[REQ:REQ-2] positive: fails', status: 'failed', durationMs: 5, error: 'stale locator' },
      ],
    };
    const report = buildReport({
      run,
      project,
      plan,
      outcome,
      triage: [
        {
          title: '[REQ:REQ-2] positive: fails',
          error: 'stale locator',
          triage: {
            verdict: 'test_is_wrong',
            confidence: 0.7,
            rationale: 'The selector no longer matches the live UI.',
            suggestedPatch: "await page.getByRole('button', { name: 'Submit' }).click();",
          },
        },
      ],
    });
    const html = renderReportHtml(report);
    expect(html).toContain('Suggested test fix');
    // Apostrophes are HTML-escaped by esc(), same as everywhere else in the report.
    expect(html).toContain(
      '<code>await page.getByRole(&#39;button&#39;, { name: &#39;Submit&#39; }).click();</code>',
    );
  });

  it('scales the Duration column ms -> s -> min -> hr instead of raw milliseconds', () => {
    const outcome: ExecOutcome = {
      passed: 4,
      failed: 0,
      blocked: 0,
      flaky: 0,
      results: [
        { title: 'sub-second', status: 'passed', durationMs: 500 },
        { title: 'seconds', status: 'passed', durationMs: 11_235 },
        { title: 'minutes', status: 'passed', durationMs: 1_432_300 },
        { title: 'hours', status: 'passed', durationMs: 60 * 60_000 + 2 * 60_000 },
      ],
    };
    const report = buildReport({ run, project, plan, outcome, triage: [] });
    const html = renderReportHtml(report);
    expect(html).toContain('<td>500ms</td>');
    expect(html).toContain('<td>11.2s</td>');
    expect(html).toContain('<td>23m 52s</td>');
    expect(html).toContain('<td>1h 2m</td>');
  });

  it('shows a one-line error summary with the full call log tucked behind a details toggle', () => {
    const outcome: ExecOutcome = {
      passed: 0,
      failed: 1,
      blocked: 0,
      flaky: 0,
      results: [
        {
          title: '[REQ:REQ-1] positive: fails',
          status: 'failed',
          durationMs: 5,
          error:
            "Error: locator.click: Test timeout of 60000ms exceeded.\nCall log:\n  - waiting for getByRole('button')\nat spec.ts:7:18",
        },
      ],
    };
    const report = buildReport({ run, project, plan, outcome, triage: [] });
    const html = renderReportHtml(report);
    expect(html).toContain(
      '<div class="err-summary">Error: locator.click: Test timeout of 60000ms exceeded.</div>',
    );
    expect(html).toContain('<details><summary>Full details</summary>');
    expect(html).toContain('Call log:');
  });

  it('inlines the matching triage verdict/rationale under a failed row instead of only in a separate table', () => {
    const outcome: ExecOutcome = {
      passed: 0,
      failed: 1,
      blocked: 0,
      flaky: 0,
      results: [{ title: '[REQ:REQ-1] positive: fails', status: 'failed', durationMs: 5, error: 'boom' }],
    };
    const report = buildReport({
      run,
      project,
      plan,
      outcome,
      triage: [
        {
          title: '[REQ:REQ-1] positive: fails',
          error: 'boom',
          triage: { verdict: 'app_is_wrong', confidence: 0.9, rationale: 'Real defect.' },
        },
      ],
    });
    const html = renderReportHtml(report);
    // Inline diagnosis appears once per matching row, inside the Results table's error cell.
    expect(html).toContain('class="diagnosis"');
    expect(html).toContain('App defect');
    expect(html).toContain('90% confidence');
    expect(html).toContain('Real defect.');
  });

  it('omits the coverage card/section entirely when coverage was never computed (e.g. reuse mode)', () => {
    const report = buildReport({ run, project, plan, outcome: null, triage: [] });
    expect(report.coverage).toBeNull();
    const html = renderReportHtml(report);
    expect(html).not.toContain('>coverage<');
    expect(html).not.toContain('<h2>Coverage</h2>');
  });

  it('surfaces the coverage ratio and lists uncovered functionality units when present', () => {
    const report = buildReport({
      run,
      project,
      plan,
      outcome: null,
      triage: [],
      coverage: {
        ratio: 0.5,
        target: 0.8,
        coveredCount: 1,
        totalCount: 2,
        uncovered: [
          { key: 'route:/checkout', kind: 'route', label: 'GET /checkout', file: 'src/pages/checkout.tsx' },
        ],
      },
    });
    const html = renderReportHtml(report);
    expect(html).toContain('<h2>Coverage</h2>');
    expect(html).toContain('1/2 functionality unit(s) covered (50%)');
    expect(html).toContain('GET /checkout');
    expect(html).toContain('src/pages/checkout.tsx');
  });
});
