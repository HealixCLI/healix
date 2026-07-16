import { describe, expect, it } from 'vitest';
import { buildReport, degradationNotes, renderReportHtml, type RunReport } from './report.js';
import type { Project, Run } from '../storage/types.js';
import type { TestPlan } from '../modes/types.js';

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
  items: [{ id: 'pli_1', title: 'Home loads', tier: 'tierA-public', intent: 'Landing renders.', scenarios: [] }],
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
      coverage: { ratio: 0.9, target: 0.8 },
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
      coverage: { ratio: 0.62, target: 0.8 },
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
      coverage: { ratio: 0.85, target: 0.8 },
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
