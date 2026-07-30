import { describe, expect, it } from 'vitest';
import { computeKbBackfillRows } from './kb-backfill.js';
import type { TestPlan } from '../modes/types.js';
import type { TestCase, TestResult } from '../storage/types.js';

function test(overrides: Partial<TestCase> & Pick<TestCase, 'id' | 'title'>): TestCase {
  return {
    runId: 'run_1',
    reqTag: null,
    tier: 'tierA-public',
    status: 'pending',
    specPath: null,
    description: null,
    details: null,
    specCode: null,
    ...overrides,
  };
}

function result(overrides: Partial<TestResult> & Pick<TestResult, 'id' | 'testId' | 'status'>): TestResult {
  return {
    durationMs: null,
    error: null,
    artifactsJson: null,
    description: null,
    details: null,
    stepsJson: null,
    skipReason: null,
    videoUnavailableReason: null,
    ...overrides,
  };
}

const PLAN: TestPlan = {
  summary: 'plan',
  items: [
    {
      id: 'pli_a',
      title: 'Item A (generated + passed)',
      reqTag: 'REQ-A',
      tier: 'tierA-public',
      intent: 'x',
      scenarios: [{ kind: 'positive', description: 'one scenario' }],
    },
    {
      id: 'pli_b',
      title: 'Item B (generated, never executed)',
      reqTag: 'REQ-B',
      tier: 'tierA-public',
      intent: 'x',
      scenarios: [{ kind: 'positive', description: 'one scenario' }],
    },
    {
      id: 'pli_c',
      title: 'Item C (never generated at all)',
      reqTag: 'REQ-C',
      tier: 'tierA-public',
      intent: 'x',
      scenarios: [{ kind: 'positive', description: 'one scenario' }],
    },
  ],
};

describe('computeKbBackfillRows', () => {
  it('classifies an item with no matching test row at all as dropped', () => {
    const rows = computeKbBackfillRows(PLAN, [], []);
    const c = rows.find((r) => r.planItemId === 'pli_c')!;
    expect(c.status).toBe('dropped');
    expect(c.scenarios).toHaveLength(1);
    expect(c.scenarios[0]!.status).toBe('dropped');
    expect(c.scenarios[0]!.testId).toBeNull();
  });

  it('classifies an item with a matched-but-unexecuted test row as generated/pending (NOT "generated" at the scenario level)', () => {
    const tests = [test({ id: 'tst_b', title: '[REQ:REQ-B] Item B — positive: one scenario', reqTag: 'REQ-B' })];
    const rows = computeKbBackfillRows(PLAN, tests, []);
    const b = rows.find((r) => r.planItemId === 'pli_b')!;
    expect(b.status).toBe('generated');
    expect(b.scenarios[0]!.status).toBe('pending');
    expect(b.scenarios[0]!.testId).toBe('tst_b');
  });

  it("classifies an item with a matched, executed test row using the result's real status", () => {
    const tests = [test({ id: 'tst_a', title: '[REQ:REQ-A] Item A — positive: one scenario', reqTag: 'REQ-A' })];
    const results = [result({ id: 'res_a', testId: 'tst_a', status: 'passed' })];
    const rows = computeKbBackfillRows(PLAN, tests, results);
    const a = rows.find((r) => r.planItemId === 'pli_a')!;
    expect(a.status).toBe('generated');
    expect(a.scenarios[0]!.status).toBe('passed');
    expect(a.scenarios[0]!.testId).toBe('tst_a');
  });

  it('matches purely by the [REQ:tag] title marker when a test row has no reqTag column set', () => {
    // Mirrors registerSpecRows' real persistedReqTag behavior for a reqTag-less
    // plan item: the DB column is null, but the title still carries the tag.
    const tests = [test({ id: 'tst_a', title: '[REQ:REQ-A] Item A — positive: one scenario', reqTag: null })];
    const rows = computeKbBackfillRows(PLAN, tests, []);
    const a = rows.find((r) => r.planItemId === 'pli_a')!;
    expect(a.status).toBe('generated');
    expect(a.scenarios[0]!.testId).toBe('tst_a');
  });

  it('produces one KB row per plan item regardless of match state', () => {
    const rows = computeKbBackfillRows(PLAN, [], []);
    expect(rows.map((r) => r.planItemId).sort()).toEqual(['pli_a', 'pli_b', 'pli_c']);
  });
});
