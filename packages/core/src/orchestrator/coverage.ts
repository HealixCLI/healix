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

/** Merge two ExecOutcome objects (base pass/fail/blocked/flaky counts plus concatenated results). */
export function mergeExecOutcomes(a: ExecOutcome, b: ExecOutcome): ExecOutcome {
  return {
    passed: a.passed + b.passed,
    failed: a.failed + b.failed,
    blocked: a.blocked + b.blocked,
    flaky: a.flaky + b.flaky,
    results: [...a.results, ...b.results],
  };
}
