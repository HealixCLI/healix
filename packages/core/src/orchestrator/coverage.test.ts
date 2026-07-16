import { describe, expect, it } from 'vitest';
import { computeCoverage, mergeExecOutcomes } from './coverage.js';
import type { ExecOutcome, GeneratedSpec, TestPlanItem } from '../modes/types.js';
import type { FunctionalityUnit } from '../target/functionality-index.js';

function unit(key: string): FunctionalityUnit {
  return { key, kind: 'route', label: key, file: 'src/app.tsx' };
}

function item(overrides: Partial<TestPlanItem> & { id: string }): TestPlanItem {
  return {
    title: overrides.title ?? 'item',
    tier: 'tierA-public',
    intent: 'intent',
    scenarios: [{ kind: 'positive', description: 'positive case' }],
    ...overrides,
  };
}

function spec(overrides: Partial<GeneratedSpec>): GeneratedSpec {
  return {
    path: '/tmp/spec.ts',
    title: overrides.title ?? 'spec',
    tier: 'tierA-public',
    contents: '',
    ...overrides,
  };
}

function outcome(results: ExecOutcome['results']): ExecOutcome {
  return {
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    blocked: results.filter((r) => r.status === 'blocked').length,
    flaky: results.filter((r) => r.status === 'flaky').length,
    results,
  };
}

describe('computeCoverage', () => {
  it('returns full coverage when there are no functionality units to measure against', () => {
    const result = computeCoverage([], [], [], outcome([]));
    expect(result.ratio).toBe(1);
    expect(result.uncovered).toEqual([]);
  });

  it('counts a unit as covered when its plan item has a matching passing scenario result', () => {
    const units = [unit('route:/'), unit('route:/checkout')];
    const items = [
      item({ id: 'i1', reqTag: 'REQ-1', unitKey: 'route:/' }),
      item({ id: 'i2', reqTag: 'REQ-2', unitKey: 'route:/checkout' }),
    ];
    const specs = [
      spec({ title: '[REQ:REQ-1] Home', reqTag: 'REQ-1' }),
      spec({ title: '[REQ:REQ-2] Checkout', reqTag: 'REQ-2' }),
    ];
    const exec = outcome([
      { title: '[REQ:REQ-1] positive: loads', status: 'passed' },
      { title: '[REQ:REQ-2] positive: completes', status: 'failed' },
    ]);

    const result = computeCoverage(units, items, specs, exec);

    expect(result.coveredUnitKeys.has('route:/')).toBe(true);
    expect(result.coveredUnitKeys.has('route:/checkout')).toBe(false);
    expect(result.ratio).toBe(0.5);
    expect(result.uncovered.map((u) => u.key)).toEqual(['route:/checkout']);
  });

  it('treats a flaky result as covered, same as passed', () => {
    const units = [unit('route:/')];
    const items = [item({ id: 'i1', reqTag: 'REQ-1', unitKey: 'route:/' })];
    const specs = [spec({ title: '[REQ:REQ-1] Home', reqTag: 'REQ-1' })];
    const exec = outcome([{ title: '[REQ:REQ-1] positive: loads', status: 'flaky' }]);

    const result = computeCoverage(units, items, specs, exec);
    expect(result.ratio).toBe(1);
  });

  it('does not count items with no unitKey toward coverage', () => {
    const units = [unit('route:/')];
    const items = [item({ id: 'i1', reqTag: 'REQ-1' })]; // no unitKey
    const specs = [spec({ title: '[REQ:REQ-1] Home', reqTag: 'REQ-1' })];
    const exec = outcome([{ title: '[REQ:REQ-1] positive: loads', status: 'passed' }]);

    const result = computeCoverage(units, items, specs, exec);
    expect(result.ratio).toBe(0);
    expect(result.uncovered).toEqual(units);
  });

  it('does not count a unit covered when no scenario result passed for its spec', () => {
    const units = [unit('route:/')];
    const items = [item({ id: 'i1', reqTag: 'REQ-1', unitKey: 'route:/' })];
    const specs = [spec({ title: '[REQ:REQ-1] Home', reqTag: 'REQ-1' })];
    const exec = outcome([{ title: '[REQ:REQ-1] positive: loads', status: 'failed' }]);

    const result = computeCoverage(units, items, specs, exec);
    expect(result.ratio).toBe(0);
  });
});

describe('mergeExecOutcomes', () => {
  it('sums counters and concatenates results in order', () => {
    const a = outcome([{ title: 'a', status: 'passed' }]);
    const b = outcome([
      { title: 'b', status: 'failed' },
      { title: 'c', status: 'passed' },
    ]);

    const merged = mergeExecOutcomes(a, b);

    expect(merged.passed).toBe(2);
    expect(merged.failed).toBe(1);
    expect(merged.results.map((r) => r.title)).toEqual(['a', 'b', 'c']);
  });
});
