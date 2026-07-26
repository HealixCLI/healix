/**
 * Real-Playwright integration tests for the execution-time-reduction PR
 * (#58): a single combined `npx playwright test` invocation now schedules
 * tierA/tierC concurrently and sequences tierB after auth-setup via each
 * project's own `dependencies` config, instead of one process per tier — and
 * a write-through per-test checkpoint lets a resumed run skip only what
 * already finished. Every other test in this package fakes mode.execute() or
 * mocks cross-spawn (see execute.test.ts's own header comment); NOTHING
 * exercises a real Playwright process. These two tests do: a real `npm
 * install` (fast — @playwright/test resolves from the npm registry in
 * seconds) and a real `npx playwright test` run against Chromium, which must
 * already be installed locally (`npx playwright install chromium` if not).
 *
 * Skipped in CI (describe.skipIf(process.env.CI)) — same CI-detection
 * convention already used elsewhere in this codebase (see computeWorkers()/
 * retries in templates.ts). No browser-install step exists in
 * .github/workflows/ci.yml, so this stays local-only until/unless that's
 * added deliberately.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GeneratedSpec, TestModeContext } from '../types.js';
import { execute, readCheckpointEntries } from './execute.js';
import { scaffold } from './scaffold.js';
import { EXEC_CHECKPOINT_FILENAME } from './templates.js';

describe.skipIf(!!process.env.CI)('execute() — real Playwright process (local-only)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'healix-execute-real-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HEALIX_WORKERS;
  });

  function makeCtx(overrides: Partial<TestModeContext> = {}): TestModeContext {
    return {
      projectDir: dir,
      provider: {} as TestModeContext['provider'],
      target: {} as TestModeContext['target'],
      browser: {} as TestModeContext['browser'],
      ...overrides,
    };
  }

  async function writeSpec(relPath: string, contents: string): Promise<void> {
    const abs = join(dir, relPath);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, contents, 'utf-8');
  }

  it('dependency ordering: a failing auth-setup (no credentials configured) blocks tierB-auth, does not skip it silently', async () => {
    const ctx = makeCtx();
    await scaffold(ctx);

    await writeSpec(
      'tests/tierA-public/home.spec.ts',
      `import { test, expect } from '@playwright/test';
test('home renders', async ({ page }) => {
  await page.goto('data:text/html,<h1>Home</h1>');
  await expect(page.locator('h1')).toHaveText('Home');
});
`,
    );
    await writeSpec(
      'tests/tierB-auth/dashboard.spec.ts',
      `import { test, expect } from '@playwright/test';
test('dashboard renders', async ({ page }) => {
  await page.goto('data:text/html,<h1>Dashboard</h1>');
  await expect(page.locator('h1')).toHaveText('Dashboard');
});
`,
    );

    const specs: GeneratedSpec[] = [
      { path: 'tests/tierA-public/home.spec.ts', title: 'home renders', tier: 'tierA-public', contents: '' },
      {
        path: 'tests/tierB-auth/dashboard.spec.ts',
        title: 'dashboard renders',
        tier: 'tierB-auth',
        contents: '',
      },
    ];

    // No ctx.credentials -> authSetupContents()'s generated fixture throws
    // immediately (missing email/password/loginUrl) -> auth-setup FAILS ->
    // Playwright's real `dependencies` config must not run tierB-auth's
    // test at all; execute()'s classification turns that into `blocked`,
    // not a silently-passing or silently-dropped result.
    const outcome = await execute(ctx, specs);

    expect(outcome.passed).toBe(1);
    expect(outcome.blocked).toBe(1);
    // The failing auth-setup itself also surfaces as its own `failed`
    // result (root-cause visibility — see checkpointEntriesToOutcome's /
    // parseReport's doc comments), alongside the Tier B test it blocked.
    expect(outcome.failed).toBe(1);
    const dashboard = outcome.results.find((r) => r.title === 'dashboard renders');
    expect(dashboard?.status).toBe('blocked');
    expect(dashboard?.error).toContain('Auth setup failed');
  }, 90_000);

  it('abort mid-run genuinely stops the underlying work: a real process-tree kill, not just a detached background process', async () => {
    // Regression test for the process-tree-kill fix in runPlaywright()'s
    // kill() — on Windows, the OLD code called child.kill(signal) on only
    // the top-level npx process, leaving the actual node process running
    // Playwright (and any browser it launched) running to real completion
    // in the background even after the caller received an "aborted"
    // outcome. The fix shells out to `taskkill /F /T /PID` on Windows
    // (matching target/launcher.ts's / exec/run-cli.ts's own killTree()).
    const ctx1Signal = new AbortController();
    // Force single-worker sequential execution so 'first' reliably finishes
    // before 'second' starts — this test's timing (abort while 'second' is
    // still mid-wait) depends on that order. HEALIX_WORKERS is read directly
    // by the generated playwright.config.ts (see templates.ts) and passed
    // through by suiteEnv()'s HEALIX_-prefix allowlist, so this reliably pins
    // workers to 1 regardless of the config's own literal text — unlike a
    // source-patch via string-replace, which silently no-ops (and previously
    // did, letting 'first'/'second' run concurrently) if that literal ever
    // changes shape.
    process.env.HEALIX_WORKERS = '1';
    const ctx = makeCtx({ signal: ctx1Signal.signal });
    await scaffold(ctx);

    const runLog = join(dir, 'kill-test-run-log.txt');
    await writeSpec(
      'tests/tierA-public/kill.spec.ts',
      `import { test, expect } from '@playwright/test';
import fs from 'node:fs';
test('first', async ({ page }) => {
  await page.goto('data:text/html,<h1>First</h1>');
  await expect(page.locator('h1')).toHaveText('First');
  fs.appendFileSync(${JSON.stringify(runLog)}, 'first\\n');
});
test('second', async () => {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  fs.appendFileSync(${JSON.stringify(runLog)}, 'second\\n');
});
`,
    );

    const specs: GeneratedSpec[] = [
      { path: 'tests/tierA-public/kill.spec.ts', title: 'first', tier: 'tierA-public', contents: '' },
      { path: 'tests/tierA-public/kill.spec.ts', title: 'second', tier: 'tierA-public', contents: '' },
    ];

    const attempt = execute(ctx, specs);
    // Poll the write-through checkpoint until 'first' has landed, then
    // abort — 'second' is still asleep in its 4s timeout at that point.
    const deadline = Date.now() + 30_000;
    let sawFirst = false;
    while (Date.now() < deadline) {
      const entries = await readCheckpointEntries(dir);
      if (entries.some((e) => e.title === 'first')) {
        sawFirst = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sawFirst).toBe(true);
    ctx1Signal.abort();
    const outcome = await attempt;

    expect((outcome.raw as { aborted?: boolean } | undefined)?.aborted).toBe(true);
    // Give the killed process a moment it does NOT need if the fix works —
    // if the underlying test process were still alive, this is well short
    // of the 4s sleep it would need to append 'second' for real.
    await new Promise((r) => setTimeout(r, 1_000));
    const log = readFileSync(runLog, 'utf-8');
    expect(log).toContain('first');
    expect(log).not.toContain('second');
  }, 90_000);

  it('resume: a real, product-written checkpoint key genuinely makes Playwright skip that test via --test-list-invert (not just JSON bookkeeping)', async () => {
    const ctx = makeCtx();
    await scaffold(ctx);

    const runLog = join(dir, 'run-log.txt');
    await writeSpec(
      'tests/tierA-public/two.spec.ts',
      `import { test, expect } from '@playwright/test';
import fs from 'node:fs';
test('first', async ({ page }) => {
  await page.goto('data:text/html,<h1>First</h1>');
  await expect(page.locator('h1')).toHaveText('First');
  fs.appendFileSync(${JSON.stringify(runLog)}, 'first\\n');
});
test('second', async ({ page }) => {
  await page.goto('data:text/html,<h1>Second</h1>');
  await expect(page.locator('h1')).toHaveText('Second');
  fs.appendFileSync(${JSON.stringify(runLog)}, 'second\\n');
});
`,
    );

    const specs: GeneratedSpec[] = [
      { path: 'tests/tierA-public/two.spec.ts', title: 'first', tier: 'tierA-public', contents: '' },
      { path: 'tests/tierA-public/two.spec.ts', title: 'second', tier: 'tierA-public', contents: '' },
    ];

    // Run to completion for real once, capturing the REAL, product-written
    // checkpoint entry for 'first' the moment it lands — before this run's
    // own successful completion clears the checkpoint file at the end.
    const firstRun = execute(ctx, specs);
    const deadline = Date.now() + 30_000;
    let capturedEntry: Awaited<ReturnType<typeof readCheckpointEntries>>[number] | undefined;
    while (Date.now() < deadline && !capturedEntry) {
      const entries = await readCheckpointEntries(dir);
      capturedEntry = entries.find((e) => e.title === 'first');
      if (!capturedEntry) await new Promise((r) => setTimeout(r, 100));
    }
    expect(capturedEntry).toBeDefined();
    await firstRun; // let the real run finish naturally

    // Reset run-log.txt and seed a FRESH checkpoint using that captured,
    // real key, then run again: 'first' must be genuinely skipped (never
    // appends to run-log.txt this time) while 'second' — cleared from the
    // prior run's own checkpoint — actually executes.
    writeFileSync(runLog, '', 'utf-8');
    writeFileSync(join(dir, EXEC_CHECKPOINT_FILENAME), `${JSON.stringify(capturedEntry)}\n`, 'utf-8');

    const outcome = await execute(makeCtx(), specs);

    expect(outcome.passed).toBe(2); // 1 restored from the seeded checkpoint + 1 freshly (really) run
    const logAfterResume = readFileSync(runLog, 'utf-8');
    expect(logAfterResume).not.toContain('first'); // proves --test-list-invert really worked
    expect(logAfterResume).toContain('second');
  }, 90_000);
});
