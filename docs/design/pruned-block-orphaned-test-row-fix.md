# Fix: pruning a low-quality test() block leaves its DB row orphaned at 'pending' forever

## Bug report

Comparing a fresh run's own report against a reuse run copied from it (same project,
same underlying test results), the fresh run's `Total` tile (22) didn't match the reuse
run's `Total` tile (19), producing a misleading "pass rate dropped" signal even though
both runs' actual `report.json` outcome (`passed: 13, failed: 5, blocked: 0, flaky: 1,
skipped: 1`) was byte-identical. Querying the DB directly confirmed the 3 "missing" rows
in the fresh run are sitting at `status: 'pending'` forever — they exactly match the
scenario titles GENERATE's own validate step pruned out of otherwise-accepted specs:

```
[validate] Pruned 1 low-quality test block(s) from "Switch between Login and Register modes" and kept the rest
[validate] Pruned 2 low-quality test block(s) from "Delete a todo" and kept the rest
```

## Root cause

Confirmed by tracing the full lifecycle end to end:

1. **Pruning happens in `packages/core/src/modes/playwright/validate.ts`**, not
   `generate.ts` — `auditAndMaybePrune` (174-221) calls `pruneHardFindings`
   (`quality-audit.ts:466-484`), which splices each hard-finding's `blockRange` out of
   the source text and returns a new, shorter spec `contents` string. Nothing about
   _how many_ blocks survived, or _which_ plan scenario each survivor corresponds to,
   is threaded back to the caller beyond the final `contents` string itself.

2. **DB row registration is plan-driven, not content-driven.** `registerSpecRows`
   (`orchestrator/index.ts:3880-3989`) inserts exactly `item.scenarios.length` rows —
   one per `PlanScenario` from the **plan** (decided before generation ever ran),
   regardless of how many `test()` blocks the spec's _actual, post-prune_ content
   contains:

   ```ts
   item.scenarios.forEach((s, i) => {
     const test = store.insertTest({ ..., title: `${spec.title} — ${s.kind}: ${s.description}`, status: 'pending', ... });
     testIdByKey.set(`${base}#${i}`, test.id);
     ...
   });
   ```

3. **The call order already has pruning complete before registration runs** —
   `validate()` (and its pruning) executes at `index.ts:2585`, its pruned `contents`
   already flows into `newSpecs`/`carriedSpecs` via `contentsByPath` at
   `index.ts:2652-2660`, and `registerSpecRows` isn't called until `index.ts:2668-2671`,
   well after. So `spec.contents` at registration time is already the correct,
   post-prune content — `registerSpecRows` just never looks at it to decide how many
   rows to create.

4. **No reliable way to match a pruned block back to "its" row by title.** At prune
   time, no DB row exists yet (registration hasn't run). Even after registration, row
   titles are synthesized from the plan's free-text `PlanScenario.description`
   (`index.ts:3968`), while a pruned block's own identity
   (`QualityFinding.testTitle`/`TestBlock.title`) is the model-authored literal string
   passed to `test(...)` in generated code — the two have no guaranteed string
   relationship. The only reliable correspondence is **positional**:
   `registerSpecRows`'s own doc comment states the invariant it already depends on —
   _"generate.ts requires scenarios to be emitted as one test() each, in the same order
   they were planned"_ (`index.ts:3876-3878`).

5. **A related, more subtle symptom**: `persistResults` (`index.ts:3999+`) matches
   results back to registered rows **positionally, in encounter order** within a
   reqTag — not by title. If a _non-trailing_ scenario gets pruned (e.g. scenario `s1`
   of `[s0, s1, s2]`), the two real results for `s0`/`s2` get assigned encounter-order
   slots `#0`/`#1` — i.e. `s2`'s real result silently lands in `s1`'s (the pruned
   scenario's) row, and whichever row the shift pushes past the last real result ends
   up the one left permanently orphaned instead. `deleteUnexecutedTests`
   (`store.ts:642-647` — already exists, already wired in at `index.ts:674` and
   `index.ts:2937`) only removes a row with **zero** results, so this shifted case can
   still leave a _different_ row than the pruned one stuck at `pending`, while the
   _displayed_ description text for a scenario slot can point at the wrong plan
   scenario. Both symptoms trace to the same root cause: registered row count is
   decoupled from actual surviving-block count.

## Fix

**Register rows from the actual, post-prune content — not from pre-pruning plan
expectations.** No pipeline reordering needed (registration already runs after
pruning); `registerSpecRows` just needs to know how many real, executable scenarios
the final `spec.contents` actually contains, and cap registration to that count.

Counting "real test() blocks in this content" is inherently mode-specific (Playwright's
`test()`/`test.only()`/etc. shape) — `orchestrator/index.ts` is deliberately
mode-agnostic today (confirmed: it has zero imports from `modes/playwright/*`,
interacting with a mode purely through the `TestMode` interface). Importing
`quality-audit.ts`'s `splitTestBlocks` directly into the orchestrator would bake
Playwright-specific parsing into mode-agnostic code — the wrong layer for this,
especially with a second mode (Selenium, per ADR 0011) on the roadmap.

### 1. New optional `TestMode` capability — `packages/core/src/modes/types.ts`

```ts
export interface TestMode {
  readonly id: ModeId;
  scaffold(ctx: TestModeContext): Promise<void>;
  generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]>;
  validate?(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ValidationResult>;
  /**
   * Counts the real, executable test cases present in a spec's CURRENT (possibly
   * pruned) contents — used by registerSpecRows to cap DB row registration to what
   * actually exists, instead of blindly trusting the plan's original scenario count
   * (see docs/design/pruned-block-orphaned-test-row-fix.md). Optional: a mode without
   * one falls back to today's plan-driven count unchanged — never a behavior change
   * for a mode that doesn't implement it.
   */
  countScenarios?(contents: string): number;
  execute(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome>;
  collectArtifacts(ctx: TestModeContext): Promise<{ dir: string; files: string[] }>;
  export(ctx: TestModeContext): Promise<SuiteBundle>;
}
```

### 2. Implement it for Playwright — `packages/core/src/modes/playwright/index.ts`

Reuses `splitTestBlocks` (already exported from `quality-audit.ts`, already the exact
primitive both `validate.ts`'s pruning and `generate.ts` itself use to identify
`test()` blocks) — no new parsing logic:

```ts
import { splitTestBlocks } from './quality-audit.js';
...
export function createPlaywrightMode(): TestMode {
  return {
    id: 'playwright',
    ...
    countScenarios(contents: string): number {
      return splitTestBlocks(contents).length;
    },
    ...
  };
}
```

### 3. `registerSpecRows` caps registration to the surviving count —

`packages/core/src/orchestrator/index.ts`

```ts
function registerSpecRows(
  store: HealixStore,
  runId: string,
  projectDir: string,
  spec: GeneratedSpec,
  items: TestPlanItem[],
  testIdByKey: Map<string, string>,
  noteStoreFailure: (op: string, err: unknown) => void,
  mode: TestMode,   // new param
): void {
  ...
  if (!item || item.scenarios.length === 0) {
    ... // unchanged — this branch doesn't use item.scenarios at all
  }

  // A pruned spec (validate.ts's auditAndMaybePrune, already run by the time this is
  // called — see runPipeline's contentsByPath pass) may have fewer real test() blocks
  // than the plan originally called for. Registering one row per PLANNED scenario
  // regardless left the excess permanently orphaned at 'pending' — never receiving a
  // result, since persistResults only ever sees however many blocks actually survived —
  // inflating this run's own Total with phantom rows (see
  // docs/design/pruned-block-orphaned-test-row-fix.md). Capping registration to the
  // number of blocks that actually exist keeps row count in lockstep with real,
  // executable test count. mode.countScenarios is optional — a mode without it falls
  // back to item.scenarios.length unchanged, exactly today's behavior.
  const survivingCount = mode.countScenarios?.(spec.contents) ?? item.scenarios.length;
  item.scenarios.slice(0, survivingCount).forEach((s, i) => {
    ... // unchanged body
  });
}
```

Call sites updated to pass `mode` (already in scope at both — `regenerateDroppedAndExecutePending`
already receives `mode: TestMode` as a param; `runPipeline`'s main GENERATE block already
has `const mode = getMode(project.mode);` in scope):

- `index.ts:340` (retry-pass/repair path)
- `index.ts:2669`, `index.ts:2671` (main GENERATE registration)

### Why this approach, not the alternatives

- **Not deletion at prune time**: no DB row exists yet when pruning happens (validate()
  runs before registerSpecRows) — doing it there would require either reordering the
  pipeline (registerSpecRows needs `contents` _after_ pruning to title rows correctly,
  so this would just reopen the exact race `contentsByPath` already exists to prevent)
  or threading prune-count metadata all the way from `validate.ts` through `runPipeline`
  into `registerSpecRows` — more invasive, more surface area for yet another
  title/index mismatch.
- **Not re-attaching the pruned block's original code so it survives into carried/reuse
  runs** (a real alternative someone might reach for): rejected — pruning exists
  specifically to keep content that failed a quality gate OUT of the executed suite.
  Carrying it forward would mean every future reuse/top-up run permanently re-ships and
  re-executes test code the system already judged broken, which is worse than today's
  bug, not a fix for it. The correct target state is both runs converging on the SAME,
  smaller, accurate count (19) — not inflating the smaller one back up to match the
  larger, wrong one.
- **Residual, accepted limitation**: when a _non-trailing_ scenario is pruned, capping
  the count fixes the row-COUNT mismatch (no more permanently-orphaned rows), but a
  registered row's stored title/description text can still reflect the wrong plan
  scenario if `persistResults`' positional/encounter-order matching shifts (see root
  cause #5 above) — that's a pre-existing, separate, lower-severity cosmetic issue
  (wrong description text on a row that still gets a real result) inherent to the
  positional-matching design generally, not something this fix introduces or worsens.
  Out of scope here; flagged for awareness.

## Verification plan

- Unit test on `registerSpecRows`: a fake `TestMode` with `countScenarios` returning a
  count SMALLER than `item.scenarios.length` (simulating a pruned spec) — assert only
  that many rows get inserted, not `item.scenarios.length`.
- Regression test: a fake `TestMode` with NO `countScenarios` at all — assert
  `item.scenarios.length` rows still get registered, byte-identical to today's behavior
  (the optional-capability fallback path).
- Regression test: `countScenarios` returning a count >= `item.scenarios.length`
  (the normal, nothing-pruned case) — assert all scenarios still register, unchanged.
- Integration test extending `orchestrator.paths.test.ts` or similar: a real pruning
  scenario end-to-end (fake mode whose `validate()` genuinely prunes one block, whose
  `countScenarios` correctly reflects the post-prune content) — assert the final run's
  `store.listTests(runId)` count matches real executed+registered test count, with zero
  rows left at `status: 'pending'` after execution completes.
- Manual: reproduce the exact original repro (a spec with 3 scenarios where validate
  prunes 1) on a fresh run and confirm `Total` no longer counts the pruned scenario's
  phantom row.

## Critical files

- `packages/core/src/modes/types.ts` — new optional `TestMode.countScenarios?`
  capability
- `packages/core/src/modes/playwright/index.ts` — implements `countScenarios` via
  the already-exported `splitTestBlocks`
- `packages/core/src/orchestrator/index.ts` — `registerSpecRows` (3880-3989, primary
  fix site), its three call sites (340, 2669, 2671)
- `packages/core/src/modes/playwright/validate.ts` — `auditAndMaybePrune` (174-221),
  reused as-is; confirms pruned `contents` already reaches `registerSpecRows` via
  `contentsByPath` before this fix, no pipeline reordering needed
- `packages/core/src/storage/store.ts` — `deleteUnexecutedTests` (642-647), reused
  as-is; this fix reduces how often it has anything left to do, doesn't replace it
