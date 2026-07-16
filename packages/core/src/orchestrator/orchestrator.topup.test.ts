import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOrchestrator } from './index.js';
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
 * A ProviderAdapter whose plan completion returns exactly the given items, and
 * whose codegen/triage completions are counted so tests can assert on how many
 * AI calls actually happened (the whole point of top-up/reuse is to avoid them).
 */
interface PlanItemSeed {
  title: string;
  reqTag: string;
  tier: string;
  intent: string;
  scenarios?: Array<{ kind: string; description: string }>;
}

function fakeProviderWithPlan(items: PlanItemSeed[], completeCalls: CompleteOptions[]): ProviderAdapter {
  const plan = { summary: 'canned plan', items };
  const fenced = ['```json', JSON.stringify(plan), '```'].join('\n');
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
      return { provider: 'claude', ok: true, plan: fenced, raw: plan, detail: 'OK' };
    },
    async complete(_prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
      if (opts) completeCalls.push(opts);
      if (opts?.mode === 'plan') {
        return { provider: 'claude', ok: true, text: fenced, raw: plan, detail: 'OK' };
      }
      return {
        provider: 'claude',
        ok: true,
        text: 'canned text (no actionable json)',
        raw: null,
        detail: 'OK',
      };
    },
  };
}

/**
 * A TestMode whose generate() actually WRITES real spec files under
 * ctx.projectDir (mirroring the real Playwright mode closely enough to
 * exercise real copy-forward file I/O), and records every call's item list so
 * tests can assert exactly which items were sent to AI generation.
 */
function makeRealisticFakeMode(
  generateCalls: TestPlan[],
  failReqTags: ReadonlySet<string> = new Set(),
): TestMode {
  return {
    id: 'playwright',
    async scaffold(_ctx: TestModeContext): Promise<void> {
      /* noop */
    },
    async generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
      generateCalls.push(plan);
      const specs: GeneratedSpec[] = [];
      for (const item of plan.items) {
        const relPath = join('tests', item.tier, `${item.reqTag}.spec.ts`);
        const absPath = join(ctx.projectDir, relPath);
        await mkdir(dirname(absPath), { recursive: true });
        const contents = `// spec for ${item.title} (${item.reqTag})\n`;
        await writeFile(absPath, contents, 'utf-8');
        specs.push({
          path: absPath,
          title: `[REQ:${item.reqTag}] ${item.title}`,
          reqTag: item.reqTag,
          tier: item.tier,
          contents,
        });
      }
      return specs;
    },
    async execute(_ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
      const results = specs.map((s) => ({
        title: s.title,
        status: (s.reqTag && failReqTags.has(s.reqTag) ? 'failed' : 'passed') as 'failed' | 'passed',
        durationMs: 10,
      }));
      return {
        passed: results.filter((r) => r.status === 'passed').length,
        failed: results.filter((r) => r.status === 'failed').length,
        blocked: 0,
        flaky: 0,
        results,
      };
    },
    async collectArtifacts(_ctx: TestModeContext): Promise<{ dir: string; files: string[] }> {
      return { dir: 'artifacts', files: [] };
    },
    async export(_ctx: TestModeContext): Promise<SuiteBundle> {
      return { dir: 'export', files: [] };
    },
  };
}

const fakeTarget: TargetAdapter = {
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
    return { baseUrl: 'http://127.0.0.1:0', pid: null, async stop(): Promise<void> {} };
  },
  async probeUrl(_url: string): Promise<UrlProbe> {
    return { reachable: true, status: 200 };
  },
};

const fakeBrowser: BrowserSurface = {
  async start(_opts?: BrowserSurfaceOptions): Promise<void> {},
  async goto(_url: string): Promise<void> {},
  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0);
  },
  async snapshot(): Promise<DomSnapshot> {
    return { url: 'about:blank', title: 'blank', interactiveElements: [] };
  },
  async click(_selector: string): Promise<void> {},
  async clickAt(_point: Point): Promise<void> {},
  async type(_selector: string, _text: string): Promise<void> {},
  async pressKey(_key: string): Promise<void> {},
  onFrame(_cb: (png: Buffer) => void): () => void {
    return () => {};
  },
  async stop(): Promise<void> {},
};

let dataDir: string;
const prevDataDir = process.env.HEALIX_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-orch-topup-'));
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

describe('orchestrator top-up / reuse suite modes', () => {
  it('TOP-UP: carries every base-run passing test forward unconditionally, generates only genuinely new items', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Top-up Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // ---- Run 1: fresh, two items, both pass ----
    const run1Calls: CompleteOptions[] = [];
    const run1GenerateCalls: TestPlan[] = [];
    const run1Provider = fakeProviderWithPlan(
      [
        { title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', intent: 'Landing renders.' },
        { title: 'Login works', reqTag: 'REQ-002', tier: 'tierB-auth', intent: 'User can sign in.' },
      ],
      run1Calls,
    );
    const run1Orchestrator = createOrchestrator({
      provider: run1Provider,
      getMode: () => makeRealisticFakeMode(run1GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run1 = await run1Orchestrator.run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('passed');
    expect(store.getRun(run1.runId)).toMatchObject({ suiteMode: 'fresh', baseRunId: null });
    expect(store.listTests(run1.runId)).toHaveLength(2);

    // ---- Run 2: top-up. Plan repeats REQ-001 (already covered) and adds a genuinely new REQ-003. ----
    const run2Calls: CompleteOptions[] = [];
    const run2GenerateCalls: TestPlan[] = [];
    const run2Provider = fakeProviderWithPlan(
      [
        { title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', intent: 'Landing renders.' },
        { title: 'Settings works', reqTag: 'REQ-003', tier: 'tierA-public', intent: 'New settings page.' },
      ],
      run2Calls,
    );
    const run2Orchestrator = createOrchestrator({
      provider: run2Provider,
      getMode: () => makeRealisticFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run2 = await run2Orchestrator.run({
      projectId: project.id,
      suiteMode: 'topup',
      autoApprove: true,
    });

    expect(run2.status).toBe('passed');
    expect(store.getRun(run2.runId)).toMatchObject({ suiteMode: 'topup', baseRunId: run1.runId });

    // Only the genuinely new item (REQ-003) was ever sent to AI generation —
    // REQ-001 is already covered by a carried-forward passing test.
    expect(run2GenerateCalls).toHaveLength(1);
    expect(run2GenerateCalls[0].items.map((i) => i.reqTag)).toEqual(['REQ-003']);

    // Final suite = 2 carried (REQ-001, REQ-002) + 1 newly generated (REQ-003) = 3.
    const run2Tests = store.listTests(run2.runId);
    expect(run2Tests).toHaveLength(3);
    const byTag = new Map(run2Tests.map((t) => [t.reqTag, t]));
    expect(new Set(byTag.keys())).toEqual(new Set(['REQ-001', 'REQ-002', 'REQ-003']));

    // Carried tests' spec files are real, physically copied, byte-identical to run 1's.
    const run1Tests = store.listTests(run1.runId);
    for (const tag of ['REQ-001', 'REQ-002']) {
      const t1 = run1Tests.find((t) => t.reqTag === tag)!;
      const t2 = byTag.get(tag)!;
      expect(t2.specPath).toBe(t1.specPath);
      const suiteDir1 = join(dataDir, 'projects', project.id, 'runs', run1.runId, 'suite');
      const suiteDir2 = join(dataDir, 'projects', project.id, 'runs', run2.runId, 'suite');
      const content1 = await readFile(join(suiteDir1, t1.specPath!), 'utf-8');
      const content2 = await readFile(join(suiteDir2, t2.specPath!), 'utf-8');
      expect(content2).toBe(content1);
    }
  });

  it("REUSE: zero AI calls at all, exact re-execution of the base run's passing tests", async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Reuse Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const run1Calls: CompleteOptions[] = [];
    const run1GenerateCalls: TestPlan[] = [];
    const run1Provider = fakeProviderWithPlan(
      [
        { title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', intent: 'Landing renders.' },
        { title: 'Login works', reqTag: 'REQ-002', tier: 'tierB-auth', intent: 'User can sign in.' },
      ],
      run1Calls,
    );
    const run1Orchestrator = createOrchestrator({
      provider: run1Provider,
      getMode: () => makeRealisticFakeMode(run1GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run1 = await run1Orchestrator.run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('passed');

    // ---- Run 2: reuse. Provider must NEVER be called (no plan, no codegen, no triage — all pass). ----
    const run2Calls: CompleteOptions[] = [];
    const run2GenerateCalls: TestPlan[] = [];
    const run2Provider = fakeProviderWithPlan([], run2Calls); // empty plan seed — reuse must never even read it
    const run2Orchestrator = createOrchestrator({
      provider: run2Provider,
      getMode: () => makeRealisticFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run2 = await run2Orchestrator.run({
      projectId: project.id,
      suiteMode: 'reuse',
      autoApprove: true,
    });

    expect(run2.status).toBe('passed');
    expect(store.getRun(run2.runId)).toMatchObject({ suiteMode: 'reuse', baseRunId: run1.runId });

    // Zero AI calls of any kind, and mode.generate() was never invoked.
    expect(run2Calls).toHaveLength(0);
    expect(run2GenerateCalls).toHaveLength(0);

    // Both of run 1's passing tests were carried forward, nothing more, nothing less.
    const run2Tests = store.listTests(run2.runId);
    expect(run2Tests).toHaveLength(2);
    expect(new Set(run2Tests.map((t) => t.reqTag))).toEqual(new Set(['REQ-001', 'REQ-002']));
  });

  it('REUSE CARRIES THE ENTIRE SUITE: a failing test from the base run is re-run too, not silently dropped', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Reuse Mixed Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // ---- Run 1: fresh, one passes, one fails. ----
    const run1GenerateCalls: TestPlan[] = [];
    const run1Provider = fakeProviderWithPlan(
      [
        { title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', intent: 'Landing renders.' },
        { title: 'Checkout works', reqTag: 'REQ-002', tier: 'tierA-public', intent: 'Checkout flow.' },
      ],
      [],
    );
    const run1Orchestrator = createOrchestrator({
      provider: run1Provider,
      getMode: () => makeRealisticFakeMode(run1GenerateCalls, new Set(['REQ-002'])),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run1 = await run1Orchestrator.run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('failed');

    // ---- Run 2: reuse. Both tests carry forward — including the one that failed last time. ----
    const run2Calls: CompleteOptions[] = [];
    const run2GenerateCalls: TestPlan[] = [];
    const run2Provider = fakeProviderWithPlan([], run2Calls);
    const run2Orchestrator = createOrchestrator({
      provider: run2Provider,
      // This time both pass — proves the previously-failing test was actually re-executed,
      // not skipped (its result would be absent entirely if it had never carried forward).
      getMode: () => makeRealisticFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run2 = await run2Orchestrator.run({
      projectId: project.id,
      suiteMode: 'reuse',
      autoApprove: true,
    });

    expect(run2Calls).toHaveLength(0);
    expect(run2GenerateCalls).toHaveLength(0);
    expect(run2.status).toBe('passed');

    const run2Tests = store.listTests(run2.runId);
    expect(new Set(run2Tests.map((t) => t.reqTag))).toEqual(new Set(['REQ-001', 'REQ-002']));
    // The previously-failing test now shows as passed — it was genuinely re-run.
    const reExecuted = run2Tests.find((t) => t.reqTag === 'REQ-002');
    expect(reExecuted?.status).toBe('passed');
  });

  it('BROADENED ELIGIBILITY: a base run with some failures (overall status "failed") is still a valid top-up base', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Partial Failure Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // ---- Run 1: fresh, one passes, one fails — overall run status settles 'failed'. ----
    const run1GenerateCalls: TestPlan[] = [];
    const run1Provider = fakeProviderWithPlan(
      [
        { title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', intent: 'Landing renders.' },
        { title: 'Checkout works', reqTag: 'REQ-002', tier: 'tierA-public', intent: 'Checkout flow.' },
      ],
      [],
    );
    const run1Orchestrator = createOrchestrator({
      provider: run1Provider,
      getMode: () => makeRealisticFakeMode(run1GenerateCalls, new Set(['REQ-002'])),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run1 = await run1Orchestrator.run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('failed');
    expect(store.getLastSuccessfulRun(project.id)?.id).toBe(run1.runId);

    // ---- Run 2: top-up against that failed run. Only REQ-001 (the passing one) carries forward;
    // REQ-002 (failed) is not carried, so re-proposing it must go through AI generation again. ----
    const run2GenerateCalls: TestPlan[] = [];
    const run2Provider = fakeProviderWithPlan(
      [{ title: 'Checkout works', reqTag: 'REQ-002', tier: 'tierA-public', intent: 'Checkout flow.' }],
      [],
    );
    const run2Orchestrator = createOrchestrator({
      provider: run2Provider,
      getMode: () => makeRealisticFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run2 = await run2Orchestrator.run({
      projectId: project.id,
      suiteMode: 'topup',
      autoApprove: true,
    });

    expect(run2.status).toBe('passed');
    expect(store.getRun(run2.runId)).toMatchObject({ suiteMode: 'topup', baseRunId: run1.runId });
    expect(run2GenerateCalls).toHaveLength(1);
    expect(run2GenerateCalls[0].items.map((i) => i.reqTag)).toEqual(['REQ-002']);

    const run2Tests = store.listTests(run2.runId);
    expect(new Set(run2Tests.map((t) => t.reqTag))).toEqual(new Set(['REQ-001', 'REQ-002']));
  });

  it('NO BASE RUN: top-up/reuse with no prior successful run errors up front, no run row, no provider calls', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'No History Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    for (const suiteMode of ['topup', 'reuse'] as const) {
      const calls: CompleteOptions[] = [];
      const generateCalls: TestPlan[] = [];
      const provider = fakeProviderWithPlan(
        [{ title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', intent: 'x' }],
        calls,
      );
      const orchestrator = createOrchestrator({
        provider,
        getMode: () => makeRealisticFakeMode(generateCalls),
        makeTarget: () => fakeTarget,
        makeBrowser: () => fakeBrowser,
      });

      const summary = await orchestrator.run({ projectId: project.id, suiteMode, autoApprove: true });

      expect(summary.status).toBe('error');
      expect(summary.runId).toBe('');
      expect(calls).toHaveLength(0);
      expect(generateCalls).toHaveLength(0);
    }

    // No run row was ever created for this project.
    expect(store.listRuns(project.id)).toHaveLength(0);
  });

  it('PINNED BASE REJECTED: an explicit baseRunId pointing at an error/cancelled run is rejected, not silently used', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Bad Pin Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });
    const erroredRun = store.createRun(project.id, { suiteMode: 'fresh' });
    store.updateRunStatus(erroredRun.id, 'error', { finishedAt: new Date().toISOString() });
    const cancelledRun = store.createRun(project.id, { suiteMode: 'fresh' });
    store.updateRunStatus(cancelledRun.id, 'cancelled', { finishedAt: new Date().toISOString() });

    for (const baseRunId of [erroredRun.id, cancelledRun.id]) {
      const calls: CompleteOptions[] = [];
      const generateCalls: TestPlan[] = [];
      const provider = fakeProviderWithPlan(
        [{ title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', intent: 'x' }],
        calls,
      );
      const orchestrator = createOrchestrator({
        provider,
        getMode: () => makeRealisticFakeMode(generateCalls),
        makeTarget: () => fakeTarget,
        makeBrowser: () => fakeBrowser,
      });

      const summary = await orchestrator.run({
        projectId: project.id,
        suiteMode: 'topup',
        baseRunId,
        autoApprove: true,
      });

      expect(summary.status).toBe('error');
      expect(summary.runId).toBe('');
      expect(calls).toHaveLength(0);
    }
  });

  it('MULTI-SCENARIO CARRY-FORWARD: carrying a multi-scenario spec forward preserves one row per scenario, not one orphaned/duplicated per collision', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Multi Scenario Carry Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // ---- Run 1: fresh, one item with 3 scenarios → one spec file, 3 test rows. ----
    const run1GenerateCalls: TestPlan[] = [];
    const run1Provider = fakeProviderWithPlan(
      [
        {
          title: 'Checkout',
          reqTag: 'REQ-100',
          tier: 'tierA-public',
          intent: 'Checkout flow works.',
          scenarios: [
            { kind: 'positive', description: 'completes with a valid card' },
            { kind: 'negative', description: 'rejects an expired card' },
            { kind: 'edge', description: 'handles a zero-total cart' },
          ],
        },
      ],
      [],
    );
    const run1Orchestrator = createOrchestrator({
      provider: run1Provider,
      getMode: () => makeRealisticFakeMode(run1GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run1 = await run1Orchestrator.run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('passed');

    const run1Tests = store.listTests(run1.runId).filter((t) => t.reqTag === 'REQ-100');
    expect(run1Tests).toHaveLength(3);

    // ---- Run 2: reuse. The whole 3-scenario spec carries forward. ----
    const run2Calls: CompleteOptions[] = [];
    const run2GenerateCalls: TestPlan[] = [];
    const run2Provider = fakeProviderWithPlan([], run2Calls);
    const run2Orchestrator = createOrchestrator({
      provider: run2Provider,
      getMode: () => makeRealisticFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run2 = await run2Orchestrator.run({
      projectId: project.id,
      suiteMode: 'reuse',
      autoApprove: true,
    });

    expect(run2.status).toBe('passed');

    // All 3 scenario rows carry forward — not collapsed to 1 (silent collision) nor
    // inflated to more than 3 (orphaned-plus-fallback duplication).
    const run2Tests = store.listTests(run2.runId).filter((t) => t.reqTag === 'REQ-100');
    expect(run2Tests).toHaveLength(3);

    // Every carried row must actually receive its own real result — the collision
    // bug left 2 of 3 rows permanently 'pending' (never matched to a result) while
    // a 3rd absorbed every real result in turn, each overwriting the last.
    expect(run2Tests.every((t) => t.status === 'passed')).toBe(true);

    // Each row has exactly one result attached to it — not zero (orphaned) and not
    // several (repeated overwrites landing on the same colliding row).
    const run2Results = store.listResults(run2.runId);
    for (const t of run2Tests) {
      expect(run2Results.filter((r) => r.testId === t.id)).toHaveLength(1);
    }
  });
});
