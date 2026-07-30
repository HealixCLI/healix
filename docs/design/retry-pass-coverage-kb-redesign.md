# Retry-pass + coverage-feedback-loop: KB-driven redesign (finalized)

## Context

Retry-pass recovers from partial generation/execution failures — a plan item
never got a spec generated, or a spec was generated but the run crashed before
any of its scenarios executed. Today this is detected by _inference_ rather
than record: `matchGenerationGaps`
([repair-candidates.ts](../../apps/desktop/src/main/repair-candidates.ts))
diffs `plan.json` against the `tests` table after the fact, using a
regex-parsed `[REQ:tag]` pulled out of test titles as the join key. "Fixing" a
gap today means spinning up a brand-new run (`suiteMode: 'topup'`, a
`base_run_id` FK — [schema.ts](../../packages/core/src/storage/schema.ts))
that borrows top-up's cross-run `diffAgainstBase`/`forceRegenerate` machinery
([topup.ts](../../packages/core/src/orchestrator/topup.ts)) to solve what is
really a same-run problem.

This has two problems:

1. **No durable traceability.** Nothing records _why_ an item was dropped, or
   even that it was dropped, once a run finishes. The only per-item failure
   reason that exists today — `GenCheckpointEntry.reason`
   ([generate.ts](../../packages/core/src/modes/playwright/generate.ts)) —
   lives in an ephemeral ndjson checkpoint (`GEN_CHECKPOINT`) that is deleted
   the moment GENERATE finishes cleanly.
2. **Wrong mechanism.** Retry-pass reuses top-up's cross-run reconciliation to
   solve a same-run problem, producing a visibly separate run in the UI when
   conceptually it should just be "finish what this run didn't."

Separately, the **coverage-feedback-loop**
([index.ts](../../packages/core/src/orchestrator/index.ts), capped at
`COVERAGE_MAX_ITERATIONS = 4` —
[coverage.ts](../../packages/core/src/orchestrator/coverage.ts)) already
proves the right _shape_ for same-run iteration — no new run row, generate and
execute merged straight into the running pipeline's own bookkeeping — but each
iteration currently **re-plans**: it calls the AI planner via
`buildGapFillPlanPrompt` for functionality units the initial plan never
covered. The intended change: stop re-planning, and instead have each
iteration re-invoke generation against whatever subset the Knowledge Base
flags as `dropped`, then execute everything still `pending` — i.e. the loop
becomes an automatic, repeated caller of the exact same primitive Retry-pass
uses once, on demand.

**Status: implemented.** This is v2 of the design, revised after a review pass
surfaced a correctness gap (§3b) and three follow-up requirements from the
product owner (config preservation, full report refresh, ctx-reuse strategy).
Implementation is complete, tested (core: 1303 tests passing; desktop: 48
tests passing; both packages typecheck/lint clean), and includes one addition
beyond this doc's original scope — a fresh triage step for retry-pass's own
newly-failed results (§3 step 7a, added after the initial implementation
review flagged its absence as a gap). See "Implementation notes" at the
bottom of this document for what was actually built, including four real
bugs — two the automated test suite caught mid-implementation, two found
afterward via manual retry-pass testing against a real running app — none
visible from reading this design alone.

## Decisions (final, not to be re-litigated)

- New two-tier Knowledge Base: one row per plan item, one child row per test
  scenario. Planner seeds it; Generator marks item + all its scenarios
  `generated`/`dropped` in one write (confirmed all-or-nothing per item — a
  spec is never partially accepted, so there is never a "some scenarios
  generated, some dropped" state within one item); Executor updates individual
  scenario status as results land.
- Retry-pass extends the **same run** — no new run row, no `base_run_id` —
  reusing the `reqTag`/scenario identifiers already in the KB. It performs
  exactly one on-demand pass: regenerate whatever's `dropped`, then execute
  **every scenario still `pending`** (both freshly regenerated ones and any
  pre-existing crash-mid-execute survivors). The Executor does not need to
  distinguish "newly generated" from "already pending" — both are just rows
  whose status is `pending`.
- Coverage-feedback-loop is refactored to stop re-planning and instead loop
  the same regenerate-dropped + execute-all-pending primitive, up to 4
  iterations or until target coverage is met.
- `GEN_CHECKPOINT` stays completely separate and untouched — the KB write is
  an _additional_ write at the same call sites, not a replacement.
- Top-up (`suiteMode: 'topup'` for genuine requirement-delta runs) is
  untouched — detangling Retry-pass from it must not change top-up's real
  behavior.
- **Repair: option 1 (confirmed). Retry-pass migrates to the new KB
  mechanism; Repair does not move — at all, not even as a deferred
  follow-up.** See §3b. This supersedes v1's "Repair can be migrated later"
  framing, which turned out to conflict with removing the mechanism Repair
  depends on (see "What changed from v1" below).
- **Retry-pass must reuse the original run's configuration** (testingScope,
  provider, PRD/instructions, coverage settings, spend ceilings) — it must
  never fall back to default options just because the UI no longer passes a
  full `StartRunArgs`. See §3, step 0.
- **Every retry-pass / coverage-loop iteration ends with a full report
  refresh** — coverage ratio included — not just updated test rows. See §3
  step 7 and §6.
- **`ctx` resolution is reuse-if-present, else construct** — one shared
  resolver, not two divergent code paths. See §3c.

### What changed from v1 (for anyone who read the earlier draft)

1. §3b is new. v1's "Detangling from top-up" section proposed removing
   `opts.retryItemIds`/`forceRegenerate` from `runPipeline`'s top-up path,
   reasoning "only the old Retry-pass/Repair buttons set it." That's true, but
   Repair's _only_ implementation today is that exact branch — confirmed by
   `topup.ts`'s own doc comment on `forceRegenerate`: _"the escape hatch
   Repair (and, degenerately, Retry-pass) need."_ Removing it would have
   silently deleted the Repair button's functionality while v1's own
   "Decisions" section claimed Repair was untouched. Resolution: **don't
   remove anything from the top-up path.** Retry-pass simply stops calling
   it (it has its own entry point now); Repair keeps calling it exactly as
   today. Net diff to `topup.ts` and the `retryItemIds`/`forceRegenerate`
   branches in `runPipeline`: zero.
2. §3 step 0 (config reuse) is new — a product requirement, not something v1
   considered.
3. §3 step 7 and §6's Coverage stat tile are expanded — a product requirement
   ("all fields updated everywhere: Results tab, HTML report").
4. §2 gets an explicit callout on write semantics (seed vs. update), flagged
   in review as an easy-to-miss implementation detail.
5. §3c (ctx resolution) is new, replacing v1's vaguer "factored into a shared
   inner function... callable both from...".

## Design

### 1. Knowledge Base schema

Add to [schema.ts](../../packages/core/src/storage/schema.ts) (bump
`SCHEMA_VERSION` in [db.ts](../../packages/core/src/storage/db.ts) — new
tables retrofit automatically via the existing unconditional
`CREATE TABLE IF NOT EXISTS` pattern inside `migrate()`'s version-gated block,
no `ensureColumn` needed):

```sql
CREATE TABLE IF NOT EXISTS plan_kb_items (
  id            TEXT PRIMARY KEY,          -- kbi_<nanoid>
  run_id        TEXT NOT NULL REFERENCES runs(id),
  plan_item_id  TEXT NOT NULL,             -- TestPlanItem.id (pli_...) from this run's plan.json
  title         TEXT NOT NULL,
  req_tag       TEXT,
  tier          TEXT,
  status        TEXT NOT NULL DEFAULT 'planned',  -- planned | generated | dropped
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, plan_item_id)
);

CREATE TABLE IF NOT EXISTS plan_kb_scenarios (
  id             TEXT PRIMARY KEY,          -- kbs_<nanoid>
  kb_item_id     TEXT NOT NULL REFERENCES plan_kb_items(id),
  run_id         TEXT NOT NULL REFERENCES runs(id),   -- denormalized for direct by-run queries
  scenario_index INTEGER NOT NULL,          -- position within item.scenarios[] — matches registerSpecRows' existing `${base}#${i}` positional key, so no new indexing scheme is invented
  kind           TEXT NOT NULL,             -- positive | negative | edge
  description    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'planned', -- planned | generated | dropped | pending | passed | failed | blocked | flaky | skipped
  test_id        TEXT REFERENCES tests(id), -- set once registerSpecRows creates the row
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kb_item_id, scenario_index)
);

CREATE INDEX IF NOT EXISTS idx_plan_kb_items_run ON plan_kb_items(run_id);
CREATE INDEX IF NOT EXISTS idx_plan_kb_scenarios_kb_item ON plan_kb_scenarios(kb_item_id);
CREATE INDEX IF NOT EXISTS idx_plan_kb_scenarios_run ON plan_kb_scenarios(run_id);
CREATE INDEX IF NOT EXISTS idx_plan_kb_scenarios_test ON plan_kb_scenarios(test_id);
```

`plan.json` is kept alongside, not superseded — it remains the source of full
plan-item content (title/intent/edit history). The KB is additive: purely to
make "what's dropped / what never executed" queryable and durable without
re-parsing `plan.json` and diffing it against `tests`.

**Migration for pre-KB runs.** If `runRetryPass` or the coverage loop is
invoked against a run with zero `plan_kb_items` rows, lazily backfill once.
**This is a new helper, not a repurposing of `matchGenerationGaps`** — that
function only classifies items as gap-or-not (`{ id, title, tier, reqTag }`,
item-level, boolean-ish), with no scenario-level output and no status for
items that generated/executed successfully. The backfill needs a full walk:
for every `plan.json` item, for every scenario, find its real `tests`/
`results` row (same title/reqTag matching `matchGenerationGaps` already does)
and seed `plan_kb_items`/`plan_kb_scenarios` with its _actual_ status
(`passed`/`failed`/`pending`/etc., not just "gap or not"). `matchGenerationGaps`
is a useful reference for the matching logic, not a drop-in implementation —
budget this as new code.

### 2. Write points

- **Planner (seed rows).** In
  [index.ts](../../packages/core/src/orchestrator/index.ts), at the point
  where the resume-past-plan branch and the fresh-plan/approval branch
  converge with a finalized `planForGeneration` (immediately before ctx
  construction). For `suiteMode !== 'reuse'`, upsert one `plan_kb_items` row
  per item (status `planned`) and one `plan_kb_scenarios` row per scenario
  (status `planned`), keyed by `(run_id, plan_item_id)` /
  `(kb_item_id, scenario_index)`. Use `INSERT OR IGNORE` so re-running this on
  a resumed run is safe.
- **Generator (mark generated/dropped).** Inside `recordGenOutcome`
  ([generate.ts](../../packages/core/src/modes/playwright/generate.ts)) — the
  single funnel every per-item terminal GENERATE outcome already passes
  through (verified: base case, missing-from-batch solo-retry,
  failed-validation solo-retry, and accepted-batch-item all call it). Add a KB
  update here: set `plan_kb_items.status` to `generated`/`dropped` and cascade
  the same status to all of that item's `plan_kb_scenarios` rows.
  (`TestModeContext` needs `runId` threaded through if not already present.)
- **Link scenario to real test row.** Inside `registerSpecRows`
  ([index.ts](../../packages/core/src/orchestrator/index.ts)), once a spec is
  accepted and its `tests` rows are inserted, set `plan_kb_scenarios.test_id`
  for each matched scenario.
- **Executor (status mirror).** Inside `persistResults` (the function that
  calls `store.updateTestStatus`), also mirror the same status into
  `plan_kb_scenarios.status` for the row whose `test_id` matches. Write via
  the already-resolved `testId` (the one `persistResults` settles on after its
  own title/position/fallback-slot matching), not by re-deriving position —
  this makes the KB write inherit `persistResults`' existing correctness
  guarantees for free instead of re-implementing them.

**⚠️ Write-semantics callout (do not skip this at implementation time).** The
Planner's seed write and the Generator/Link/Executor writes are **different
SQL shapes** and must not be implemented with the same statement:

- Planner (seed): `INSERT OR IGNORE` — idempotent seeding, safe to re-run on
  a resumed run, must never overwrite an already-advanced status.
- Generator / Link / Executor: **`UPDATE ... WHERE (run_id, plan_item_id) = ?`
  / `WHERE test_id = ?`** — these mutate an _existing_ seeded row's status
  forward (`planned`→`generated`, `dropped`→`generated` on retry,
  `pending`→`passed`). If these are implemented as `INSERT OR IGNORE` by
  copying the seed pattern, the `UNIQUE` constraint silently no-ops the write
  and status gets stuck at whatever the seed wrote — Retry-pass would then
  regenerate an item successfully but the KB would still say `dropped`,
  breaking the entire premise of the feature. Get this right in code review,
  not in production.

### 3. Retry-pass: new same-run entry point

A completed run — the common case a user clicks Retry-pass on — has no
checkpoint left: `checkpoint.json` is deleted in `runPipeline`'s `finally`
whenever status isn't `paused` (verified), and `resumeRun` requires one to
exist. So Retry-pass cannot ride `resumeRun`, and it can't reuse the coverage
loop's in-process shape either (that only works while `runPipeline()` is still
on the stack). It needs its own entry point.

Add `runRetryPass(runId, hooks?, signal?)`, exported from
[index.ts](../../packages/core/src/orchestrator/index.ts) alongside
`run()`/`resumeRun()`:

0. **Reload the original configuration — do not default anything.** Read
   `store.getRun(runId)`, `store.getProject(...)`, and
   `readRunConfigSnapshot(runDir)`
   ([run-config.ts](../../packages/core/src/orchestrator/run-config.ts) —
   already exists, already persists `testingScope`/`provider`/`prd`/
   `instructions`/`coverageLoopEnabled`/`coverageTarget`/`maxCostUsd`/
   `maxTokens`, and is **never deleted**, unlike `checkpoint.json`).
   Reconstruct the equivalent of `opts: RunOptions` from this snapshot. The
   run's `suiteMode` is read from its own DB row and is never changed by
   Retry-pass — this is the same run continuing, not a mode transition.
   Provider: re-resolve the snapshot's provider id through the same
   health-gated fallback path a fresh run uses (§"Resolve the planning
   provider" in index.ts) rather than hardcoding it — if the original
   provider is no longer ready/authenticated, fall back the same way a fresh
   run would, but never silently substitute default _options_ (scope, PRD,
   coverage target) for ones the run was actually configured with. If the
   snapshot is missing entirely (a pre-`run-config.json` run), fall back to
   the run's bare DB-recorded `suiteMode` and otherwise-empty options — same
   degraded behavior a from-scratch run without a snapshot would have,
   logged clearly so it's not mistaken for a silent bug.
1. Query the KB for `run_id = runId`: items with `status = 'dropped'` (need
   regeneration) and scenarios with `status = 'pending'` (generated but never
   executed). Lazily backfill first (§1's migration path) if the run predates
   the KB. If nothing qualifies, return a "nothing to retry" result.
2. Resolve `ctx` via the shared resolver (§3c) — for a cold `runRetryPass`
   call this always means "construct fresh," including re-launching the
   project if it's a white-box run whose dev server was stopped at the end of
   the original run (extract the existing LAUNCH block from `runPipeline`
   into a shared `launchProjectIfNeeded(...)` helper, callable from both
   `runPipeline` and `runRetryPass`, instead of duplicating it).
3. Regenerate the `dropped` items: reload their `TestPlanItem`s from
   `plan.json` by `plan_item_id` (reuse the lookup `retryPassPlan` does today,
   minus the `suiteMode === 'topup'` gate — that gate doesn't apply here,
   there is no cross-run reconciliation), call
   `mode.generate(ctx, { items: droppedItems })` directly — **no
   `diffAgainstBase`/`forceRegenerate`**, since there is no second run to
   reconcile against; this run's own untouched tests already sit under this
   `runId`.
4. Register new rows via the existing `registerSpecRows(store, runId, ...)` —
   same `runId`, rows simply append. KB updates flow through the §2 write
   points (as UPDATEs — see the callout above).
5. Execute the union of (a) freshly regenerated specs and (b) any scenario
   still `status = 'pending'` in the KB whose `test_id` already exists
   (reconstruct its `GeneratedSpec` from `tests.spec_code`/`spec_path` —
   already persisted, no need to regenerate). Call
   `mode.execute(ctx, [...regenerated, ...stillPending])`.
6. `persistResults(...)` into the same `runId`, mirror KB scenario status,
   `store.updateRunStatus(runId, ...)` on the same row (never a new one).
7. **Full report refresh — every field, not just test counts.** Recompute
   `coverage = computeCoverage(units, planForGeneration.items, allSpecs,
mergedOutcome)` exactly as the coverage loop does today, rebuild
   `coverageSummary`, and call `finalizeReport(...)` (or the equivalent
   composition of `buildReport`/`renderReportHtml`) against the same `runDir`
   with the **complete, merged** picture — all specs (original + retry-pass),
   the merged `ExecOutcome` (via `mergeExecOutcomes`, already exists and
   already dedupes by identity so a re-executed scenario counts once, not
   twice), the full triage list, and the recomputed coverage. This rewrites
   `report.json`/`report.html` in place. The desktop UI's Results tab reads
   live from the DB (`store.listTests`/`listResults` — already correct,
   updates automatically once the DB rows are written) — the thing that
   previously would NOT have refreshed automatically is the coverage number
   and anything else sourced only from `report.json`, which is exactly why
   this step exists and must not be skipped or treated as optional cleanup.
   7a. **Fresh triage for THIS pass's own newly-failed results (added post-review,
   not in the original v2 scope).** Before building `triageEntries` for step
   7's report, diff `mergedOutcome.results` (failed/blocked) against
   `store.listTriageResults(runId)` by testId — anything not already triaged
   is genuinely new this pass. For each: build the same `TriageInput` shape
   runPipeline's own TRIAGE phase uses (reqTag/specSource from the matched
   spec, tracePath from artifacts) and call `TriageEngine.analyze(...)` — the
   single-item method, not `analyzeBatch` — wrapped in the same
   `withTimeoutAbort(..., TRIAGE_ANALYZE_TIMEOUT_MS, controller)` safety net
   runPipeline uses. Persist via `store.recordTriageResult(...)` as each
   completes. **Deliberately simpler than runPipeline's TRIAGE phase**: no
   `TRIAGE_AI_BATCH_SIZE` batching, no confidence-ranked `TRIAGE_AI_LIMIT`
   candidate selection, no recursive truncation-split — retry-pass only ever
   deals with the small subset of results it just touched (a handful of
   items), not a whole run's worth of failures, so the machinery that exists
   specifically to bound cost/latency across dozens of failures would be pure
   overhead here. Old verdicts already in `triage_results` are read back
   as-is and never re-triaged — this step only ever adds rows, never touches
   existing ones.
8. Emit events via `store.appendEvent(runId, ...)` so `RunDetailPanel`'s
   existing timeline shows the activity in place.

### 3b. Repair: not touched, not migrated, full stop

Per the confirmed decision, Repair keeps its current implementation
permanently as part of this effort's scope:

- `matchRepairCandidates`, the Repair button
  ([RunDetailPanel.tsx](../../apps/desktop/src/renderer/src/components/RunDetailPanel.tsx)'s
  `startRepair`), and its IPC path are unchanged.
- `topup.ts`'s `diffAgainstBase`/`forceRegenerate` and `runPipeline`'s
  `opts.retryItemIds`-gated branches (the `suiteMode === 'topup' &&
opts.retryItemIds` reload, and the `forceRegenerate` derivation feeding
  `diffAgainstBase`) are **not removed, not modified**. They continue to
  exist solely to serve Repair going forward.
- The only change from Repair's point of view: Retry-pass's button no longer
  calls the same code path Repair calls. That's it — zero lines change in
  `topup.ts`, and zero lines change in the `retryItemIds`/`forceRegenerate`
  branches of `runPipeline`.
- If Repair is ever migrated to the KB mechanism, that is a **separate,
  future effort** with its own design discussion (candidate source becomes
  "triaged `test_is_wrong`" instead of "dropped/pending," feeding the same
  `runRetryPass`-style primitive) — not an implicit follow-on to this one.

### 3c. `ctx` resolution: reuse if present, construct if not

Two callers need a working `TestModeContext`: the in-process coverage loop
(where `ctx` already exists as a live variable — a running browser/dev-server
handle, an instantiated provider adapter, an open scaffold directory) and
`runRetryPass`'s cold entry point (where none of that exists yet — it has to
be built from durable state: DB rows, `plan.json`, `run-config.json`, and,
for white-box projects, actually relaunching the app).

**Chosen approach: one resolver function, not two code paths.**

```ts
async function resolveCtx(params: {
  runId: string;
  project: Project;
  opts: RunOptions;
  runDir: string;
  existing?: TestModeContext;   // present when called from inside runPipeline's own stack
}): Promise<TestModeContext> {
  if (params.existing) return params.existing;
  // Cold path: launchProjectIfNeeded (§3 step 2's extracted helper), resolve
  // the provider, verify/re-scaffold the suite directory, build ctx exactly
  // the way runPipeline's own ctx-construction section does today.
  ...
}
```

This is a standard optional-dependency-with-fallback-constructor pattern —
preferred here over two separate ctx-building code paths because it keeps
"how a `ctx` is built" defined in exactly one place; the coverage loop and
`runRetryPass` differ only in whether they already happen to have one, not in
how one gets made. `regenerateDroppedAndExecutePending(...)` (§4) takes
`existing?: TestModeContext` and passes it straight through to `resolveCtx`,
so neither caller needs its own branch — the loop passes its live `ctx`,
`runRetryPass` passes nothing and gets one built.

### 4. Coverage-feedback-loop: stop re-planning, reuse the same primitive

Replace the loop body in
[index.ts](../../packages/core/src/orchestrator/index.ts):

- Remove the `buildGapFillPlanPrompt` / `provider.complete(mode: 'plan')` /
  `parsePlan` block entirely — no more AI re-planning per iteration.
- Each iteration instead calls `regenerateDroppedAndExecutePending(ctx, runId,
...)` (§3c), passing the loop's already-open `ctx`/`specs`/`outcome`/
  `testIdByKey` in-process (matching the loop's existing shape) — the same
  function `runRetryPass` calls with `existing` omitted.
- The loop condition stays structurally the same —
  `iteration < COVERAGE_MAX_ITERATIONS && coverage.ratio < coverageTarget &&
<something left to regenerate>` — but "something left" now means "the KB
  still has `dropped` items or `pending` scenarios for this run," not
  "uncovered functionality units remain," since the loop can no longer
  discover coverage gaps that were never planned in the first place. It only
  recovers items the plan already included but generation/execution failed to
  finish.
- The loop's existing end-of-run report finalization already recomputes
  coverage and rewrites the report on every iteration (confirmed: `coverage =
computeCoverage(...)` is called after each loop body, and
  `finalizeReport(...)` runs once after the loop with the final
  `coverageSummary`) — §3 step 7 for `runRetryPass` is bringing that same
  guarantee to the cold-start path, not inventing new behavior for the loop.

**This is a real behavior narrowing, not just a refactor.** Today's loop can
raise coverage by planning entirely new scenarios for functionality the
initial plan never mentioned. After this change, if nothing was dropped and
nothing is stuck pending, the loop has nothing to do and stops immediately —
even if measured functional coverage is below target. Coverage shortfall
caused by thin initial planning is no longer addressed by this loop; only
coverage shortfall caused by generation/execution failure is. This matches
what was asked, but is worth confirming once it's running, since it changes
what the "Coverage %" target control effectively does.

### 5. UI changes

- `RunDetailPanel.tsx`:
  - `onRetryPass` simplifies from constructing a `StartRunArgs`
    (`suiteMode`/`baseRunId`/`retryItemIds`) to a single
    `window.healix.retryPass(detail.run.id)` call. The candidate pre-check
    (`generationGaps`) becomes server-side inside `runRetryPass` itself; the
    "Nothing to retry" message reads the call's result instead of a
    client-side pre-check.
  - **New: a Coverage stat tile in the Results tab's stat row** (the row
    currently showing Total/Passed/Failed/Blocked/Flaky/Rate/Total time —
    confirmed `coverage` is not read or rendered anywhere in this component
    today). Source it from `report.coverage` (`ReportCoverageSummary` — ratio,
    target, covered/total counts — already computed and already written into
    `report.json`, just not surfaced in this view). This is what makes §3
    step 7's report refresh visible to the user rather than a write nobody
    reads.
  - Retry-pass button and Repair button remain visually distinct entry
    points, but only Retry-pass's handler changes (see above); Repair's
    handler is untouched per §3b.
- `RunsView.tsx`: `startRetryPass` stops calling `engine.start`/`queueRun`
  (which mints a new `run:started`/new list entry) and instead calls a new
  `engine.retryPass(runId)` that subscribes to `run:event` for the
  **existing** `runId`, so the same run card updates in place rather than a
  new one appearing, and re-fetches run detail on completion so the Results
  tab (live DB-backed) and the new Coverage tile (report.json-backed) both
  reflect the retry-pass's work without a manual refresh.
- Repair's button/flow in both files is untouched (§3b).

### 6. New IPC

A `run:retryPass` handler in
[apps/desktop/src/main/index.ts](../../apps/desktop/src/main/index.ts) (shaped
like the existing `run:resume` handler) calling `runRetryPass`, streaming
events under the **existing** `runId` — never a new `run:started`.

### 7. Test impact

- `orchestrator.retry-pass.test.ts` — full rewrite: no more
  `suiteMode: 'topup'`/`baseRunId`/asserting a second distinct `run2.runId`.
  New tests call `runRetryPass(run1.runId)` and assert: run status
  transitions on the same run row, new `tests` rows appended under the same
  `runId`, KB rows reflect `generated`/`dropped`/status transitions (via
  UPDATE, not stuck at seed values — a regression test specifically for the
  §2 write-semantics callout), the crash-mid-execute case (already covered
  today) becomes the setup for a test proving pending rows get executed
  without regeneration, **retry-pass reuses the original run's
  testingScope/provider/coverage settings from `run-config.json` rather than
  defaulting them** (new), and **`report.json`'s coverage summary is
  recomputed and changed after retry-pass, not left stale** (new). Add a
  pre-KB/lazy-backfill test, including one asserting the backfill correctly
  seeds per-scenario status for already-passed scenarios (not just
  dropped/pending ones — see §1's "not a repurposing" note).
- `orchestrator.topup.test.ts`, `topup.test.ts`, `repair-candidates.test.ts` —
  must stay green with **zero diffs to the production code they exercise**
  (per §3b, nothing in `topup.ts` or the `retryItemIds`/`forceRegenerate`
  branches changes). Add one explicit regression test asserting Repair's
  candidate-selection and run-start path is byte-for-byte unchanged.
- Add coverage-loop tests asserting no `provider.complete(mode: 'plan')` call
  happens mid-loop, and that the loop terminates immediately when the KB has
  nothing dropped/pending even if measured coverage is below target.
- New: a `resolveCtx`/`regenerateDroppedAndExecutePending` unit test asserting
  it returns the passed-in `existing` ctx untouched when present, and only
  constructs (including calling `launchProjectIfNeeded`) when absent.

## Critical files

- [schema.ts](../../packages/core/src/storage/schema.ts),
  [db.ts](../../packages/core/src/storage/db.ts) — new tables, schema version
  bump
- [index.ts](../../packages/core/src/orchestrator/index.ts) — KB seeding at
  plan/approve convergence; new `runRetryPass` entry point; new `resolveCtx`
  helper; shared `regenerateDroppedAndExecutePending` helper used by both
  `runRetryPass` and the rewritten coverage loop; extraction of a reusable
  `launchProjectIfNeeded` helper. **No changes** to the top-up/`retryItemIds`
  branches (§3b).
- [run-config.ts](../../packages/core/src/orchestrator/run-config.ts) — no
  schema change needed, just a new read call site in `runRetryPass`
- [generate.ts](../../packages/core/src/modes/playwright/generate.ts) — KB
  write inside `recordGenOutcome`
- [repair-candidates.ts](../../apps/desktop/src/main/repair-candidates.ts) —
  new backfill helper added alongside (not replacing) `matchGenerationGaps`;
  `matchRepairCandidates` untouched (§3b)
- [apps/desktop/src/main/index.ts](../../apps/desktop/src/main/index.ts) — new
  `run:retryPass` IPC handler; Repair's existing handler untouched
- [RunDetailPanel.tsx](../../apps/desktop/src/renderer/src/components/RunDetailPanel.tsx) —
  same-run retry-pass call, new Coverage stat tile, Repair untouched
- [RunsView.tsx](../../apps/desktop/src/renderer/src/views/RunsView.tsx) — new
  `engine.retryPass(runId)` in-place update path
- [orchestrator.retry-pass.test.ts](../../packages/core/src/orchestrator/orchestrator.retry-pass.test.ts) —
  rewritten for the same-run model

## Verification

- Run the existing suite (`orchestrator.retry-pass.test.ts`,
  `orchestrator.topup.test.ts`, `topup.test.ts`, `repair-candidates.test.ts`),
  plus new coverage-loop, config-reuse, report-refresh, and `resolveCtx` tests.
- Manual — Retry-pass: start a project run with a **non-default**
  configuration (e.g. a specific `testingScope`, a custom PRD, coverage loop
  on with a non-default target), force a drop (inject a provider failure for
  one item) and a crash-mid-execute (kill mid-EXECUTE). Click Retry-pass in
  the desktop app and confirm: (1) no new run appears in the runs list, (2)
  the retry actually ran against the **same** testingScope/PRD/coverage
  target the original run used, not defaults, (3) the same run's
  status/test counts update, (4) the previously-dropped item now has a test,
  (5) the previously-pending scenario now has a real result, (6) the
  Coverage tile in the Results tab shows an updated ratio, and (7)
  `report.html` reflects the same updated coverage number.
- Manual — Repair: run the existing Repair flow start-to-finish on an
  unmodified build and confirm it behaves identically to before this change
  (still creates a `suiteMode: 'topup'` run with a `base_run_id`) — this is
  the regression check for §3b.
- Manual — coverage loop: enable the toggle on a run with some
  deliberately-dropped items and confirm it recovers them automatically
  without any `plan-gapfill` log lines appearing, stopping within 4
  iterations, and that the final report's coverage number matches what the
  Results tab shows.

## Implementation notes

Everything above was built as designed, with one addition (§3 step 7a, the
fresh-triage step) and three real bugs — none visible from reading this
design, all fixed before landing. The first two were caught by the automated
test suite mid-implementation; the third was found afterward, via manual
retry-pass testing against a real app (querying the running desktop app's
own `healix.db` directly), then reproduced with a new regression test before
being fixed. Recorded here so the reasoning survives past the PR that fixed
them.

### Bug 1 — `updatePlanKbItemStatus` cascaded the wrong status onto scenarios

**Symptom:** `store.listPendingPlanKbScenarios(runId)` never returned anything,
even right after a crash-mid-execute run left a test row genuinely `pending`
in the `tests` table.

**Root cause:** the write point conflated two different vocabularies.
`'generated'` is an **item**-level status (`plan_kb_items.status` — "a spec
was produced for this item"). A **scenario** whose item was just generated
isn't `'generated'` — it's `'pending'` ("spec exists, no execution result
yet"), which is exactly the status `listPendingPlanKbScenarios` filters on.
The original implementation cascaded the item's literal status string
(`'generated'` or `'dropped'`) straight onto every scenario, so a scenario
never passed through `'pending'` at all — it went `'planned'` → `'generated'`
and then either got overwritten by a real result (happy path, no bug visible)
or stayed at `'generated'` forever if execution crashed first (crash path,
the bug).

**Fix:** `updatePlanKbItemStatus` now maps the cascade explicitly —
`status === 'generated'` cascades `'pending'` to scenarios; `'dropped'`
cascades `'dropped'` as-is (a dropped item's scenarios genuinely are dropped,
so that direction was always correct). One `if`, in
[store.ts](../../packages/core/src/storage/store.ts).

**Why the tests caught it, not code review:** the crash-mid-execute test only
asserts on the `tests` table (`status === 'pending'`) directly — it never
touched the KB. The bug was invisible until a NEW test exercised
`retryPass()` end-to-end and asserted on `listPendingPlanKbScenarios` — the
exact query the feature's own retry logic depends on. This is the argument
for integration tests over the KB, not just unit tests over `tests`/`results`.

### Bug 2 — a just-regenerated item could get executed twice

**Symptom:** a test asserting "exactly one triage row for one newly-failed
item" found two.

**Root cause:** ordering. `regenerateDroppedAndExecutePending` queried
"pending scenarios" (the reconstruct-and-re-execute-without-regenerating set)
**after** calling `mode.generate()` — but `mode.generate()`'s own
`ctx.onKbItemOutcome` callback is what cascades a freshly-regenerated item's
scenarios to `'pending'` (see Bug 1's fix) as part of that SAME call. So the
"pending" query, run afterward, incorrectly caught the item this very call
had just regenerated — that item's spec ended up in both `newSpecs` (from
regeneration) and `pendingSpecs` (from the stale-timed query), and
`mode.execute()` ran it twice. `persistResults`' matching then had two
occurrences of the same title to reconcile, minting a second, orphaned test
row for the duplicate.

**Fix:** snapshot "pending scenarios" **before** the `mode.generate()` call,
explicitly filtered to exclude any scenario whose parent item is among this
call's own `droppedItems` (belt-and-suspenders alongside the reordering,
since the two sets should already be disjoint once the query runs at the
right time). Same file, same function, a few lines above the generate call.

**Why the tests caught it, not code review:** the two earlier "regenerates a
dropped item" and "executes a pending scenario" tests each exercised ONLY one
of the two code paths in isolation, so neither could see them collide. It
took a THIRD scenario — a regenerated item that then fails execution, needing
fresh triage — to force both paths through the same call and surface the
duplicate. Worth remembering when writing tests for this kind of dual-path
function: covering each path alone doesn't prove they compose correctly.

### Bug 3 — two plan items sharing a reqTag permanently corrupted each other's KB linkage

**Symptom:** on a real app run (`run_bVJmwXmbI6` — a genuinely fresh run, not
a backfilled one), retry-pass logged `Retry-pass: 2 dropped item(s), 16
pending scenario(s).`, regenerated the 2 dropped items correctly, but then
`Executing 2 spec(s) (2 regenerated, 0 previously pending)` — none of the 16
reported "pending" scenarios were ever reconstructed or executed. Direct
`healix.db` inspection showed all 16 stuck at `plan_kb_scenarios.status =
'pending'` with `test_id = NULL` — not because their test rows had been
deleted, but because they had _never been linked at all_.

**Root cause:** the plan legitimately paired a UI-tier item and a
`tierC-api` contract item under the same functional `reqTag` (e.g. `REQ-001`
= both "User registration via UI" and "POST /api/auth/register API
contract" — a real, by-design pattern, not a plan bug). `registerSpecRows`
resolved "which plan item does this generated spec belong to" purely via
`items.find(it => (it.reqTag ?? it.id) === reqTag)` — when two items share a
reqTag, `.find` always returns whichever comes first, so the API-contract
item's spec was silently registered against its UI sibling: wrong scenario
text, and — critically — `linkPlanKbScenarioTest` called with the sibling's
`item.id`, never the API-contract item's own. Its KB scenarios stayed
unlinked forever. A second, deeper layer of the same root cause: even after
fixing item resolution, `persistResults`' positional `testIdByKey` keyed
purely by `reqTag#scenarioIndex` — two items sharing a reqTag AND an
overlapping scenario-index range (the common case for small scenario counts)
would still silently overwrite each other's slot, losing one item's
results/status-sync even with correct KB linkage.

**Fix, two parts:**

1. `GeneratedSpec` gained an optional `planItemId` field, set by
   `generate.ts` at the exact moment it produces a spec (it always knows
   unambiguously which item it's processing — no string matching needed).
   `registerSpecRows` now resolves `item` by `spec.planItemId` FIRST,
   falling back to the old reqTag-based lookup only when absent (a
   carried-forward spec has no originating item in this run).
2. `registerSpecRows` now writes an ADDITIONAL `item:<id>#<scenarioIndex>`
   key into `testIdByKey` alongside the original reqTag-based key (dual-write,
   not a replacement — any caller whose spec doesn't carry `planItemId`, e.g.
   a carried-forward spec, an older/fake `TestMode`, still resolves via the
   original key, unchanged). `persistResults` prefers matching the executed
   result's spec by the LONGEST spec title that prefixes the result's title
   (unambiguous — a spec's title embeds its own item's title text) over bare
   reqTag matching, and once it resolves a spec with a `planItemId`, keys and
   counts scenario position by `item:<id>` instead of `reqTag`, eliminating
   the collision entirely for any spec produced by real `generate.ts`.

**Why this needed a NEW regression test, not just the existing suite:** none
of the existing fixtures had two plan items sharing a reqTag — every
existing test kept passing throughout, both before and after the fix,
because the bug is invisible unless that specific plan shape exists. Added:
`orchestrator.retry-pass.test.ts`'s "two items sharing the same reqTag ...
both get KB-linked correctly" test, asserting both items' KB scenarios
resolve a non-null `test_id` AND the correct post-execution `status` — the
first version of the fix (item-lookup only, no dual-key) passed the
`test_id` assertion but failed the `status` one, which is what surfaced the
deeper `testIdByKey` collision.

### Bug 4 — a spec quarantined by the LATER `validate()` step left the KB permanently stuck

**Symptom:** on a real app run, one item's spec ("DELETE /api/todos/{id}")
got quarantined during generation ("CODEGEN DEFECT" — failed to parse).
Retry-pass on that run reported `0 dropped item(s), 5 pending scenario(s)`
and then did **nothing at all** — no generate/execute step, straight to
"Retry-pass complete. Run failed." Direct DB inspection showed all 5 of that
item's `plan_kb_scenarios` rows stuck at `status = 'pending'` with
`test_id = NULL`, and the item's own `plan_kb_items.status` was `'generated'`
— not `'dropped'`, even though its spec was quarantined and never shipped.

**Root cause:** two independent validation passes exist, at different times,
neither aware of the other. `generate.ts`'s own per-item checks (selector/
endpoint grounding, forbidden APIs, etc.) accepted this spec, so
`recordGenOutcome` called `ctx.onKbItemOutcome(item.id, 'generated')` —
cascading the item's scenarios to `'pending'`. Only _afterward_, once ALL
items finish generating, does index.ts run the batch-level
`mode.validate()` pass (a real parse check the regex/string gates in
generate.ts can't do — see index.ts's "Pre-execution validation gate"
comment) — which caught a genuine codegen defect and quarantined it. A
quarantined spec is filtered out of `newSpecs` _before_ `registerSpecRows`
ever runs for it, so its scenarios' `test_id` never gets linked either. The
KB was never told about this later rejection: it stayed at
`'generated'`/`'pending'` forever. Retry-pass could neither regenerate it
(not marked `'dropped'`) nor execute it (never registered) — a permanent,
silent dead end, distinct from Bug 3 (which was a _linking_ mismatch, not a
missed status transition).

**Fix:** after the quarantine-warning `emit(...)` in index.ts, loop over
`validation.quarantined` and call `ctx.onKbItemOutcome(q.spec.planItemId,
'dropped')` for each one — using the same `planItemId` field added for Bug
3, which `mode.validate()` receives unchanged from `newSpecs`. A
carried-forward spec has no `planItemId` (nothing to correct — same
carried-forward exemption as `registerSpecRows`).

**Why this needed a NEW regression test, not just the existing suite:** no
existing test exercised a mode with a `validate()` that actually quarantines
something — the gap was invisible because nothing had ever driven that code
path in a test. Added: `orchestrator.retry-pass.test.ts`'s "a spec
quarantined by the LATER validate() step ... gets the KB corrected to
dropped" test, using a fake mode whose `validate()` quarantines one specific
item's spec. Verified by temporarily reverting the fix and confirming the
test fails with the exact original symptom (`listDroppedPlanKbItems` stays
empty) before restoring it and re-confirming green.
