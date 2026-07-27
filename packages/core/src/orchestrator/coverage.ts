import type { ExecOutcome, GeneratedSpec, TestPlanItem } from '../modes/types.js';
import type { FunctionalityUnit } from '../target/functionality-index.js';

/** Fresh-suite runs target >80% coverage of detected functionality units. */
export const FRESH_COVERAGE_TARGET = 0.8;
/** Top-up runs aim to close out remaining gaps in an existing suite, near-100%. */
export const TOPUP_COVERAGE_TARGET = 0.98;
/** Hard cap on gap-fill iterations, regardless of target — bounds cost/time; a run that
 * can't converge stops and says so rather than looping indefinitely. */
export const COVERAGE_MAX_ITERATIONS = 4;

export interface CoverageResult {
  coveredUnitKeys: Set<string>;
  ratio: number;
  uncovered: FunctionalityUnit[];
}

/** Normalize a test/result title for substring-independent equality comparison. */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

const PASSING_STATUSES = new Set(['passed', 'flaky']);

/**
 * Compute how much of the detected functionality inventory has at least one
 * passing (or flaky) scenario test. A unit counts as covered when:
 *   1. some plan item targets it via `unitKey`, AND
 *   2. that item's generated spec (matched by reqTag) produced at least one
 *      execution result with a passing/flaky status.
 *
 * Best-effort by design: items without a `unitKey` (e.g. hand-edited items, or
 * items from a plan that wasn't grounded on a functionality inventory) simply
 * can't contribute to coverage — they neither help nor hurt the ratio.
 */
export function computeCoverage(
  units: FunctionalityUnit[],
  planItems: TestPlanItem[],
  specs: GeneratedSpec[],
  outcome: ExecOutcome,
): CoverageResult {
  if (units.length === 0) {
    return { coveredUnitKeys: new Set(), ratio: 1, uncovered: [] };
  }

  const passingResultTitles = new Set(
    outcome.results.filter((r) => PASSING_STATUSES.has(r.status)).map((r) => normalizeTitle(r.title)),
  );

  const coveredUnitKeys = new Set<string>();
  for (const item of planItems) {
    if (!item.unitKey) continue;
    if (coveredUnitKeys.has(item.unitKey)) continue;

    const reqTag = item.reqTag ?? item.id;
    const spec = specs.find((s) => (s.reqTag ?? '').trim() === reqTag);
    if (!spec) continue;

    // Every scenario test's title is required (see generate.ts) to start with
    // the same "[REQ:<tag>]" marker as the spec, so a substring match against
    // any passing result title is sufficient to know at least one scenario
    // under this feature passed.
    const specTagMarker = `[req:${reqTag.toLowerCase()}]`;
    const hasPassingScenario = [...passingResultTitles].some((t) => t.includes(specTagMarker));
    if (hasPassingScenario) coveredUnitKeys.add(item.unitKey);
  }

  const uncovered = units.filter((u) => !coveredUnitKeys.has(u.key));
  const ratio = (units.length - uncovered.length) / units.length;
  return { coveredUnitKeys, ratio, uncovered };
}

/**
 * Identity used to detect a genuine re-execution of the SAME test across two
 * merged outcomes: specFile + normalized title when the result carries a
 * specFile (the common case — see execute.ts's parseReport), or just the
 * normalized title when it doesn't (synthetic/fallback items with no real
 * spec file to key on). Scoping by specFile as well as title matters because
 * two DIFFERENT generated scenarios (e.g. from separate gap-fill iterations)
 * can coincidentally share near-identical wording despite living in distinct
 * spec files — title-only matching mistook those for the same test and
 * silently dropped one, undercounting the report relative to the DB (which
 * has no such collision since it keys rows by reqTag+position, not title).
 */
function mergeIdentity(r: ExecOutcome['results'][number]): string {
  const title = normalizeTitle(r.title);
  return r.specFile ? `file:${r.specFile}#${title}` : `title:${title}`;
}

/**
 * Merge two ExecOutcome objects. Deduplicates by mergeIdentity, keeping `b`'s
 * result on a collision — a test executed in both `a` and `b` (e.g. a tier
 * re-executed after a resume that raced the checkpoint write, see
 * insertResult's doc comment) must count once, with its latest outcome, not
 * twice. Counters are recomputed from the deduplicated results rather than
 * summed, so passed/failed/blocked/flaky can never drift out of sync with
 * `results.length` the way plain addition would if an identity collided.
 */
export function mergeExecOutcomes(a: ExecOutcome, b: ExecOutcome): ExecOutcome {
  const byIdentity = new Map<string, ExecOutcome['results'][number]>();
  for (const r of a.results) byIdentity.set(mergeIdentity(r), r);
  for (const r of b.results) byIdentity.set(mergeIdentity(r), r);
  const results = [...byIdentity.values()];
  return {
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    blocked: results.filter((r) => r.status === 'blocked').length,
    flaky: results.filter((r) => r.status === 'flaky').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  };
}
