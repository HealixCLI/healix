import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOrchestrator } from './index.js';
import type { OrchestratorEvent } from './types.js';
import type { RunReport } from './report.js';
import { getStore, resetStoreForTests, type HealixStore } from '../storage/store.js';
import type {
  CompleteOptions,
  CompletionResult,
  DetectResult,
  HealthResult,
  PlanResult,
  ProviderAdapter,
} from '../providers/types.js';
import type {
  ExecOutcome,
  GeneratedSpec,
  SuiteBundle,
  TestMode,
  TestModeContext,
  TestPlan,
} from '../modes/types.js';
import type {
  DetectedProject,
  LaunchHandle,
  LaunchOptions,
  RepoIndex,
  TargetAdapter,
  UrlProbe,
} from '../target/types.js';
import type { BrowserSurface, BrowserSurfaceOptions, DomSnapshot, Point } from '../browser/types.js';

/**
 * End-to-end test for directed re-exploration (see directed-reexplore.ts's own doc comment):
 * a real orchestrator run (offline DI seam, same pattern as orchestrator.coverage-loop.test.ts)
 * where a fake generate() emits an escape-hatched spec on its first call, proving the whole
 * pipeline — resolve the gap's route, targeted re-crawl via the real crawl() logic against a fake
 * browser, regenerate, splice into `specs`, update the DB row in place, and let EXECUTE run the
 * REGENERATED spec — works end to end, not just in isolated unit tests.
 */

const BASE_URL = 'http://a.test';
const TARGET_URL = `${BASE_URL}/forgot-password`;

const ITEM_A = {
  title: 'Forgot password flow',
  reqTag: 'REQ-1',
  tier: 'tierA-public',
  intent: 'A user can reset a forgotten password.',
  unitKey: 'route:/forgot-password',
};

function fencedPlan(plan: { summary: string; items: unknown[] }): string {
  return ['```json', JSON.stringify(plan), '```'].join('\n');
}

function makeFakeProvider(): ProviderAdapter {
  return {
    id: 'claude',
    label: 'Fake Claude',
    capabilities: ['plan', 'codegen', 'triage', 'computer-use'],
    async detect(): Promise<DetectResult> {
      return { installed: true, binPath: '/fake/claude', version: '1.0.0' };
    },
    async health(): Promise<HealthResult> {
      return {
        provider: 'claude',
        status: 'ready',
        installed: true,
        binPath: '/fake/claude',
        version: '1.0.0',
        authenticated: true,
        model: 'fake-model',
        latencyMs: 1,
        detail: 'OK',
      };
    },
    async plan(): Promise<PlanResult> {
      const text = fencedPlan({ summary: 'fake', items: [ITEM_A] });
      return { provider: 'claude', ok: true, plan: text, raw: {}, detail: 'OK' };
    },
    async complete(_prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
      if (opts?.mode === 'plan') {
        return {
          provider: 'claude',
          ok: true,
          text: fencedPlan({ summary: 'fake', items: [ITEM_A] }),
          raw: {},
          detail: 'OK',
        };
      }
      return { provider: 'claude', ok: true, text: 'not used', raw: {}, detail: 'OK' };
    },
  };
}

const ESCAPE_HATCHED_SPEC = `import { test, expect } from '@playwright/test';

test('[REQ:REQ-1] positive: resets a forgotten password', async ({ page }) => {
  // TODO: unobserved element - the forgot-password link was never clicked during exploration.
  await page.locator('button').click();
});
`;

const REGENERATED_SPEC = `import { test, expect } from '@playwright/test';

test('[REQ:REQ-1] positive: resets a forgotten password', async ({ page }) => {
  await page.locator('[data-testid="reset-password"]').click();
  await expect(page).toHaveURL(/reset/);
});
`;

/**
 * generate() emits an escape-hatched spec on its FIRST call (the main GENERATE pass, called with
 * the full plan) and a clean, resolved spec on any LATER call (directed re-exploration's own
 * regeneration, called with a subset plan) — real evidence the loop actually re-invokes generate()
 * for the affected item, not a scripted single-shot fixture.
 */
function makeFakeMode(genAttempts: { n: number }, opts: { alwaysEscapeHatch?: boolean } = {}): TestMode {
  return {
    id: 'playwright',
    async scaffold(_ctx: TestModeContext): Promise<void> {},
    async generate(_ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
      genAttempts.n += 1;
      const useEscapeHatch = opts.alwaysEscapeHatch || genAttempts.n === 1;
      return plan.items.map((item) => ({
        path: `/fake/${item.reqTag}.spec.ts`,
        title: `[REQ:${item.reqTag}] positive: resets a forgotten password`,
        reqTag: item.reqTag,
        tier: item.tier,
        contents: useEscapeHatch ? ESCAPE_HATCHED_SPEC : REGENERATED_SPEC,
        planItemId: item.id,
      }));
    },
    async execute(_ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
      const results = specs.map((s) => ({
        title: s.title,
        status: 'passed' as const,
        durationMs: 1,
      }));
      return { passed: results.length, failed: 0, blocked: 0, flaky: 0, results };
    },
    async collectArtifacts(_ctx: TestModeContext): Promise<{ dir: string; files: string[] }> {
      return { dir: 'artifacts', files: [] };
    },
    async export(_ctx: TestModeContext): Promise<SuiteBundle> {
      return { dir: 'export', files: [] };
    },
  };
}

function makeFakeTarget(): TargetAdapter {
  return {
    async detect(_repoPath: string): Promise<DetectedProject> {
      return {
        kind: 'frontend',
        framework: null,
        packageManager: null,
        startCommand: null,
        installCommand: null,
        installDir: null,
        port: null,
        baseUrl: null,
      };
    },
    async indexRepo(root: string): Promise<RepoIndex> {
      return { root, files: [], summary: 'fake' };
    },
    async launch(_opts: LaunchOptions): Promise<LaunchHandle> {
      return { baseUrl: BASE_URL, pid: null, async stop(): Promise<void> {} };
    },
    async probeUrl(_url: string): Promise<UrlProbe> {
      return { reachable: true, status: 200 };
    },
  };
}

/**
 * Real crawl()/crawlWithAuth() logic (called both by EXPLORE and by our directed-reexplore
 * module) runs against this fake — tracks every URL visited so the test can assert the targeted
 * re-crawl hit ONLY `/forgot-password`, and returns a real (button) element there so the crawl has
 * something to find, unlike the base URL (deliberately thin, forcing GENERATE's escape hatch).
 */
function makeFakeBrowser(): { browser: BrowserSurface; gotoCalls: string[] } {
  let currentUrl = '';
  const gotoCalls: string[] = [];
  const browser: BrowserSurface = {
    async start(_opts?: BrowserSurfaceOptions): Promise<void> {},
    async goto(url: string): Promise<void> {
      gotoCalls.push(url);
      currentUrl = url;
    },
    async reload(): Promise<void> {},
    async screenshot(): Promise<Buffer> {
      return Buffer.alloc(0);
    },
    async snapshot(): Promise<DomSnapshot> {
      if (currentUrl === TARGET_URL) {
        return {
          url: currentUrl,
          title: 'Forgot password',
          interactiveElements: [
            { role: 'button', name: 'Reset password', selector: '[data-testid="reset-password"]' },
          ],
        };
      }
      return { url: currentUrl, title: currentUrl, interactiveElements: [] };
    },
    async click(_selector: string): Promise<void> {},
    async clickAt(_point: Point): Promise<void> {},
    async type(_selector: string, _text: string): Promise<void> {},
    async pressKey(_key: string): Promise<void> {},
    onFrame(_cb: (png: Buffer) => void): () => void {
      return () => {};
    },
    drainNetworkEvents() {
      return [];
    },
    async exportStorageState() {
      return {};
    },
    async stop(): Promise<void> {},
  };
  return { browser, gotoCalls };
}

let dataDir: string;
const prevDataDir = process.env.HEALIX_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-directed-reexplore-'));
  process.env.HEALIX_DATA_DIR = dataDir;
  resetStoreForTests();
});

afterEach(() => {
  resetStoreForTests();
  if (prevDataDir === undefined) {
    delete process.env.HEALIX_DATA_DIR;
  } else {
    process.env.HEALIX_DATA_DIR = prevDataDir;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('directed re-exploration (offline DI seam, real crawl()/store logic)', () => {
  it('escape-hatch -> targeted re-crawl -> regenerate -> EXECUTE runs the regenerated spec, with no duplicate DB row', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({ name: 'Directed Reexplore', mode: 'playwright', baseUrl: BASE_URL });

    const genAttempts = { n: 0 };
    const events: OrchestratorEvent[] = [];
    const { browser, gotoCalls } = makeFakeBrowser();
    const orchestrator = createOrchestrator({
      provider: makeFakeProvider(),
      getMode: () => makeFakeMode(genAttempts),
      makeTarget: () => makeFakeTarget(),
      makeBrowser: () => browser,
    });

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: true },
      { onEvent: (e) => events.push(e) },
    );

    expect(summary.status).not.toBe('error');
    // Two generate() calls: the initial pass (escape-hatched) and directed re-exploration's own
    // regeneration of the same item after the targeted re-crawl found the real selector.
    expect(genAttempts.n).toBe(2);
    // The targeted re-crawl visited the specific resolved route.
    expect(gotoCalls).toContain(TARGET_URL);
    expect(events.some((e) => e.message.includes('Directed re-exploration'))).toBe(true);

    const report = JSON.parse(await readFile(summary.reportPath as string, 'utf8')) as RunReport;
    const testTitles = report.tests?.map((t) => t.title) ?? [];
    // The regenerated (non-fixme) spec's own execution result shipped — not the original guess.
    expect(testTitles).toContain('[REQ:REQ-1] positive: resets a forgotten password');

    // No duplicate row: exactly one test row for this run.
    const run = store.listRuns(project.id)[0]!;
    expect(store.listTests(run.id)).toHaveLength(1);
    expect(store.listTests(run.id)[0]?.status).toBe('passed');
  });

  it("suiteMode: 'reuse' never triggers directed re-exploration", async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({ name: 'Directed Reexplore Reuse Base', mode: 'playwright', baseUrl: BASE_URL });

    const genAttemptsBase = { n: 0 };
    const { browser: baseBrowser } = makeFakeBrowser();
    const baseOrchestrator = createOrchestrator({
      provider: makeFakeProvider(),
      getMode: () => makeFakeMode(genAttemptsBase, { alwaysEscapeHatch: true }),
      makeTarget: () => makeFakeTarget(),
      makeBrowser: () => baseBrowser,
    });
    const baseSummary = await baseOrchestrator.run(
      { projectId: project.id, autoApprove: true },
      { onEvent: () => {} },
    );
    expect(baseSummary.status).not.toBe('error');

    const genAttemptsReuse = { n: 0 };
    const events: OrchestratorEvent[] = [];
    const { browser: reuseBrowser, gotoCalls } = makeFakeBrowser();
    const reuseOrchestrator = createOrchestrator({
      provider: makeFakeProvider(),
      getMode: () => makeFakeMode(genAttemptsReuse, { alwaysEscapeHatch: true }),
      makeTarget: () => makeFakeTarget(),
      makeBrowser: () => reuseBrowser,
    });
    await reuseOrchestrator.run(
      { projectId: project.id, autoApprove: true, suiteMode: 'reuse', baseRunId: baseSummary.runId },
      { onEvent: (e) => events.push(e) },
    );

    // Reuse never calls generate() at all (carries the whole suite forward as-is), and never
    // visits the escape hatch's target route via a directed re-crawl.
    expect(genAttemptsReuse.n).toBe(0);
    expect(gotoCalls).not.toContain(TARGET_URL);
    expect(events.some((e) => e.message.includes('Directed re-exploration'))).toBe(false);
  });

  it('a crawl failure during directed re-exploration does not fail the run — ships the original fixme spec untouched', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({ name: 'Directed Reexplore Crawl Fails', mode: 'playwright', baseUrl: BASE_URL });

    const genAttempts = { n: 0 };
    const events: OrchestratorEvent[] = [];
    const { browser } = makeFakeBrowser();
    // crawl() swallows a plain goto() failure internally (dead-link handling) — to reach OUR OWN
    // try/catch around the crawl call, fail at drainNetworkEvents() instead, called right after
    // goto() but OUTSIDE crawl()'s own protected region. EXPLORE's initial crawl never visits
    // TARGET_URL at all (our fake's base-URL page has no links to discover it), so this only ever
    // fires during directed re-exploration's own targeted re-crawl.
    const originalDrain = browser.drainNetworkEvents.bind(browser);
    let visitedTarget = false;
    const originalGoto = browser.goto.bind(browser);
    browser.goto = async (url: string) => {
      await originalGoto(url);
      if (url === TARGET_URL) visitedTarget = true;
    };
    browser.drainNetworkEvents = () => {
      if (visitedTarget) throw new Error('browser session crashed');
      return originalDrain();
    };
    const orchestrator = createOrchestrator({
      provider: makeFakeProvider(),
      getMode: () => makeFakeMode(genAttempts, { alwaysEscapeHatch: true }),
      makeTarget: () => makeFakeTarget(),
      makeBrowser: () => browser,
    });

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: true },
      { onEvent: (e) => events.push(e) },
    );

    // The run still completes normally (fail-open) despite the crawl failure.
    expect(summary.status).not.toBe('error');
    expect(events.some((e) => e.level === 'warn' && e.message.toLowerCase().includes('directed re-exploration'))).toBe(
      true,
    );

    const report = JSON.parse(await readFile(summary.reportPath as string, 'utf8')) as RunReport;
    const testTitles = report.tests?.map((t) => t.title) ?? [];
    expect(testTitles).toContain('[REQ:REQ-1] positive: resets a forgotten password');
    // Only ever generated once — the crawl failure meant nothing was ever merged, so directed
    // re-exploration never called generate() a second time.
    expect(genAttempts.n).toBe(1);
  });
});
