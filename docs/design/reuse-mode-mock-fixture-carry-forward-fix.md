# Fix: reuse mode never carries forward `fixtures/mock.fixture.ts`, breaking every carried spec that imports it

## Bug report

Running "Run Existing Suite" (reuse mode) against `prj_eQg-UbZR2a`'s fresh run
(`run_oh8KFSPn9b`, 13 specs, 5 external dependencies detected and mocked) produced:

```
12:23:16  generate  Copying 98 test(s) forward from run run_oh8KFSPn9b (entire suite, as-is).
12:23:22  generate  [validate] Skipping parse-check for 98 spec(s): suite dependencies appear to be missing
12:23:22  execute   Executing 98 spec(s) via Playwright
12:23:25  execute   [execute] missing suite dependency; re-running npm install…
12:23:25  execute   [execute] npm install complete
12:23:27  execute   [execute] Playwright run finished
12:23:27  execute   Could not parse Playwright results; suite may have failed to start
12:23:27  execute   Execution complete: 0 passed, 0 failed.
12:23:27  execute   Dropped 98 pre-registered test row(s) that never executed.
12:23:27  done      Run verified nothing: no runnable specs were produced.
```

Note: the `"Could not parse Playwright results; suite may have failed to start"` diagnostic
firing here is the *silent-suite-deps-failure* fix (see
`docs/design/execute-suite-deps-silent-failure-fix.md`) working correctly — it now
surfaces the failure instead of masking it as a clean `0 passed / 0 failed`. But the
underlying reason the suite has zero runnable specs is a **separate, real bug**, confirmed
below.

## Root cause (confirmed directly against the failing run's own artifacts)

Comparing the reuse run's suite directory against the original fresh run it copied from:

| | Fresh run (`run_oh8KFSPn9b/suite/fixtures/`) | Reuse run (`run_4cZ1cZ9hLq/suite/fixtures/`) |
|---|---|---|
| Contents | `action-highlighter.ts`, `auth.setup.ts`, `checkpoint-reporter.cjs`, **`mock.fixture.ts`**, `steps-reporter.cjs` | `action-highlighter.ts`, `auth.setup.ts`, `checkpoint-reporter.cjs`, `steps-reporter.cjs` — **`mock.fixture.ts` missing** |

And the reuse run's own `results.json` confirms the failure mode directly — every one of
the 13 carried spec files fails identically:
```
Error: Cannot find module '...\suite\fixtures\mock.fixture' imported from
'...\home-page-at-home.spec.ts'
```
(`suites.length === 0` in the parsed report — genuinely zero specs could even be
collected, which is exactly what the structurally-empty-report detection correctly
caught and surfaced.)

**Why it's missing**: `packages/core/src/modes/playwright/scaffold.ts:248-251` only
writes `fixtures/mock.fixture.ts` when `ctx.mockExternalDependencies` is truthy:
```ts
if (ctx.mockExternalDependencies) {
  await writeFile(join(fixturesDir, 'mock.fixture.ts'), mockFixtureContents(routes), 'utf-8');
  emit(ctx, `Wrote mock fixture with ${routes.length} route(s)`, { routes: routes.map((r) => r.id) });
}
```
`ctx.mockExternalDependencies` is only ever set (`index.ts:2088-2094`) when
`externalDependencies.length > 0`, and `externalDependencies` is only ever populated
(`index.ts:1506`, inside `if (project.repoPath) {...}`) within the **non-reuse** branch
of the pipeline (`index.ts:1436`'s `else`) — reuse mode takes the `if (suiteMode ===
'reuse')` short-circuit at plan time and never reaches that code at all, so
`externalDependencies` stays `[]` for the entire reuse run.

Meanwhile, the carried-forward spec files — copied byte-for-byte by `hydrateCarriedSpecs`
(`index.ts:4234-4270`, which only ever touches `t.specPath` `.spec.ts` files, nothing
under `fixtures/`) — still literally `import { test, expect } from '../../fixtures/mock.fixture'`,
because that's the import path `generate.ts` chose when the **base** run originally
generated them, and the base run genuinely did have `mockExternalDependencies: true`.

**This is the same class of bug as the Tier B exploration-inheritance fix** (see
`docs/design/reuse-mode-exploration-inheritance-fix.md`) — reuse mode skips a
GENERATE-time side effect that the carried-forward specs still depend on. Same shape,
different artifact (a fixture *file* here, instead of exploration/login data there).

Also worth noting: the earlier `"missing suite dependency; re-running npm install"`
self-heal fired here uselessly — `looksLikeMissingSuiteDeps`'s `Cannot find module`
pattern matches both a missing **npm package** and a missing **local file/fixture**, and
`npm install` obviously cannot fix a missing local file, so it "succeeds" (nothing to
install) without touching the real problem. This is expected/correct given that
detector's scope — not something to fix here, just why the self-heal didn't help.

## What was double-checked, and ruled out as unaffected

A full audit of `scaffold.ts`'s conditional writes (197-255) found `mock.fixture.ts` is
the **only** artifact affected by this specific gap:

| File | Gating condition | Reuse-mode-safe? |
|---|---|---|
| `package.json`, `playwright.config.ts`, `fixtures/auth.setup.ts`, `fixtures/action-highlighter.ts`, `fixtures/steps-reporter.cjs`, `fixtures/checkpoint-reporter.cjs`, `README.md`, `.gitignore`, `fixtures/.auth/user.json` | none — always written | ✅ unaffected |
| `playwright.config.ts`'s `includeAuthSetup` | `ctx.hasTierBAuthPlanItems !== false` | ✅ reuse mode deliberately leaves this `undefined`, which defaults to `true` (documented at `index.ts:2078-2081` — "scaffold() is a no-op re-run over an already-working carried-forward suite, not a fresh decision about auth surface") — safe, not a bug |
| **`fixtures/mock.fixture.ts`** | **`ctx.mockExternalDependencies`** | ❌ this bug |

No other conditional write in `scaffold.ts` is gated on `ctx.credentials` or
`ctx.sourceContext` at all (confirmed via search).

`runs/<baseRunId>/suite/` is durable — no automatic pruning/retention job exists in
`packages/core/src`; the only deletion path is an explicit, user-triggered
`deleteRunAssets()` call from the desktop app's "delete run" action. So copying from the
base run's suite directory at reuse-time is reliable unless the user explicitly deleted
that specific run.

## Fix

**Do not** re-run `detectExternalDependencies`/`generateMockResponses` in reuse mode —
that would spend real AI tokens (`generateMockResponses` takes a `provider` and calls
it) and violate the explicit, tested invariant "REUSE: zero AI calls at all"
(`orchestrator.topup.test.ts:325`).

**Also do not** blindly copy the entire `fixtures/` directory forward — `scaffold()`
already runs first (`index.ts:2513`, before either `hydrateCarriedSpecs` call at
2524/2544) and writes fresh, current-template versions of `auth.setup.ts`,
`action-highlighter.ts`, `steps-reporter.cjs`, `checkpoint-reporter.cjs` — a directory-wide
copy-forward would silently regress those to the base run's (possibly older) template
code.

**Correct fix**: copy only `fixtures/mock.fixture.ts` forward from the base run, and only
when the CURRENT run didn't already scaffold a fresh one itself. The second condition
matters for `topup` specifically: unlike reuse, topup runs through the non-reuse branch
and DOES re-run real dependency detection every time (`index.ts:1506`), so it may
already have written its own, current `mock.fixture.ts` this run — carrying the base
run's stale copy over that would be a regression, not a fix. Gating on
`!ctx.mockExternalDependencies` naturally handles both cases: always true for reuse
(never set), and only true for topup on the (presumably rarer) occasions its own
redetection came back empty while the base run's didn't — exactly the same failure mode,
just for topup.

```ts
// packages/core/src/orchestrator/index.ts, new function alongside hydrateCarriedSpecs (~4270):

/**
 * Copies the base run's fixtures/mock.fixture.ts forward when THIS run's own scaffold
 * pass didn't write one (ctx.mockExternalDependencies is falsy) — covers reuse mode
 * (which never re-runs dependency detection at all, see the suiteMode === 'reuse'
 * short-circuit at plan time) and the rarer topup case where this run's own
 * redetection came back empty while the base run's didn't. Carried-forward spec files
 * (hydrateCarriedSpecs, copied byte-for-byte) still `import` this fixture whenever the
 * BASE run had external dependencies to mock — without this, every one of them fails
 * with "Cannot find module '.../fixtures/mock.fixture'" and the whole suite reports a
 * structurally-empty result (see docs/design/execute-suite-deps-silent-failure-fix.md).
 * Best-effort: a missing base fixture (base run had no external deps either) is not an
 * error — it matches scaffold()'s own no-mock behavior, just carried forward instead of
 * freshly decided.
 */
async function hydrateCarriedMockFixture(
  ctx: TestModeContext,
  projectId: string,
  baseRunId: string,
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void,
): Promise<void> {
  const srcAbs = join(projectsDir(), projectId, 'runs', baseRunId, 'suite', 'fixtures', 'mock.fixture.ts');
  const destAbs = join(ctx.projectDir, 'fixtures', 'mock.fixture.ts');
  try {
    await mkdir(dirname(destAbs), { recursive: true }); // fixtures/ may not exist yet — matches hydrateCarriedSpecs
    await copyFile(srcAbs, destAbs);
    emit('generate', 'debug', 'Carried forward mock.fixture.ts from base run.');
  } catch {
    // Base run had no mock fixture (no external deps) — nothing to carry, matches
    // scaffold.ts's own no-mock behavior for this run; not an error.
  }
}
```

Call site — `index.ts:2518-2524` (reuse) and `index.ts:2525-2544` (topup), both already
call `hydrateCarriedSpecs`; add the new call right after each, gated on
`!ctx.mockExternalDependencies`:

```ts
if (suiteMode === 'reuse') {
  emit('generate', 'info', `Copying ${baseTestsWithSpec.length} test(s) forward from run ${baseRun!.id} (entire suite, as-is).`);
  carriedSpecs = await hydrateCarriedSpecs(ctx, project.id, baseRun!.id, baseTestsWithSpec, emit);
  if (!ctx.mockExternalDependencies) {
    await hydrateCarriedMockFixture(ctx, project.id, baseRun!.id, emit);
  }
} else if (suiteMode === 'topup') {
  ...
  carriedSpecs = await hydrateCarriedSpecs(ctx, project.id, baseRun!.id, diff.carried, emit);
  if (!ctx.mockExternalDependencies) {
    await hydrateCarriedMockFixture(ctx, project.id, baseRun!.id, emit);
  }
}
```

## Verification plan

- Unit/integration test extending `orchestrator.topup.test.ts`: a fresh run with a
  `TestMode.scaffold()` that writes `fixtures/mock.fixture.ts` (simulating
  `mockExternalDependencies: true`) and specs that `import` it, followed by a reuse run
  — assert `fixtures/mock.fixture.ts` exists in the reuse run's `ctx.projectDir` and its
  contents match the base run's copy byte-for-byte.
- Regression test: a fresh run with NO mock fixture (no external deps) followed by
  reuse — assert `hydrateCarriedMockFixture` is a clean no-op (no file created, no error
  emitted) — matches today's behavior for a project with nothing to mock.
- Regression test (topup-specific): a base run with `mockExternalDependencies: true`,
  followed by a topup run whose own (mocked) dependency detection ALSO returns
  non-empty — assert the topup run's own freshly-scaffolded `mock.fixture.ts` is
  preserved (never overwritten by the carry-forward copy), proving the
  `!ctx.mockExternalDependencies` gate correctly skips the copy when this run already
  has a current one.
- Manual: re-run the exact repro (fresh run against `prj_eQg-UbZR2a`, then "Run Existing
  Suite") and confirm `fixtures/mock.fixture.ts` exists in the new run's suite
  directory, no `"Cannot find module"` errors appear in `results.json`, and the reuse
  run's pass/fail counts are close to the fresh run's (29 passed / 18 failed), not a
  mass `0 passed / 0 failed`.

## Critical files

- `packages/core/src/orchestrator/index.ts` — new `hydrateCarriedMockFixture` function
  (sibling to `hydrateCarriedSpecs`, ~line 4270), call sites at the reuse (~2518-2524)
  and topup (~2525-2544) branches
- `packages/core/src/modes/playwright/scaffold.ts` — `mock.fixture.ts` conditional write
  (248-251), reused as-is, confirms the gap and the gate this fix mirrors
- `packages/core/src/orchestrator/orchestrator.topup.test.ts` — existing "zero AI calls"
  guarantee (line 325) that this fix must not violate; new tests added here
