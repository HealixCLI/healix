import { describe, expect, it } from 'vitest';
import { buildReport, renderReportHtml } from './report.js';
import type { Project, Run } from '../storage/types.js';
import type { ExecOutcome, TestPlan } from '../modes/types.js';

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
  it('surfaces a failed result\'s artifact basenames (not full local paths) alongside its error', () => {
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
          artifacts: ['C:\\runs\\r1\\suite\\test-results\\foo\\trace.zip', 'C:\\runs\\r1\\suite\\test-results\\foo\\test-failed-1.png'],
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

  it('renders a suggested fix from triage when the engine provides one', () => {
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
    expect(html).toContain('Suggested fix');
    expect(html).toContain('Fix the missing aria-label on the submit button.');
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
            'Error: locator.click: Test timeout of 60000ms exceeded.\nCall log:\n  - waiting for getByRole(\'button\')\nat spec.ts:7:18',
        },
      ],
    };
    const report = buildReport({ run, project, plan, outcome, triage: [] });
    const html = renderReportHtml(report);
    expect(html).toContain('<div class="err-summary">Error: locator.click: Test timeout of 60000ms exceeded.</div>');
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
        coveredCount: 1,
        totalCount: 2,
        uncovered: [{ key: 'route:/checkout', kind: 'route', label: 'GET /checkout', file: 'src/pages/checkout.tsx' }],
      },
    });
    const html = renderReportHtml(report);
    expect(html).toContain('<h2>Coverage</h2>');
    expect(html).toContain('1/2 functionality unit(s) covered (50%)');
    expect(html).toContain('GET /checkout');
    expect(html).toContain('src/pages/checkout.tsx');
  });
});
