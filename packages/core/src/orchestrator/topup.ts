import type { TestPlanItem } from '../modes/types.js';
import type { TestCase } from '../storage/types.js';

/**
 * A generated test's PERSISTED title is never byte-identical to its plan
 * item's own raw title — generate.ts/orchestrator's registerSpecRows always
 * decorate it with a leading `[REQ:<tag>]` marker and, for a multi-scenario
 * item, a trailing ` — <kind>: <description>` suffix (see index.ts's
 * registerSpecRows). Both decorations are entirely our own, deterministic
 * formatting (not AI-authored free text), so they can be reliably stripped
 * back off to recover the plan item's raw title for cross-run comparison.
 * A no-op on an already-raw plan item title (neither pattern can appear in
 * one), so it's safe to apply unconditionally wherever a title is compared.
 */
function stripGeneratedTitleDecoration(title: string): string {
  return title.replace(/^\[REQ:[^\]]*\]\s*/i, '').replace(/\s+—\s+(positive|negative|edge):.*$/i, '');
}

/** Stable identity across runs: reqTag when present, else normalized title. Exact match only — no fuzzy matching. */
export function computeIdentityKey(reqTag: string | null | undefined, title: string): string {
  const tag = reqTag?.trim();
  if (tag) return `req:${tag}`;
  return `title:${stripGeneratedTitleDecoration(title).trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export interface SuiteDiff {
  /** Plan items with no matching test (of any status) in the base run — these need AI generation. */
  toGenerate: TestPlanItem[];
  /** Every test from the base run, carried forward unconditionally, regardless of status. */
  carried: TestCase[];
}

/**
 * Top-up diff: every test from the base run comes along for the ride
 * unconditionally — passed, failed, blocked, or flaky alike, so top-up
 * reproduces the base run's exact test count plus whatever's newly generated
 * on top. A plan item only needs a fresh AI generation when no carried test
 * already covers its identity key — i.e. it's new/missing functionality;
 * an existing test's prior status is never a reason to regenerate it.
 *
 * `forceRegenerate` is the escape hatch Repair (and, degenerately, Retry-pass)
 * need from that last rule: a Repair-targeted item, by definition, already HAS
 * a covering test — that's the whole precondition for a `test_is_wrong`
 * verdict to exist — so without this override it would always be classified
 * "already covered" and silently carried forward unchanged, never actually
 * regenerated. Any plan item whose id is in `forceRegenerate` is forced into
 * `toGenerate` regardless of coverage, and its own identity-matching base
 * test(s) are excluded from `carried` so the fresh replacement doesn't ride
 * alongside the stale one it's meant to replace.
 */
export function diffAgainstBase(
  planItems: TestPlanItem[],
  baseTests: TestCase[],
  forceRegenerate?: ReadonlySet<string>,
): SuiteDiff {
  const coveredKeys = new Set(baseTests.map((t) => computeIdentityKey(t.reqTag, t.title)));
  const toGenerate = planItems.filter(
    (item) => forceRegenerate?.has(item.id) || !coveredKeys.has(computeIdentityKey(item.reqTag, item.title)),
  );

  if (!forceRegenerate || forceRegenerate.size === 0) {
    return { toGenerate, carried: baseTests };
  }
  const forcedKeys = new Set(
    planItems
      .filter((item) => forceRegenerate.has(item.id))
      .map((item) => computeIdentityKey(item.reqTag, item.title)),
  );
  const carried = baseTests.filter((t) => !forcedKeys.has(computeIdentityKey(t.reqTag, t.title)));
  return { toGenerate, carried };
}
