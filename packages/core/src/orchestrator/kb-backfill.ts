import type { KbItemStatus, KbScenarioStatus, TestCase, TestResult } from '../storage/types.js';
import type { TestPlan } from '../modes/types.js';

/** One item's worth of backfilled KB rows, ready to hand to HealixStore.seedPlanKbItem. */
export interface KbBackfillItemRow {
  planItemId: string;
  title: string;
  reqTag: string | null;
  tier: string | null;
  status: KbItemStatus;
  scenarios: Array<{
    index: number;
    kind: string;
    description: string;
    status: KbScenarioStatus;
    testId: string | null;
  }>;
}

/**
 * Recover the same-run item linkage a generated test's title always carries —
 * every generated test's title starts with `[REQ:<tag>]`, where `<tag>` is
 * `item.reqTag ?? item.id` (see generate.ts's buildPrompt/generateOne and
 * index.ts's registerSpecRows). Mirrors
 * apps/desktop/src/main/repair-candidates.ts's extractRunLocalKey exactly —
 * duplicated here (not imported) because core cannot depend on the desktop
 * app; keep the two in sync if the title convention ever changes.
 */
function extractRunLocalKey(test: TestCase): string | null {
  if (test.reqTag) return test.reqTag;
  const m = test.title.match(/\[REQ:([^\]]+)\]/i);
  const tag = m?.[1]?.trim();
  return tag && tag.length > 0 ? tag : null;
}

/**
 * Reconstruct what the two-tier Knowledge Base would have recorded for a run
 * that predates it, by diffing `plan.json` against the run's persisted
 * `tests`/`results` rows — the same "did this item get a matching, executed
 * test row" logic `matchGenerationGaps` uses for its gap-detection, but
 * walking every item/scenario (not just the gaps) so already-generated,
 * already-executed scenarios get seeded with their REAL status too, not just
 * `dropped`/`pending`.
 *
 * Best-effort by nature: `tests` rows carry no explicit scenario-order
 * column, so a plan item's Nth scenario is matched to its Nth same-reqTag
 * test row in `tests` array order — correct as long as `listTests` returns
 * rows in insertion order (SQLite's default for an unmodified rowid table,
 * which is how registerSpecRows originally inserted them: one row per
 * scenario, in `item.scenarios` order). A run whose rows were reordered by
 * some other means would backfill with mismatched scenario detail (kind/
 * description) but never wrong test IDs or statuses, since testId/status
 * always travel together from the same matched row.
 */
export function computeKbBackfillRows(
  plan: TestPlan,
  tests: TestCase[],
  results: TestResult[],
): KbBackfillItemRow[] {
  const resultByTestId = new Map(results.map((r) => [r.testId, r]));
  const testsByKey = new Map<string, TestCase[]>();
  for (const t of tests) {
    const key = extractRunLocalKey(t);
    if (!key) continue;
    const list = testsByKey.get(key);
    if (list) list.push(t);
    else testsByKey.set(key, [t]);
  }

  return plan.items.map((item) => {
    const key = item.reqTag ?? item.id;
    const matches = testsByKey.get(key) ?? [];
    const generated = matches.length > 0;
    const scenarios = item.scenarios.map((s, i) => {
      const match = matches[i];
      let status: KbScenarioStatus;
      if (!match) {
        status = 'dropped';
      } else {
        const result = resultByTestId.get(match.id);
        // A matched test row with no result yet is exactly the KB's own
        // default 'pending' — this scenario was generated but never executed.
        status = result ? result.status : 'pending';
      }
      return { index: i, kind: s.kind, description: s.description, status, testId: match?.id ?? null };
    });
    return {
      planItemId: item.id,
      title: item.title,
      reqTag: item.reqTag ?? null,
      tier: item.tier,
      status: generated ? 'generated' : 'dropped',
      scenarios,
    };
  });
}
