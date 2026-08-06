# Fix: reuse-suite runs lose Tier B auth, causing a pass-rate drop vs. the fresh run

## Bug report

**Symptom**: Running "Run Existing Suite" (reuse mode) against a previously-generated
suite produces a lower pass rate than the original fresh run, even though the exact
same suite is being reused with no changes.

**Expected**: since the existing suite is reused verbatim, the number of test cases,
passed/failed counts, pass rate, and all summary metrics should stay the same unless
the suite itself changes.

## Evidence

Two runs of the same project (`prj_U69CQO4XrA`, target `http://localhost:4202/`) were
compared via their full timelines:

| | Fresh run (`run_bK--BMAifc`) | Reuse run (`run_-uVs13oWoO`) |
|---|---|---|
| Total | 151 | 149 |
| Passed | 39 | 27 |
| Failed | 53 | 31 |
| **Blocked** | **0** | **77** |
| Rate | 26% | 18% |

The dominant signal is **blocked jumping from 0 to 77** — not scattered flakiness.
Comparing the two timelines line-by-line, the reuse run's log contains a line that
never appears in the fresh run's log at all:

```
[execute] auth setup failed; Tier B outcomes classified as blocked
```

...immediately followed by every single Tier B (authenticated) spec — every Dashboard,
Points, Vouchers, Email, Password, and Delete-Account test — being marked with "No
video captured... worth a closer look," i.e. mass-blocked. The fresh run has zero such
lines; its Tier B tests ran for real and produced genuine pass/fail outcomes.

The reuse run's log also shows:

```
12:56:17  explore  Skipping exploration (reuse mode).
```

## Root cause (confirmed against source)

1. **Reuse mode never populates `ctx.exploration`.**
   `packages/core/src/orchestrator/index.ts:2094-2097`:
   ```ts
   if (suiteMode === 'reuse') {
     // No new specs are ever generated in reuse mode, so there is nothing for
     // a DOM snapshot to ground — skip the live browser pass entirely.
     emit('explore', 'debug', 'Skipping exploration (reuse mode).');
   } else if (effectiveBaseUrl) {
     ...
   ```
   The entire EXPLORE block — including `loadExplorationCache(project.id,
   effectiveBaseUrl)` (line 2160) and the two `ctx.exploration = ...` assignments
   (lines 2237, 2306) — lives only inside the `else if (effectiveBaseUrl)` branch. In
   reuse mode none of that runs, and `ctx.exploration` is never assigned anywhere else
   in the file (confirmed: those are the only two assignment sites). So `ctx.exploration`
   is simply `undefined` for the entire reuse run.

2. **Tier B auth setup depends on `ctx.exploration` for real login selectors.**
   `packages/core/src/modes/playwright/execute.ts:138-153`:
   ```ts
   const verified = ctx.exploration?.crawl?.verifiedLogin;
   const discovered = verified?.pageUrl ?? ctx.exploration?.loginCandidates?.[0]?.url;
   if (discovered) {
     env.HEALIX_TIERB_LOGIN_URL = discovered;
   } else if (ctx.baseUrl) {
     env.HEALIX_TIERB_LOGIN_URL = new URL('/login', ctx.baseUrl).toString();
   }
   if (verified) {
     env.HEALIX_TIERB_LOGIN_IDENTIFIER_SELECTOR = verified.identifierSelector;
     env.HEALIX_TIERB_LOGIN_PASSWORD_SELECTOR = verified.passwordSelector;
     ...
   }
   ```
   With `ctx.exploration` undefined, `verified`/`discovered` are undefined. The login
   URL falls back to a guessed `/login` path, and the selector env vars are never set at
   all — `loginForm()` (`templates.ts:597+`) then falls back to its own generic
   selector-guessing instead of the selectors EXPLORE actually verified work on this
   app. On a real app whose login markup doesn't match that generic guess, the
   `auth-setup` Playwright test's real login attempt genuinely fails.

3. **That failure cascades into mass "blocked" classification.**
   `execute.ts:1567-1581`:
   ```ts
   const freshSetup = report ? findAuthSetupOutcome(report) : { failed: false, error: '' };
   ...
   const auth: AuthSignals = { setupFailed: freshSetup.failed || checkpointSetup.failed, ... };
   if (auth.setupFailed) {
     emit(ctx, '[execute] auth setup failed; Tier B outcomes classified as blocked', { ... });
   }
   ```
   This is the exact source of the observed log line.
   `AUTH_SETUP_FAILURE_MARKER = 'Tier B auth setup failed'` (`execute.ts:637`) is
   stamped on every Tier B row, and `triage/rules.ts:60` matches that marker to
   reclassify all of them as `blocked` — which is why 77 tests, not just one, flip
   status.

4. **Reuse mode has no existing mechanism to inherit exploration data.**
   `hydrateCarriedSpecs` (`index.ts:4153-4189`) only copies `.spec.ts` files
   byte-for-byte from the base run's suite folder — it never reads
   `exploration-cache.json`, never reloads exploration from the base run's stored
   artifact/DB. Exploration data is simply unavailable to a reuse run today, by
   omission, not by design intent (the code comment at 2094-2097 only reasons about
   *why generation* doesn't need a fresh DOM snapshot — it doesn't address that
   Tier B auth setup still needs the previously-verified login selectors).

**Conclusion**: this is a genuine Healix orchestrator bug — not app flakiness, not a
test-authoring issue. Reuse mode's "skip EXPLORE" optimization has an unintended side
effect: it silently starves Tier B auth setup of the login grounding it needs,
causing every authenticated test to be misclassified as blocked, which is exactly why
the pass rate drops between a fresh run and a reuse run of the identical suite.

## Fix

**Revised design** (see rationale below): guessing selectors must be the *last*
resort, not the immediate fallback on a cache miss — a guess can fail exactly the same
way the current bug does, just with a warning logged instead of silently, which does
not actually solve "pass rate drops on reuse." The fix is a 3-tier fallback, in order
of preference:

1. **Cached exploration artifact** (cheap, no crawl) — `loadExplorationCache`.
2. **Bounded, targeted, real login discovery** (cheap-ish, one real crawl of a single
   page) — only runs when tier 1 misses.
3. **Guessed selectors** (today's existing fallback) — only as an absolute last
   resort, when tier 2 also fails to produce a verified login.

```ts
if (suiteMode === 'reuse') {
  emit('explore', 'debug', 'Skipping exploration (reuse mode).');
  if (effectiveBaseUrl) {
    // Tier 1: cheap — reuse the cached artifact from the run being reused.
    const cachedExploration = loadExplorationCache(project.id, effectiveBaseUrl, Infinity);
    if (cachedExploration) {
      ctx.exploration = cachedExploration;
    } else if (project.testUsername && project.testPassword) {
      // Tier 2: no cache — do a REAL, bounded, single-page login discovery
      // instead of guessing. maxRoutes: 1 stops crawlWithAuth's BFS after the
      // first page, so this is a fraction of a full EXPLORE pass, but still
      // gets genuinely VERIFIED selectors (crawlWithAuth's attemptLogin
      // actually submits and confirms), not a guess.
      emit('explore', 'info', 'No cached exploration artifact; running a bounded login-only discovery for reuse mode.');
      const discovery = await crawlWithAuth(browser, effectiveBaseUrl, {
        maxRoutes: 1,
        wallClockBudgetMs: REUSE_LOGIN_DISCOVERY_BUDGET_MS, // small, e.g. 60_000
        credentials: { username: project.testUsername, password: project.testPassword },
      }).catch(() => null);
      if (discovery?.verifiedLogin) {
        ctx.exploration = { crawl: discovery, loginCandidates: discovery.loginCandidates };
      } else {
        // Tier 3: last resort, unchanged from today's fallback behavior.
        emit('explore', 'warn', 'Login-only discovery failed; Tier B login will use guessed selectors.');
      }
    } else {
      emit('explore', 'warn', 'No cached exploration artifact and no test credentials configured; Tier B login will use guessed selectors.');
    }
  }
}
```

Notes:
- `loadExplorationCache` is already imported at `index.ts:48` — no new import needed.
  Passing `Infinity` (or another suitably large `maxAgeMs`) bypasses the normal 24h
  staleness window used by fresh EXPLORE runs — appropriate here since reuse mode is
  explicitly re-running the *same* prior suite against the *same* app, not doing a
  drift-sensitive fresh crawl.
- **Tier 2 is a real crawl, not a guess** — `crawlWithAuth` (`crawler.ts:1389-1448`)
  with `maxRoutes: 1` stops the BFS after a single page, but its `attemptLogin`/
  `attemptLoginViaToggle` (`login.ts:309-344`) genuinely submits and verifies the
  login, producing the same `verifiedLogin` shape a full EXPLORE pass would — the cost
  saved vs. full EXPLORE comes from skipping the other ~59 routes' worth of BFS/
  click-probing, not from skipping real verification. Confirmed no smaller/cheaper
  "detect without submitting" primitive exists in the codebase today
  (`findLoginSubmitButton`/`findNearestUsernameField`/`waitForCredentialForm` in
  `login.ts` are private helpers, only reachable via a real login attempt) — building
  one would be new code, not a reuse of an existing export, so tier 2 deliberately
  reuses `crawlWithAuth` as-is rather than inventing a new "read-only" login-detection
  path.
- A new constant `REUSE_LOGIN_DISCOVERY_BUDGET_MS` (proposed: 60_000 — a quarter of
  `DEFAULT_BUDGET_MS = 240_000` at `crawler.ts:160`, matching the sizing convention
  used elsewhere, e.g. `DIRECTED_REEXPLORE_PER_ROUTE_BUDGET_MS`'s historical precedent)
  bounds tier 2 so a slow/unreachable app can't stall a reuse run indefinitely; on
  timeout the `.catch(() => null)` degrades straight to tier 3.
- This only rehydrates in-memory `ctx.exploration` for the duration of this run; it
  does not touch the cache file itself, so it composes cleanly with the unrelated
  `clearExplorationCache` flow (see [[remove-cached-exploration]] context from a prior
  session) — clearing the cache before a reuse run correctly triggers tier 2 (a real,
  bounded rediscovery) rather than silently reusing stale data forever, and rather than
  immediately falling back to a guess.
- Fail-open by construction end-to-end: cache miss → real bounded discovery attempt →
  only then guess. A project with no test credentials configured at all skips
  straight to the tier-3 warn (nothing to discover with), exactly matching today's
  behavior for that specific case — this is a strict improvement over today for every
  other case, never a regression risk.

### Why guessing-first was rejected

The original draft of this fix treated "no cache → log a warning → guess" as
acceptable. That is insufficient: guessed selectors are exactly what caused the
regression in the first place (the bug reproduces identically whether `ctx.exploration`
is undefined because EXPLORE was skipped, or because the cache happened to be missing)
— logging a warning about it doesn't prevent the same mass-blocked-Tier-B outcome from
recurring, it just makes the failure visible instead of silent. A real, bounded,
verified rediscovery (tier 2) is the only way to actually fix the pass-rate-drop
symptom in the no-cache case, not merely explain it after the fact.

## Verification plan

- **Tier 1 (cache hit)**: new unit test on the reuse-mode branch in `index.ts` — with a
  populated `exploration-cache.json` for the project/baseUrl, `ctx.exploration` is
  rehydrated from it and matches the cached artifact exactly (`crawl.verifiedLogin`,
  `loginCandidates`, `crawl.routes` all present, byte-identical to what a real EXPLORE
  pass would have produced). No crawl call happens in this path (assert
  `crawlWithAuth` is never invoked).
- **Tier 2 (cache miss, credentials present)**: unit test with `loadExplorationCache`
  mocked to return `null` and `project.testUsername`/`testPassword` set — asserts
  `crawlWithAuth` is called with `maxRoutes: 1` and the configured budget, and that a
  successful result (fake browser returning a verified login) populates
  `ctx.exploration` with real `verifiedLogin` data, not a guess. A second case: a
  timed-out/failed `crawlWithAuth` call (rejected promise) falls through to tier 3
  cleanly, no throw escaping the reuse-mode branch.
- **Tier 3 (last resort)**: regression test — no cached artifact AND no credentials
  configured → `ctx.exploration` stays `undefined`, the `warn` log fires, and existing
  guessed-selector behavior is exercised exactly as before (no behavior change for
  projects without a prior EXPLORE pass or without test credentials at all).
- Integration test extending `orchestrator.reuse-mode.test.ts` (or equivalent): a fake
  provider/mode DI run through `createOrchestrator()` in reuse mode, asserting Tier B
  auth setup succeeds (using either the rehydrated-from-cache or the tier-2-discovered
  `verifiedLogin` selectors) and Tier B tests are NOT mass-classified as blocked in
  either case.
- Manual: re-run the "give me moonlight" suite (fresh, then reuse) and confirm the
  reuse run's summary metrics (total/passed/failed/blocked/rate) now match the fresh
  run's. Additionally, manually delete the project's `exploration-cache.json` before a
  reuse run and confirm tier 2 fires (a real, bounded single-page login discovery, not
  a guess) and Tier B tests still pass, proving the no-cache case is genuinely fixed,
  not just made visible via a warning.

## Critical files

- `packages/core/src/orchestrator/index.ts` — reuse-mode EXPLORE-skip branch
  (~2094-2097), fix site for the 3-tier fallback (cache → bounded real discovery →
  guess); new constant `REUSE_LOGIN_DISCOVERY_BUDGET_MS`
- `packages/core/src/orchestrator/exploration-cache.ts` — `loadExplorationCache`,
  reused as-is, no changes (tier 1)
- `packages/core/src/browser/crawler.ts` — `crawlWithAuth` (1389-1448, exported),
  reused as-is with `maxRoutes: 1` for tier 2's bounded single-page login discovery;
  `DEFAULT_BUDGET_MS` (160) referenced only for sizing the new budget constant, not
  changed
- `packages/core/src/browser/login.ts` — `attemptLogin`/`attemptLoginViaToggle`
  (309-344, exported), reused as-is via `crawlWithAuth`'s internal call — no new
  "read-only selector detection" primitive is introduced; confirmed no such primitive
  exists today (private helpers `findLoginSubmitButton`/`findNearestUsernameField`/
  `waitForCredentialForm` only run as part of a real login attempt)
- `packages/core/src/modes/playwright/execute.ts` — `ctx.exploration?.crawl
  ?.verifiedLogin` / `ctx.exploration?.loginCandidates` consumption (138-153),
  `AUTH_SETUP_FAILURE_MARKER` (637), auth-setup-failure detection (1567-1581) — reused
  as-is, confirms the fix is sufficient without touching this file
- `packages/core/src/orchestrator/triage/rules.ts` — `AUTH_SETUP_FAILURE_MARKER`
  matching (~line 60) that reclassifies Tier B rows as blocked — reused as-is

## Note on `directed-reexplore.ts`

While investigating tier 2, it was confirmed that `packages/core/src/orchestrator/
directed-reexplore.ts` (the module documented in the separate `feature/gapfill-using-
reexploration` plan for escape-hatch/fixMe gap remediation) does not exist under
`src/` **on this branch** (`feature/pass-rate-dec-with-rerun`, cut from `dev`) — only
stale compiled leftovers appear at `packages/core/dist/orchestrator/directed-reexplore.
{js,d.ts}`. This is expected, not a bug: that feature lives on
`feature/gapfill-using-reexploration` and has not been merged into `dev` yet, so it is
simply absent from a branch cut from `dev`. Unrelated to the present fix either way —
that module replays an *already-known* login for a different purpose (regenerating
escape-hatched specs), not discovering one from scratch for reuse mode. Flagging only
so the two features aren't confused when both branches eventually merge.
