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
import { buildReport, renderReportHtml } from '../../orchestrator/report.js';
import type { Project, Run } from '../../storage/types.js';
import type { TestPlan } from '../types.js';

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

  it('QA request end-to-end: a real test.skip(cond, "reason") is captured by a genuine Playwright run and surfaces correctly in both execute()\'s outcome and the rendered report.html card/row', async () => {
    const ctx = makeCtx();
    await scaffold(ctx);

    await writeSpec(
      'tests/tierA-public/skip.spec.ts',
      `import { test, expect } from '@playwright/test';
test('a passing test', async ({ page }) => {
  await page.goto('data:text/html,<h1>Home</h1>');
  await expect(page.locator('h1')).toHaveText('Home');
});
test('a deliberately skipped test with a real reason', async () => {
  test.skip(true, 'Feature flag X is disabled in this environment');
  expect(true).toBe(false);
});
`,
    );

    const specs: GeneratedSpec[] = [
      {
        path: 'tests/tierA-public/skip.spec.ts',
        title: 'a passing test',
        tier: 'tierA-public',
        contents: '',
      },
      {
        path: 'tests/tierA-public/skip.spec.ts',
        title: 'a deliberately skipped test with a real reason',
        tier: 'tierA-public',
        contents: '',
      },
    ];

    const outcome = await execute(ctx, specs);

    expect(outcome.passed).toBe(1);
    const skippedResult = outcome.results.find(
      (r) => r.title === 'a deliberately skipped test with a real reason',
    );
    expect(skippedResult?.status).toBe('skipped');
    expect(skippedResult?.skipReason).toBe('Feature flag X is disabled in this environment');

    // Full pipeline: feed the REAL outcome (not a hand-built fixture) into
    // buildReport()/renderReportHtml() exactly as orchestrator/index.ts does,
    // to prove the report.html "skipped" card and the row's reason text are
    // both derived correctly from a genuine Playwright run, end to end.
    const run: Run = {
      id: 'run_skip_e2e',
      projectId: 'prj_skip_e2e',
      provider: null,
      mode: 'playwright',
      suiteMode: 'fresh',
      baseRunId: null,
      status: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      pauseReason: null,
      activeDurationMs: null,
    };
    const project: Project = {
      id: 'prj_skip_e2e',
      name: 'Skip E2E Demo',
      mode: 'playwright',
      repoPath: null,
      baseUrl: 'https://app.example.test',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
      credentials: [],
    };
    const plan: TestPlan = {
      summary: 'A real plan.',
      items: [{ id: 'pli_1', title: 'skip e2e', tier: 'tierA-public', intent: 'n/a', scenarios: [] }],
      planSource: 'ai',
    };
    const report = buildReport({ run, project, plan, outcome, triage: [] });
    const html = renderReportHtml(report);

    expect(html).toContain('<div class="n warn">1</div><div>skipped</div>');
    expect(html).toContain('Feature flag X is disabled in this environment');
  }, 90_000);

  it('a test that manually creates its own browser context (browser.newContext()) still gets a real video recorded and attached, via the patched fixture', async () => {
    const ctx = makeCtx();
    await scaffold(ctx);

    // tierA-public (not tierB-auth) deliberately — the fixture patch itself
    // isn't tier-specific, and tierB-auth would additionally require a real
    // auth-setup pass (see the "dependency ordering" test above), which is
    // unrelated to what this test is actually verifying.
    await writeSpec(
      'tests/tierA-public/manual-context.spec.ts',
      `import { test, expect } from '../../fixtures/action-highlighter.js';
test('unauthenticated access is denied', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  // A continuously-animating page (not a static one) — the video encoder
  // compresses a static frame down to almost nothing regardless of how long
  // it runs, which would trip the product's own isBlankVideo() heuristic
  // even though a real recording exists. Real frame-to-frame motion is what
  // that heuristic is actually trying to distinguish from a genuinely-empty
  // recording, so this is the right way to produce a non-trivial file here.
  await page.goto(
    'data:text/html,<h1>Not found</h1><div id="spin" style="width:100px;height:100px;background:red;position:absolute;animation:move 0.3s linear infinite alternate"></div><style>@keyframes move{from{left:0}to{left:300px}}</style>',
  );
  await expect(page.locator('h1')).toHaveText('Not found');
  await page.waitForTimeout(1500);
  await context.close();
});
`,
    );

    const specs: GeneratedSpec[] = [
      {
        path: join(dir, 'tests/tierA-public/manual-context.spec.ts'),
        title: 'unauthenticated access is denied',
        tier: 'tierA-public',
        contents: '',
      },
    ];

    const outcome = await execute(ctx, specs);

    expect(outcome.passed).toBe(1);
    const result = outcome.results.find((r) => r.title === 'unauthenticated access is denied');
    // Video WAS captured — the patched fixture recorded and attached it, so
    // there's nothing to explain (contrast with the pre-fix behavior, which
    // would have left this test with no video at all).
    expect(result?.videoUnavailableReason).toBeUndefined();
    const videoPath = result?.artifacts?.find((a) => /\.webm$/i.test(a));
    expect(videoPath).toBeDefined();
    expect(readFileSync(videoPath!).length).toBeGreaterThan(1024); // a real recording, not a blank stub
  }, 60_000);
});
