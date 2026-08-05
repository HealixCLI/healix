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
    skipped: results.filter((r) => r.status === 'skipped').length,
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

  it('DUPLICATE-TIER GUARD: a title present in both merge inputs counts once, keeping the later result', () => {
    // Simulates a tier re-executed after a resume that raced the checkpoint
    // write: the same test appears in both the earlier (stale) and later
    // (authoritative) outcome. Without dedup this would double-count it in
    // both the total and the per-status tallies (the report.html vs Results
    // tab mismatch this test guards against).
    const a = outcome([
      { title: '[REQ:REQ-1] positive: loads', status: 'failed' },
      { title: '[REQ:REQ-2] positive: loads', status: 'passed' },
    ]);
    const b = outcome([{ title: '[REQ:REQ-1] positive: loads', status: 'passed' }]);

    const merged = mergeExecOutcomes(a, b);

    expect(merged.results).toHaveLength(2);
    expect(merged.passed).toBe(2);
    expect(merged.failed).toBe(0);
    expect(merged.results.find((r) => r.title.includes('REQ-1'))?.status).toBe('passed');
  });

  it('DISTINCT-SPEC-FILE GUARD: two different specs with coincidentally identical titles both count', () => {
    // Two separate gap-fill iterations can each generate a scenario with the
    // exact same wording for the same requirement — genuinely distinct tests
    // (different spec files, both persisted as separate DB rows), not a
    // re-execution of one test. Without specFile, title-only matching
    // collapsed these into one, undercounting the report relative to the
    // Results tab (which has no such collision, since it keys DB rows by
    // reqTag+position rather than title).
    const a = outcome([
      { title: '[REQ:REQ-1] positive: succeeds with valid input', status: 'passed', specFile: 'spec-a.ts' },
    ]);
    const b = outcome([
      { title: '[REQ:REQ-1] positive: succeeds with valid input', status: 'passed', specFile: 'spec-b.ts' },
    ]);

    const merged = mergeExecOutcomes(a, b);

    expect(merged.results).toHaveLength(2);
    expect(merged.passed).toBe(2);
  });

  it('re-execution of the SAME spec file still dedupes (resume-replay case)', () => {
    const a = outcome([{ title: '[REQ:REQ-1] positive: loads', status: 'failed', specFile: 'spec-a.ts' }]);
    const b = outcome([{ title: '[REQ:REQ-1] positive: loads', status: 'passed', specFile: 'spec-a.ts' }]);

    const merged = mergeExecOutcomes(a, b);

    expect(merged.results).toHaveLength(1);
    expect(merged.results[0]?.status).toBe('passed');
  });

  it('F-24: carries skipped counts forward across a merge, recomputed from the deduplicated results like every other counter', () => {
    const a = outcome([
      { title: 'a', status: 'skipped' },
      { title: 'b', status: 'passed' },
    ]);
    const b = outcome([{ title: 'c', status: 'skipped' }]);

    const merged = mergeExecOutcomes(a, b);

    expect(merged.skipped).toBe(2);
    expect(merged.passed).toBe(1);
  });

  it('F-15: sums mockedRequestCounts across a merge instead of one side silently replacing the other', () => {
    const a: ExecOutcome = { ...outcome([]), mockedRequestCounts: { 'pkg:twilio': 2, 'env:API': 1 } };
    const b: ExecOutcome = { ...outcome([]), mockedRequestCounts: { 'pkg:twilio': 1 } };

    const merged = mergeExecOutcomes(a, b);

    expect(merged.mockedRequestCounts).toEqual({ 'pkg:twilio': 3, 'env:API': 1 });
  });

  it('F-15: omits mockedRequestCounts entirely when neither side has any (no empty-object noise)', () => {
    const merged = mergeExecOutcomes(outcome([]), outcome([]));
    expect(merged.mockedRequestCounts).toBeUndefined();
  });

  it('unions apiEvidence across a merge, with b (the later iteration) winning a key collision', () => {
    const a: ExecOutcome = {
      ...outcome([]),
      apiEvidence: { 'f#a': 'A-only evidence', 'f#shared': 'stale evidence from iteration A' },
    };
    const b: ExecOutcome = {
      ...outcome([]),
      apiEvidence: { 'f#b': 'B-only evidence', 'f#shared': 'fresh evidence from iteration B' },
    };

    const merged = mergeExecOutcomes(a, b);

    expect(merged.apiEvidence).toEqual({
      'f#a': 'A-only evidence',
      'f#b': 'B-only evidence',
      'f#shared': 'fresh evidence from iteration B',
    });
  });

  it('omits apiEvidence entirely when neither side has any (no empty-object noise)', () => {
    const merged = mergeExecOutcomes(outcome([]), outcome([]));
    expect(merged.apiEvidence).toBeUndefined();
  });
});
