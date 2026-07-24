import { describe, expect, it } from 'vitest';
import { computeIdentityKey, diffAgainstBase } from './topup.js';
import type { TestPlanItem } from '../modes/types.js';
import type { TestCase } from '../storage/types.js';

function planItem(overrides: Partial<TestPlanItem> & Pick<TestPlanItem, 'id' | 'title'>): TestPlanItem {
  return { tier: 'tierA-public', intent: 'x', scenarios: [], ...overrides };
}

function testCase(overrides: Partial<TestCase> & Pick<TestCase, 'id' | 'title'>): TestCase {
  return {
    runId: 'run_1',
    reqTag: null,
    tier: null,
    status: 'passed',
    specPath: 'a.spec.ts',
    specCode: null,
    description: null,
    details: null,
    ...overrides,
  };
}

describe('computeIdentityKey', () => {
  it('prioritizes reqTag when present, regardless of title', () => {
    expect(computeIdentityKey('REQ-1', 'Anything')).toBe(computeIdentityKey('REQ-1', 'Something else'));
  });

  it('falls back to normalized title when reqTag is absent', () => {
    expect(computeIdentityKey(null, 'Home Loads')).toBe(computeIdentityKey(undefined, 'home   loads'));
  });

  it('strips a generated test title\'s "[REQ:...]" prefix before falling back to title matching', () => {
    // A generated (single-scenario or carried-forward) test's title is
    // decorated with `[REQ:<tag>] ` by registerSpecRows/generate.ts, never
    // byte-identical to the plan item's own raw title.
    expect(computeIdentityKey(null, '[REQ:pli_abc123] Home loads')).toBe(
      computeIdentityKey(null, 'Home loads'),
    );
  });

  it('strips a multi-scenario test title\'s " — <kind>: <description>" suffix too', () => {
    expect(computeIdentityKey(null, '[REQ:pli_abc123] Home loads — positive: renders the heading')).toBe(
      computeIdentityKey(null, 'Home loads'),
    );
    expect(computeIdentityKey(null, 'Checkout works — negative: rejects an expired card')).toBe(
      computeIdentityKey(null, 'Checkout works'),
    );
  });

  it('is a no-op for a title that never had generated decoration', () => {
    expect(computeIdentityKey(null, 'Home loads')).toBe('title:home loads');
  });
});

describe('diffAgainstBase (reqTag-less plan items)', () => {
  it('recognizes a reqTag-less item as already covered by a base test whose title carries the generated decoration', () => {
    const planItems = [
      planItem({ id: 'pli_new1', title: 'Home loads' }),
      planItem({ id: 'pli_new2', title: 'Checkout works' }),
    ];
    const baseTests = [
      testCase({ id: 'tst_1', title: '[REQ:pli_old1] Home loads — positive: renders the heading' }),
      testCase({ id: 'tst_2', title: '[REQ:pli_old2] Checkout works — positive: completes checkout' }),
    ];

    const diff = diffAgainstBase(planItems, baseTests);

    expect(diff.toGenerate).toHaveLength(0);
    expect(diff.carried).toEqual(baseTests);
  });

  it('still detects a genuinely new reqTag-less item alongside an already-covered one', () => {
    const planItems = [
      planItem({ id: 'pli_new1', title: 'Home loads' }),
      planItem({ id: 'pli_new2', title: 'Settings page' }),
    ];
    const baseTests = [testCase({ id: 'tst_1', title: '[REQ:pli_old1] Home loads — positive: renders' })];

    const diff = diffAgainstBase(planItems, baseTests);

    expect(diff.toGenerate.map((it) => it.id)).toEqual(['pli_new2']);
  });
});
