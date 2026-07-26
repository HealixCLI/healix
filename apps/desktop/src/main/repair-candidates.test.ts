import { describe, expect, it } from 'vitest';
import type { TestCase, TestPlan } from '@healix/core';
import { matchGenerationGaps, matchRepairCandidates } from './repair-candidates.js';

function testCase(overrides: Partial<TestCase> & Pick<TestCase, 'id' | 'title'>): TestCase {
  return {
    runId: 'run_1',
    reqTag: null,
    tier: null,
    status: 'failed',
    specPath: null,
    specCode: null,
    description: null,
    details: null,
    ...overrides,
  };
}

const PLAN: TestPlan = {
  summary: 'plan',
  items: [
    { id: 'pli_a', title: 'Home loads', tier: 'tierA-public', reqTag: 'REQ-A', intent: 'x', scenarios: [] },
    {
      id: 'pli_b',
      title: 'Checkout works',
      tier: 'tierA-public',
      reqTag: 'REQ-B',
      intent: 'x',
      scenarios: [],
    },
    {
      id: 'pli_c',
      title: 'Settings works',
      tier: 'tierA-public',
      reqTag: 'REQ-C',
      intent: 'x',
      scenarios: [],
    },
  ],
};

describe('matchRepairCandidates', () => {
  it('resolves triaged test_is_wrong test ids to their base-plan item ids via reqTag identity', () => {
    const tests = [
      testCase({ id: 'tst_a', title: '[REQ:REQ-A] Home loads', reqTag: 'REQ-A' }),
      testCase({ id: 'tst_b', title: '[REQ:REQ-B] Checkout works', reqTag: 'REQ-B' }),
      testCase({ id: 'tst_c', title: '[REQ:REQ-C] Settings works', reqTag: 'REQ-C' }),
    ];

    const candidates = matchRepairCandidates(PLAN, tests, new Set(['tst_b']));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: 'pli_b', reqTag: 'REQ-B', title: 'Checkout works' });
  });

  it('dedupes when multiple wrong-verdict test rows map to the same plan item', () => {
    const tests = [
      testCase({ id: 'tst_b1', title: '[REQ:REQ-B] scenario 1', reqTag: 'REQ-B' }),
      testCase({ id: 'tst_b2', title: '[REQ:REQ-B] scenario 2', reqTag: 'REQ-B' }),
    ];

    const candidates = matchRepairCandidates(PLAN, tests, new Set(['tst_b1', 'tst_b2']));

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('pli_b');
  });

  it('silently skips a wrong-verdict test id with no matching test row or no matching plan item', () => {
    const tests = [testCase({ id: 'tst_a', title: '[REQ:REQ-A] Home loads', reqTag: 'REQ-A' })];

    // 'tst_missing' has no test row at all; 'tst_a' resolves to a test whose
    // reqTag has no counterpart in PLAN once we substitute a foreign tag.
    const candidates = matchRepairCandidates(PLAN, tests, new Set(['tst_missing']));

    expect(candidates).toEqual([]);
  });

  it('returns nothing when no test was triaged test_is_wrong', () => {
    const tests = [testCase({ id: 'tst_a', title: '[REQ:REQ-A] Home loads', reqTag: 'REQ-A' })];
    expect(matchRepairCandidates(PLAN, tests, new Set())).toEqual([]);
  });
});

describe('matchGenerationGaps', () => {
  it('finds no gaps when every plan item has a matching test row (reqTag identity)', () => {
    const tests = [
      testCase({ id: 'tst_a', title: '[REQ:REQ-A] Home loads', reqTag: 'REQ-A' }),
      testCase({ id: 'tst_b', title: '[REQ:REQ-B] Checkout works', reqTag: 'REQ-B' }),
      testCase({ id: 'tst_c', title: '[REQ:REQ-C] Settings works', reqTag: 'REQ-C' }),
    ];
    expect(matchGenerationGaps(PLAN, tests)).toEqual([]);
  });

  it('finds exactly the item whose generation was dropped', () => {
    const tests = [
      testCase({ id: 'tst_a', title: '[REQ:REQ-A] Home loads', reqTag: 'REQ-A' }),
      testCase({ id: 'tst_c', title: '[REQ:REQ-C] Settings works', reqTag: 'REQ-C' }),
      // REQ-B has no test row at all — a genuine generation gap.
    ];
    const gaps = matchGenerationGaps(PLAN, tests);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ id: 'pli_b', reqTag: 'REQ-B' });
  });

  it('regression: a reqTag-less plan item with a real generated test is NOT mistaken for a gap', () => {
    // Root-cause regression for a real bug found via manual testing: when a
    // plan item has no reqTag (common for simple frontend apps — the AI
    // never assigns one), the persisted test row's OWN reqTag column is
    // correctly null (registerSpecRows persists the item's true reqTag, not
    // the item.id fallback generate.ts uses internally) — but the row's
    // TITLE still embeds that fallback id via the `[REQ:<tag>]` marker every
    // generated test carries (see generate.ts's buildPrompt). This proves
    // matchGenerationGaps recovers that same-run linkage from the title when
    // the reqTag column itself is null, so a reqTag-less, fully-generated
    // item is still recognized as covered.
    const reqTaglessPlan: TestPlan = {
      summary: 'plan',
      items: [
        { id: 'pli_x', title: 'Home loads', tier: 'tierA-public', intent: 'x', scenarios: [] },
        { id: 'pli_y', title: 'Checkout works', tier: 'tierA-public', intent: 'x', scenarios: [] },
      ],
    };
    const tests = [
      testCase({
        id: 'tst_x',
        title: '[REQ:pli_x] Home loads — positive: renders the heading',
        reqTag: null,
      }),
      testCase({
        id: 'tst_y',
        title: '[REQ:pli_y] Checkout works — positive: completes checkout',
        reqTag: null,
      }),
    ];

    expect(matchGenerationGaps(reqTaglessPlan, tests)).toEqual([]);
  });

  it('returns nothing when the plan has no items', () => {
    expect(matchGenerationGaps({ summary: 'plan', items: [] }, [])).toEqual([]);
  });

  it('treats a registered-but-never-executed row (still pending) as a candidate too', () => {
    // A run that errors out mid-EXECUTE (a crash on a later tier, a systemic
    // provider outage) never reaches index.ts's deleteUnexecutedTests
    // cleanup, so a test row that WAS generated/registered but never got a
    // result stays at its initial 'pending' status forever. Retry-pass must
    // catch this too, not just a fully-missing row.
    const tests = [
      testCase({ id: 'tst_a', title: '[REQ:REQ-A] Home loads', reqTag: 'REQ-A', status: 'passed' }),
      testCase({ id: 'tst_b', title: '[REQ:REQ-B] Checkout works', reqTag: 'REQ-B', status: 'pending' }),
      // REQ-C has no test row at all — a genuine generation gap, alongside the pending one.
    ];
    const gaps = matchGenerationGaps(PLAN, tests);
    expect(gaps.map((g) => g.id).sort()).toEqual(['pli_b', 'pli_c']);
  });

  it('is NOT a candidate when at least one scenario row for the item actually executed', () => {
    // A multi-scenario item's rows all share the same reqTag — if even one
    // of them got a real result, generation+at-least-partial-execution
    // genuinely happened for this item, so it's not a gap.
    const tests = [
      testCase({ id: 'tst_a', title: '[REQ:REQ-A] Home loads', reqTag: 'REQ-A', status: 'passed' }),
      testCase({ id: 'tst_b1', title: '[REQ:REQ-B] scenario 1', reqTag: 'REQ-B', status: 'passed' }),
      testCase({ id: 'tst_b2', title: '[REQ:REQ-B] scenario 2', reqTag: 'REQ-B', status: 'pending' }),
      testCase({ id: 'tst_c', title: '[REQ:REQ-C] Settings works', reqTag: 'REQ-C', status: 'passed' }),
    ];
    expect(matchGenerationGaps(PLAN, tests)).toEqual([]);
  });

  it('a genuinely skipped (real Playwright outcome) row is NOT a candidate — only never-executed is', () => {
    const tests = [
      testCase({ id: 'tst_a', title: '[REQ:REQ-A] Home loads', reqTag: 'REQ-A', status: 'skipped' }),
      testCase({ id: 'tst_b', title: '[REQ:REQ-B] Checkout works', reqTag: 'REQ-B', status: 'passed' }),
      testCase({ id: 'tst_c', title: '[REQ:REQ-C] Settings works', reqTag: 'REQ-C', status: 'passed' }),
    ];
    expect(matchGenerationGaps(PLAN, tests)).toEqual([]);
  });
});
