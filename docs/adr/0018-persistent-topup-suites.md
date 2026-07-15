# ADR-0018: Persistent, top-up test suites (copy-forward, no version tables)

- **Status:** Accepted
- **Date:** 2026-07-15
- **Deciders:** Garima

## Context

Every Healix run regenerated an entirely fresh, throwaway Playwright suite from scratch: [ADR-0005](./0005-local-first-storage.md) already checkpoints run/test/result rows to SQLite, but the generated spec _source_ only ever lived under one run's own disposable `runs/<runId>/suite/` folder — nothing recovered it once that run was old news. A project accumulated no lasting notion of "its suite"; adding tests for a new feature meant regenerating everything, at full AI cost, with no guarantee the old coverage even matched what just got produced again.

The ask: a project should behave like a single source of truth over time — accumulate test cases across runs, let a new run "top up" the existing suite (generate only what's new/missing, keep what already passes), optionally "reuse" an existing suite with zero generation, and expose run history / suite composition / per-test-case history / metrics at the project level.

An initial design proposed three new tables (`suite_versions`, `suite_cases`, `suite_case_versions`) to model suite lineage as a first-class SCD-2 entity. That was rejected in favor of the leaner design below: **no new tables**, because every one of "suite version," "which tests changed," and "test-case history" turns out to be _derivable_ from the existing `runs`/`tests`/`results` tables plus a single pointer — a run already IS a snapshot of "the suite as of that point," so a separate version entity would just duplicate what a run row already represents.

## Decision

Model top-up/reuse as **copy-forward between runs**, not as a first-class suite entity:

1. **Three new nullable columns**, no new tables (`db.ts`'s existing `ensureColumn` migration pattern, `SCHEMA_VERSION` 4 → 5):
   - `tests.spec_path` — the relative path of a test's generated spec file within _its own run's_ suite dir. This is the one genuinely new fact needed: `modes/playwright/generate.ts` computes a spec's path fresh per run (dedup-suffixed against that run's own collisions) and never persisted it anywhere — without storing it, there's no way to know which physical file to copy forward.
   - `runs.suite_mode` (`'fresh' | 'topup' | 'reuse'`) and `runs.base_run_id` — which prior run (if any) this run topped-up/reused from. Walking `base_run_id` backward across a project's runs _is_ the run lineage; no separate version-number bookkeeping is needed.

2. **Orchestrator**: a new `suiteMode`/`baseRunId` pair on `RunOptions` (default `'fresh'`, omitted entirely reproduces today's exact behavior byte-for-byte — the whole feature is opt-in). For `topup`/`reuse`, the base run resolves to `getLastSuccessfulRun(projectId)` (or an explicit pin) up front; missing → a hard error, never a silent fallback to `fresh`. The two modes carry forward different subsets of the base run, deliberately: `topup` runs PLAN unchanged (no prompt changes — the model isn't told about existing coverage), then a pure `diffAgainstBase()` function classifies each planned item as already-covered (skip AI generation) or new (generate); only the base run's _passing_ tests are carried forward — a failing/blocked test is left for the fresh exploration to decide whether it's still worth testing, rather than re-including a known-bad test unchanged. `reuse` skips planning/generation entirely and re-executes the base run's **entire** suite as-is — every test with a known spec file, regardless of its previous status — because "run the existing suite as-is" means the whole suite, not just last time's winners; silently dropping previously-failing tests would make it impossible to see whether they still fail. Either way, EXECUTE receives the exact same `GeneratedSpec[]` shape it always has — **zero changes to `execute.ts`, `collectArtifacts`, or `export()`**.
   - A base run's eligibility is likewise broader than "fully green": any run whose status is `passed`, `failed`, or `blocked` qualifies (it produced a real verdict over real tests) — only `error` (verified nothing) and `cancelled` (aborted mid-run) are excluded. Requiring a fully-passed run would make top-up nearly unusable in practice, since most real runs have at least one failure.
   - Playwright's own `auth-setup` dependency "test" (Tier B's login fixture) is excluded from results/counts when it passes — it can never be matched back to a generated spec, so leaving it in silently inflated totals and polluted the "passed" pool with an uncarryable phantom row every Tier B run. A _failing_ setup is still surfaced (it's the reason Tier B got blocked).

3. **Identity across runs**: an exact-match key, `reqTag` when present else normalized title (`computeIdentityKey`, exported from core). No fuzzy/semantic matching — a title rewrite with no `reqTag` reads as "old test removed + new test added" rather than "updated." Documented limitation, not an oversight.

4. **IPC/UI**: `runs:lastSuccessful` (drives the Suite Mode toggle's enable state), `runs:suiteDiff` (added/carried/removed counts for one run vs. its base, computed on read), `runs:caseHistory` (walks `base_run_id` backward matching by identity key, for the Test Case History drawer), and `runs:projectMetrics` (total runs, pass-rate trend — pure aggregation, no schema impact). A project's "Suite Versions" list is simply its Run History, annotated with `suite_mode`/`base_run_id` — not a separate view.

## Consequences

- **Minimal footprint, maximal reuse of ADR-0005's model**: three nullable columns, zero new tables, zero changes to `modes/playwright/execute.ts` or the standalone export path ([ADR-0009](./0009-standalone-suite-export.md)) — a `top-up`/`reuse` run's exported bundle is indistinguishable in shape from a `fresh` one.
- **No stored config-change snapshot**: `repoPath`/`baseUrl` at generation time isn't recorded per run, so there's no automated "this suite may be stale" warning if project config changed since the base run — only the project's _current_ config is shown for the user's own judgment. A future iteration can add this without touching the schema decided here (it would need its own snapshot columns).
- **History only extends as far as an unbroken top-up/reuse chain**: a `fresh` run has `base_run_id = null`, so `runs:caseHistory` naturally stops there — a test's lineage before the most recent `fresh` regenerate isn't reachable. Accepted as consistent with "fresh means start over," not a bug.
- **Carry-forward is all-or-nothing per base run within each mode**: every eligible test (passing-only for `topup`, all-with-a-spec-file for `reuse`) comes along; there's no per-test opt-out/explicit-removal action yet (schema doesn't block adding one later — it would just be new orchestrator logic, no new columns).
- **Old runs are unaffected**: pre-feature runs have `NULL` `suite_mode`/`base_run_id`/`spec_path`; every new query is scoped and returns `null`/`[]` gracefully. `packages/cli`'s `runs list/show/rm` and `export.ts` needed no changes beyond one new display line in `runs show`.
