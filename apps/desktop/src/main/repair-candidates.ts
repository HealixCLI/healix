import type { TestCase, TestPlan } from '@healix/core';

/** A base-run plan item whose spec never got generated (Retry-pass) or whose test was triaged test_is_wrong (Repair) — a regeneration candidate. */
export interface GenerationGapItem {
  id: string;
  title: string;
  tier: string;
  reqTag?: string;
}

/**
 * Recover the SAME-run item linkage a generated test's title always carries,
 * regardless of what ends up persisted in its `reqTag` column: every
 * generated test's title starts with `[REQ:<tag>]`, where `<tag>` is
 * `item.reqTag ?? item.id` (see generate.ts's buildPrompt/generateOne and
 * orchestrator/index.ts's registerSpecRows). For a project whose plan items
 * have no real reqTag, the persisted `reqTag` column is correctly `null`
 * (see registerSpecRows) — but the title's embedded tag still carries the
 * item's own id, which is exactly the stable, same-run-only key these
 * matchers need. Cross-run identity (a DIFFERENT problem — matching against
 * a separate prior run's independently-planned items, where ids never carry
 * over) is topup.ts's diffAgainstBase/computeIdentityKey's job, not this.
 */
function extractRunLocalKey(test: TestCase): string | null {
  if (test.reqTag) return test.reqTag;
  const m = test.title.match(/\[REQ:([^\]]+)\]/i);
  const tag = m?.[1]?.trim();
  return tag && tag.length > 0 ? tag : null;
}

/**
 * Pure matching logic behind runs:repairCandidates, kept in its own module
 * (no Electron import) so it's unit-testable without an ipcMain/Electron
 * harness. Plan items whose test was triaged 'test_is_wrong' (see storage's
 * triage_results table) — the test itself is the problem, not the app, so
 * regenerating it (rather than just re-running it) is the fix.
 */
export function matchRepairCandidates(
  plan: TestPlan,
  tests: TestCase[],
  wrongTestIds: ReadonlySet<string>,
): GenerationGapItem[] {
  const testsById = new Map(tests.map((t) => [t.id, t]));
  const planItemByReqTag = new Map(plan.items.map((it) => [it.reqTag ?? it.id, it]));

  const seen = new Set<string>();
  const candidates: GenerationGapItem[] = [];
  for (const testId of wrongTestIds) {
    const test = testsById.get(testId);
    if (!test) continue;
    const key = extractRunLocalKey(test);
    if (!key) continue;
    const item = planItemByReqTag.get(key);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    candidates.push({ id: item.id, title: item.title, tier: item.tier, reqTag: item.reqTag });
  }
  return candidates;
}

/**
 * Pure matching logic behind runs:generationGaps, kept in its own module for
 * the same reason as matchRepairCandidates above. A plan item qualifies for
 * Retry-pass when EITHER:
 *  - it never got a matching test row at all — generation was requested but
 *    silently dropped after a failed attempt (see orchestrator's
 *    generationStats/trackGeneration); or
 *  - every one of its test rows is still 'pending' — a spec WAS generated and
 *    registered, but EXECUTE never produced a result for it. This happens
 *    when a run errors out mid-EXECUTE (a crash on a later tier, a systemic
 *    provider outage) before reaching index.ts's deleteUnexecutedTests
 *    cleanup, which only runs on EXECUTE's happy path — those rows are left
 *    behind at their initial 'pending' status forever otherwise. A test row
 *    only ever leaves 'pending' via store.updateTestStatus, called
 *    exclusively from persistResults once a real execution result exists for
 *    it (see index.ts) — so 'pending' reliably means "never actually ran".
 * A row that genuinely executed and came back e.g. 'skipped' (the suite
 * itself decided not to run it, a real Playwright outcome) is NOT a
 * candidate — only a row that never got a chance to execute at all is.
 */
export function matchGenerationGaps(plan: TestPlan, tests: TestCase[]): GenerationGapItem[] {
  const testsByKey = new Map<string, TestCase[]>();
  for (const t of tests) {
    const key = extractRunLocalKey(t);
    if (!key) continue;
    const list = testsByKey.get(key);
    if (list) list.push(t);
    else testsByKey.set(key, [t]);
  }
  return plan.items
    .filter((it) => {
      const matches = testsByKey.get(it.reqTag ?? it.id);
      return !matches || matches.every((t) => t.status === 'pending');
    })
    .map((it) => ({ id: it.id, title: it.title, tier: it.tier, reqTag: it.reqTag }));
}
