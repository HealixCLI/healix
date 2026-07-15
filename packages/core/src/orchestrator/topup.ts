import type { TestPlanItem } from '../modes/types.js';
import type { TestCase } from '../storage/types.js';

/** Stable identity across runs: reqTag when present, else normalized title. Exact match only — no fuzzy matching. */
export function computeIdentityKey(reqTag: string | null | undefined, title: string): string {
  const tag = reqTag?.trim();
  if (tag) return `req:${tag}`;
  return `title:${title.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export interface SuiteDiff {
  /** Plan items with no matching passing test in the base run — these need AI generation. */
  toGenerate: TestPlanItem[];
  /** Every passing test from the base run, carried forward unconditionally. */
  carried: TestCase[];
}

/**
 * Top-up diff: the base run's passing tests all come along for the ride
 * unconditionally (nothing that already passed is thrown away), and a plan
 * item only needs a fresh AI generation when no carried test already covers
 * its identity key — i.e. it's new/missing functionality.
 */
export function diffAgainstBase(planItems: TestPlanItem[], basePassingTests: TestCase[]): SuiteDiff {
  const coveredKeys = new Set(basePassingTests.map((t) => computeIdentityKey(t.reqTag, t.title)));
  const toGenerate = planItems.filter((item) => !coveredKeys.has(computeIdentityKey(item.reqTag, item.title)));
  return { toGenerate, carried: basePassingTests };
}
