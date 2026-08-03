import { describe, expect, it } from 'vitest';
import type { TestCase, TestResult } from '@healix/core';
import { joinResults, summarizeStatuses } from './RunDetailPanel';

function makeTest(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tst_1',
    runId: 'run_1',
    title: 'a test',
    reqTag: null,
    tier: null,
    status: 'passed',
    specPath: null,
    description: null,
    details: null,
    specCode: null,
    ...overrides,
  };
}

function makeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: 'res_1',
    testId: 'tst_1',
    status: 'passed',
    durationMs: 1,
    error: null,
    artifactsJson: null,
    description: null,
    details: null,
    stepsJson: null,
    skipReason: null,
    videoUnavailableReason: null,
    evidenceJson: null,
    ...overrides,
  };
}

describe('summarizeStatuses — Results tab summary tile counts', () => {
  it("counts a mixed run's skipped rows correctly, distinct from every other status", () => {
    const tests: TestCase[] = [
      makeTest({ id: 't1' }),
      makeTest({ id: 't2' }),
      makeTest({ id: 't3' }),
      makeTest({ id: 't4' }),
      makeTest({ id: 't5' }),
      makeTest({ id: 't6' }),
    ];
    const results: TestResult[] = [
      makeResult({ id: 'r1', testId: 't1', status: 'passed' }),
      makeResult({ id: 'r2', testId: 't2', status: 'failed' }),
      makeResult({ id: 'r3', testId: 't3', status: 'blocked' }),
      makeResult({ id: 'r4', testId: 't4', status: 'flaky' }),
      makeResult({
        id: 'r5',
        testId: 't5',
        status: 'skipped',
        skipReason: 'Feature flag X is disabled in this environment',
      }),
      makeResult({ id: 'r6', testId: 't6', status: 'skipped' }), // bare skip, no reason
    ];

    const rows = joinResults(tests, results);
    const summary = summarizeStatuses(rows);

    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.flaky).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(summary.pending).toBe(0);
    // Total (as TestSummary computes it) must still account for every row.
    expect(Object.values(summary).reduce((n, c) => n + c, 0)).toBe(6);
  });

  it('counts skipped rows the same way in the raw-results fallback path (no persisted TestCase rows)', () => {
    const results: TestResult[] = [
      makeResult({ id: 'r1', testId: 't1', status: 'passed' }),
      makeResult({ id: 'r2', testId: 't2', status: 'skipped', skipReason: 'manual QA check' }),
      makeResult({ id: 'r3', testId: 't3', status: 'skipped', skipReason: 'manual QA check' }),
    ];

    const rows = joinResults([], results);
    const summary = summarizeStatuses(rows);

    expect(summary.skipped).toBe(2);
    expect(summary.passed).toBe(1);
  });

  it('is 0 when nothing was skipped, not undefined/NaN', () => {
    const tests: TestCase[] = [makeTest({ id: 't1' })];
    const results: TestResult[] = [makeResult({ id: 'r1', testId: 't1', status: 'passed' })];
    const summary = summarizeStatuses(joinResults(tests, results));
    expect(summary.skipped).toBe(0);
  });
});

describe('joinResults — videoUnavailableReason', () => {
  it('carries videoUnavailableReason through from the persisted result row', () => {
    const tests: TestCase[] = [makeTest({ id: 't1' })];
    const results: TestResult[] = [
      makeResult({
        id: 'r1',
        testId: 't1',
        status: 'passed',
        videoUnavailableReason:
          'This test only used the API request context — no browser page was opened, so no video could be recorded.',
      }),
    ];
    const [row] = joinResults(tests, results);
    expect(row.videoUnavailableReason).toBe(
      'This test only used the API request context — no browser page was opened, so no video could be recorded.',
    );
  });

  it('defaults to null when the result has none, or no result row exists yet', () => {
    const tests: TestCase[] = [makeTest({ id: 't1' }), makeTest({ id: 't2' })];
    const results: TestResult[] = [makeResult({ id: 'r1', testId: 't1', status: 'passed' })];
    const rows = joinResults(tests, results);
    expect(rows.find((r) => r.key === 't1')?.videoUnavailableReason).toBeNull();
    expect(rows.find((r) => r.key === 't2')?.videoUnavailableReason).toBeNull();
  });

  it('carries videoUnavailableReason through the raw-results fallback path too', () => {
    const results: TestResult[] = [
      makeResult({ id: 'r1', testId: 't1', status: 'passed', videoUnavailableReason: 'blank recording' }),
    ];
    const [row] = joinResults([], results);
    expect(row.videoUnavailableReason).toBe('blank recording');
  });
});
