# Fix: a failed suite-dependency install is silently accepted, producing a false "0 passed, 0 failed" instead of a real error

## Bug report

A real run against a reused suite (98 specs copied forward) produced:

```
17:21:45  generate  [validate] Skipping parse-check for 98 spec(s): suite dependencies appear to be missing
17:21:45  generate  Generated 98 spec(s).
17:21:45  execute   Executing 98 spec(s) via Playwright
17:21:48  execute   [execute] missing suite dependency; re-running npm install…
17:21:48  execute   [execute] npm install complete
17:21:48  execute   [execute] re-running suite after dependency install
17:21:50  execute   [execute] Playwright run finished
17:21:50  execute   Execution complete: 0 passed, 0 failed.
17:21:50  execute   Dropped 98 pre-registered test row(s) that never executed.
17:21:50  done      Run verified nothing: no runnable specs were produced.
```

The whole "detect missing deps → reinstall → re-run 98 specs" cycle completed in **~2 seconds** — implausible for a real `npm install` plus a real Playwright run of 98 tests. The run ends in a clean-looking `0 passed, 0 failed` rather than any visible error, and the terminal message (`"Run verified nothing: no runnable specs were produced"`) is identical to a DIFFERENT, already-fixed bug (`fix/reuse-run-testing-scope-mismatch`, already merged — see "Related but distinct" below), which made it easy to initially misattribute.

## Root cause

Confirmed directly against `packages/core/src/modes/playwright/execute.ts`:

1. **`ensureSuiteDeps()` (lines 492-517)** — the _first_ place deps get installed (called from both `validate.ts`'s parse-check gate and `execute()` itself). Its "are deps present" check is a bare existence probe:

   ```ts
   const marker = join(ctx.projectDir, 'node_modules', '@playwright');
   try {
     await access(marker);
     return;
   } catch {
     /* fall through to install */
   }
   ```

   This only proves the `@playwright` directory exists — not that it (or anything else the suite needs) actually resolves correctly. And when the subsequent `npm install` itself fails:

   ```ts
   if (res.code === 0) {
     emit(ctx, '[execute] suite deps installed');
   } else {
     const tail = /* ...stderr tail... */;
     emit(ctx, '[execute] npm install did not exit cleanly; continuing', { code: res.code, tail });
   }
   ```

   ...it logs the failure and **continues anyway** — by design, per the function's own comment, but this is the first place a genuinely broken install gets silently waved through.

2. **The retry path inside `execute()` itself (lines 1520-1557)** — triggered when the first Playwright invocation's exit code plus stderr/stdout match `looksLikeMissingSuiteDeps` (a `Cannot find module` / `MODULE_NOT_FOUND` pattern, line 537-539):

   ```ts
   if (looksLikeMissingSuiteDeps(cmd)) {
     emit(ctx, '[execute] missing suite dependency; re-running npm install…');
     const depsInstall = await runCommand(
       ctx,
       'npm',
       ['install', '--no-audit', '--no-fund', '--silent'],
       INSTALL_TIMEOUT_MS,
     );
     emit(ctx, '[execute] npm install complete', { code: depsInstall.code }); // <-- always "complete", never checked
   }
   emit(ctx, '[execute] re-running suite after dependency install');
   startedAt = Date.now();
   cmd = await runPlaywright(ctx, invertFile); // <-- retried unconditionally
   ```

   **`depsInstall.code` is captured and logged, but never branched on.** A fast, failed, or no-op `npm install` (broken/partial `node_modules`, no network, a lockfile mismatch) is reported as `"npm install complete"` regardless of whether it actually succeeded, and Playwright is unconditionally re-invoked against still-broken dependencies.

3. **Only one retry is attempted** — if the reinstalled deps are still broken, there's no second attempt; whatever the second Playwright invocation produces is taken as final.

4. **The empty-result path never surfaces this as an error.** After the retry:
   ```ts
   let report = await readResultsJson(ctx.projectDir, startedAt);
   if (!report) report = parseStdoutJson(cmd.stdout);
   ...
   if (report) {
     parsed = parseReport(report, auth);   // <-- a validly-parsed but EMPTY report (0 specs discovered)
                                            //     takes this branch and produces a clean 0/0 with
                                            //     NO diagnostic at all
   } else {
     parsed = parseSummaryText(...);
     if (parsed.results.length === 0 && parsed.passed === 0 && parsed.failed === 0 && priorEntries.length === 0) {
       emit(ctx, 'Could not parse Playwright results; suite may have failed to start', { ... });  // <-- only fires
                                                                                                    //     when NO report
                                                                                                    //     exists at all
     }
   }
   ```
   The diagnostic-log branch only fires when `readResultsJson`/`parseStdoutJson` find **nothing at all**. If Playwright's own JSON reporter manages to write a syntactically valid but empty report (e.g. it loaded its config fine but discovered zero test files, or crashed before collecting tests yet still flushed an empty report), that takes the `if (report)` branch straight into `parseReport`, producing a legitimate-looking `0 passed / 0 failed` with **zero indication that dependencies were ever a problem.**

**Net effect**: a genuinely broken/failed dependency reinstall is never distinguished from a successful one, is retried exactly once regardless, and if the retry also fails to produce real results, the whole thing degrades into a silent, clean-looking empty run instead of a visible error — which is what then cascades into `"Dropped 98 pre-registered test row(s) that never executed"` and the final `"Run verified nothing"` message.

## Related but distinct — do not conflate

`fix/reuse-run-testing-scope-mismatch` (already merged into `dev`, already present in this branch at `index.ts:2057`) fixes a **different** bug that happens to produce the identical final message:

```ts
testingScope: suiteMode === 'reuse' || suiteMode === 'topup' ? 'both' : (opts.testingScope ?? 'both'),
```

That bug: a caller-supplied `testingScope` narrower than the carried suite's own tiers (e.g. the desktop compose form defaulting to `'frontend'`) made Playwright's `--project` filter exclude every carried tier — a **plan-time scope-filtering** issue, nothing to do with dependency installation. It's already fixed and was confirmed present in this codebase; it is **not** what caused the run described above (test selection had all 98 specs — the failure happened after Playwright was actually invoked, during dependency resolution/execution, not test selection).

## Fix

### 1. Check the install exit code before declaring success (both call sites)

**`ensureSuiteDeps()` (`execute.ts:492-517`)** — already logs the failure reasonably; the remaining gap is that its _caller_ (`validate.ts`'s parse-check gate) treats "deps appear missing" as a reason to skip validation entirely rather than surfacing install failure specifically. Lower priority than #2 below since this path already degrades gracefully (skip parse-check, don't block generation) rather than silently reporting fake success.

**The retry path (`execute.ts:1538-1550`) — the primary fix site:**

```ts
if (looksLikeMissingSuiteDeps(cmd)) {
  emit(ctx, '[execute] missing suite dependency; re-running npm install…');
  const depsInstall = await runCommand(
    ctx,
    'npm',
    ['install', '--no-audit', '--no-fund', '--silent'],
    INSTALL_TIMEOUT_MS,
  );
  if (depsInstall.code === 0) {
    emit(ctx, '[execute] npm install complete');
  } else {
    const tail = stripAnsi(depsInstall.stderr || depsInstall.stdout)
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-8)
      .join(' | ');
    emit(
      ctx,
      '[execute] npm install failed; suite dependencies remain broken',
      {
        code: depsInstall.code,
        tail,
      },
      'error',
    ); // or 'warn' depending on the emit() severity convention already used elsewhere in this file
    // Do not re-run Playwright against dependencies we KNOW are still broken —
    // fall through to the existing "no runnable specs" reporting path instead
    // of wasting a full suite invocation that can only fail the same way.
  }
}
```

Only re-invoke `runPlaywright` when the install actually succeeded (or wasn't needed). A failed install should short-circuit straight to an explicit failure state rather than attempting the doomed re-run.

### 2. Distinguish "empty because nothing to run" from "empty because the suite never actually ran"

Extend the `report` truthy-branch (around `execute.ts:1584-1585`) so a **structurally-empty** report (zero suites/specs discovered, as opposed to zero pass/fail among real skipped/pending entries) is treated the same as the no-report case — i.e. also triggers the `'Could not parse Playwright results; suite may have failed to start'`-style diagnostic, rather than silently taking the clean `parseReport` path:

```ts
const reportIsStructurallyEmpty = (r: PwReport) =>
  !r.suites || r.suites.every((s) => (s.specs?.length ?? 0) === 0 && (s.suites?.length ?? 0) === 0);

if (report && !reportIsStructurallyEmpty(report)) {
  parsed = parseReport(report, auth);
} else {
  parsed = parseSummaryText(`${cmd.stdout}\n${cmd.stderr}`);
  if (
    parsed.results.length === 0 &&
    parsed.passed === 0 &&
    parsed.failed === 0 &&
    priorEntries.length === 0
  ) {
    emit(ctx, 'Could not parse Playwright results; suite may have failed to start', {
      exitCode: cmd.code,
      timedOut: cmd.timedOut,
      structurallyEmptyReport: !!report,
      tail: stripAnsi(cmd.stderr || cmd.stdout)
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-8)
        .join(' | '),
    });
  }
}
```

This ensures a suite that "ran" but discovered zero tests (e.g. broken `node_modules` prevented Playwright from even collecting specs, but it still emitted a valid empty JSON reporter file) surfaces the same operator-visible diagnostic as a suite that crashed before producing any report at all — instead of the two cases silently diverging into "clean empty run" vs "error."

### 3. Optional hardening: verify the marker more precisely, and loop the retry once more

- `ensureSuiteDeps`'s `access(node_modules/@playwright)` marker only proves a directory exists, not that install actually completed for everything the suite needs. Consider also checking a package the generated specs actually import at runtime (e.g. whatever `fixtures/action-highlighter` or similar shared fixture depends on) — lower priority, since `looksLikeMissingSuiteDeps`'s later `Cannot find module` detection already catches this at the point of actual failure; this would just catch it earlier/cheaper.
- The single-retry limit (`execute.ts:1520-1557`) is a reasonable bound to keep — but pair it with #1 above so a still-broken install after the one retry produces a definitive error rather than looping or silently succeeding.

## Verification plan

- Unit test on `execute()`'s retry path: `runCommand` mocked so the first Playwright invocation reports a `Cannot find module` failure, the reinstall's `runCommand` mock returns a non-zero exit code — assert Playwright is **not** re-invoked a second time, and the returned `ExecOutcome`/emitted events clearly signal a dependency-install failure (not a silent `0 passed / 0 failed`).
- Unit test: same setup but the reinstall succeeds (`code: 0`) — assert Playwright **is** re-invoked exactly once more, unchanged from today's behavior.
- Unit test on the structurally-empty-report branch: `readResultsJson` mocked to return a syntactically valid `PwReport` with `suites: []` — assert this takes the diagnostic path (`'Could not parse Playwright results...'`), not the silent `parseReport` path.
- Regression test: a report with real entries (including legitimately empty/all-skipped tiers, e.g. a `tierC-api`-only suite with nothing to run for `tierA-public`) must **not** be misclassified as structurally empty — the check must key on the WHOLE report having zero specs anywhere, not any single tier/project being empty.
- Manual: reproduce the original bug by corrupting a suite's `node_modules` before a reuse run and confirm the run now surfaces a clear dependency-install error instead of a clean `0 passed / 0 failed`.

## Critical files

- `packages/core/src/modes/playwright/execute.ts` — `ensureSuiteDeps` (492-517, lower-priority secondary hardening), the retry block (1520-1557, primary fix site), the report-branch logic (1560-1605, secondary fix site for structurally-empty detection)
- `packages/core/src/modes/playwright/validate.ts` — `ensureSuiteDeps()` caller (~line 250), reused as-is; only relevant if pursuing the lower-priority #1 hardening above
