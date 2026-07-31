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
  reqTag?: string;
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
        // Mirrors generate.ts's real fallback (`item.reqTag ?? item.id`) — a
        // reqTag-less item still needs a stable, unique-per-item spec.reqTag for
        // THIS run's own file naming/bookkeeping, even though registerSpecRows
        // must NOT persist it as the test row's actual reqTag (see its own
        // comments) — same pattern as orchestrator.retry-pass.test.ts's makeFakeMode.
        const specReqTag = item.reqTag ?? item.id;
        const relPath = join('tests', item.tier, `${specReqTag}.spec.ts`);
        const absPath = join(ctx.projectDir, relPath);
        await mkdir(dirname(absPath), { recursive: true });
        // One `test(...)` marker line per scenario, each literally carrying the
        // `[REQ:tag]` marker in its title string — real generate.ts emits one
        // test() per planned scenario, tagged the same way, and execute() below
        // counts these markers to decide how many results to return. Writing
        // them into the actual file (rather than tracking scenario counts in a
        // JS-side map) means a carried-forward spec (copied byte-for-byte by
        // hydrateCarriedSpecs, read back from disk) still reports its true
        // scenario count, and still carries the tag in its own file bytes, even
        // though this mode's own generate() never ran for it.
        const scenarios = item.scenarios?.length
          ? item.scenarios
          : [{ kind: 'positive', description: 'default' }];
        const contents =
          `// spec for ${item.title} (${specReqTag})\n` +
          scenarios.map((s) => `test('[REQ:${specReqTag}] ${s.kind}: ${s.description}');\n`).join('');
        await writeFile(absPath, contents, 'utf-8');
        specs.push({
          path: absPath,
          title: `[REQ:${specReqTag}] ${item.title}`,
          reqTag: specReqTag,
          tier: item.tier,
          contents,
        });
      }
      return specs;
    },
    async execute(_ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
      // Real Playwright discovers test files from disk and runs each physical
      // file exactly once, regardless of how many bookkeeping entries the JS
      // side has for it — hydrateCarriedSpecs deliberately pushes one
      // GeneratedSpec per carried TEST ROW, so a 3-scenario carried spec can
      // appear 3x here for the same file. Dedupe by path before counting
      // scenarios, or a carried multi-scenario spec's results get multiplied.
      const uniqueSpecs = [...new Map(specs.map((s) => [s.path, s])).values()];
      const results = uniqueSpecs.flatMap((s) => {
        const scenarioCount = Math.max((s.contents.match(/^test\(/gm) ?? []).length, 1);
        const status = (s.reqTag && failReqTags.has(s.reqTag) ? 'failed' : 'passed') as 'failed' | 'passed';
        return Array.from({ length: scenarioCount }, () => ({ title: s.title, status, durationMs: 10 }));
      });
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
  async reload(): Promise<void> {},
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
  drainNetworkEvents() {
    return [];
  },
  async exportStorageState() {
    return {};
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

  it("REUSE COUNT MATCHES BASE: a base-run test row missing its own specPath (e.g. persistResults' fallback-insert path) still carries forward via a sibling row sharing the same reqTag", async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Fallback Row Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // Two scenarios so the generated file genuinely has two `test(...)` blocks
    // (see makeRealisticFakeMode.generate) — realistically matching the
    // production shape where a spec file has more real test() blocks than the
    // DB ends up cleanly tracking one-for-one.
    const run1Provider = fakeProviderWithPlan(
      [
        {
          title: 'Home loads',
          reqTag: 'REQ-001',
          tier: 'tierA-public',
          intent: 'Landing renders.',
          scenarios: [
            { kind: 'positive', description: 'loads' },
            { kind: 'edge', description: 'reloads' },
          ],
        },
      ],
      [],
    );
    const run1Orchestrator = createOrchestrator({
      provider: run1Provider,
      getMode: () => makeRealisticFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run1 = await run1Orchestrator.run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('passed');
    expect(store.listTests(run1.runId)).toHaveLength(2);

    // Simulate the historical bug directly: a third scenario for REQ-001 whose
    // row never got a specPath (persistResults' fallback-insert path hits this
    // when a result can't be positionally matched back to its pre-registered
    // row — see insertResult's and mergeExecOutcomes' doc comments for the
    // duplicate-execution scenario that triggers it). Its sibling rows for the
    // same reqTag DO have a specPath. A matching third `test(...)` line is
    // appended to the real file so the fake executor's result count for this
    // reqTag is 3, not 2 — mirroring how the file genuinely has one more
    // scenario than the DB tracked cleanly.
    const siblings = store.listTests(run1.runId).filter((t) => t.reqTag === 'REQ-001');
    expect(siblings.every((t) => t.specPath)).toBe(true);
    const specAbsPath = join(
      dataDir,
      'projects',
      project.id,
      'runs',
      run1.runId,
      'suite',
      siblings[0].specPath!,
    );
    await writeFile(specAbsPath, (await readFile(specAbsPath, 'utf-8')) + "test('scenario 3');\n", 'utf-8');
    store.insertTest({
      runId: run1.runId,
      title: '[REQ:REQ-001] negative: retried scenario with no tracked spec file',
      reqTag: 'REQ-001',
      tier: null,
      status: 'passed',
    });
    expect(store.listTests(run1.runId)).toHaveLength(3);

    // ---- Run 2: reuse. All three REQ-001 rows must carry forward — the count
    // must exactly match the base run's total, not silently drop the specPath-less one.
    const run2Orchestrator = createOrchestrator({
      provider: fakeProviderWithPlan([], []),
      getMode: () => makeRealisticFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run2 = await run2Orchestrator.run({
      projectId: project.id,
      suiteMode: 'reuse',
      autoApprove: true,
    });

    expect(run2.status).toBe('passed');
    expect(store.listTests(run2.runId)).toHaveLength(3);
  });

  it('REUSE WITH APPROVAL GATE: an empty (by design) reuse plan is not mistaken for "all items rejected"', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Reuse Approval Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const run1Provider = fakeProviderWithPlan(
      [{ title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', intent: 'Landing renders.' }],
      [],
    );
    const run1Orchestrator = createOrchestrator({
      provider: run1Provider,
      getMode: () => makeRealisticFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run1 = await run1Orchestrator.run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('passed');

    // ---- Run 2: reuse, WITH a real approval gate (autoApprove: false) — this is
    // the desktop app's actual shape ("Approve & Continue" on the Plan Review
    // panel). The gate approves whatever plan it's handed; reuse mode hands it
    // an intentionally empty items array (see suiteMode === 'reuse' above), and
    // that must not be read as "the user rejected everything."
    let gateReceivedPlan: TestPlan | undefined;
    const run2Orchestrator = createOrchestrator({
      provider: fakeProviderWithPlan([], []),
      getMode: () => makeRealisticFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const run2 = await run2Orchestrator.run(
      { projectId: project.id, suiteMode: 'reuse', autoApprove: false },
      {
        onPlan: async (plan) => {
          gateReceivedPlan = plan;
          return { decision: 'proceed', plan };
        },
      },
    );

    expect(gateReceivedPlan?.planSource).toBe('reuse');
    expect(gateReceivedPlan?.items).toHaveLength(0);
    expect(run2.status).toBe('passed');
    expect(store.listTests(run2.runId)).toHaveLength(1);
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

    // ---- Run 2: top-up against that failed run. Top-up carries EVERY base
    // test forward regardless of status — REQ-002 (failed last time) is
    // carried and re-executed, not regenerated, since re-proposing it in the
    // plan must find it already covered. ----
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
    // Zero items sent for (re)generation: REQ-002 is already covered by the
    // carried-forward test, despite having failed in the base run. (Top-up
    // still invokes generate() once with an empty item list — a pre-existing,
    // harmless no-op call — so this asserts on the items, not the call count.)
    expect(run2GenerateCalls.flatMap((p) => p.items)).toHaveLength(0);

    const run2Tests = store.listTests(run2.runId);
    expect(new Set(run2Tests.map((t) => t.reqTag))).toEqual(new Set(['REQ-001', 'REQ-002']));
    // REQ-002's spec file is the carried-forward one, not a freshly generated one.
    const run1Tests = store.listTests(run1.runId);
    const carriedReq002 = run2Tests.find((t) => t.reqTag === 'REQ-002')!;
    const baseReq002 = run1Tests.find((t) => t.reqTag === 'REQ-002')!;
    expect(carriedReq002.specPath).toBe(baseReq002.specPath);
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

  it('MULTI-SCENARIO CARRY-FORWARD, REQTAG-LESS: a reqTag-less item carried forward keeps all its scenario rows, not just 1 (regression)', async () => {
    // Same shape as the REQ-100 test above, but the plan item has NO reqTag —
    // the AI never assigned one, which is common for simple frontend apps. In
    // that case registerSpecRows deliberately persists reqTag: null (so
    // cross-run Top-up identity matching still works by title — see that
    // function's own comments), so on carry-forward the DB gives back no tag
    // at all, while the copied spec file's own text still carries the ORIGINAL
    // run's synthetic per-run tag (`item.reqTag ?? item.id`) baked into every
    // one of its `test()` titles. Before the fix, registerSpecRows had no way
    // to recover that tag for a carried spec, so it keyed carried rows by
    // title while persistResults (which recovers the tag straight from the
    // executed test's title) keyed by tag — two different keyspaces that never
    // matched, collapsing all 3 scenario results onto 1 row via the fallback
    // path's insert-then-delete-by-testId semantics.
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Multi Scenario Carry Demo (reqTag-less)',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // ---- Run 1: fresh, one reqTag-less item with 3 scenarios. ----
    const run1GenerateCalls: TestPlan[] = [];
    const run1Provider = fakeProviderWithPlan(
      [
        {
          title: 'Logout',
          tier: 'tierA-public',
          intent: 'Logout flow works.',
          scenarios: [
            { kind: 'positive', description: 'logs out from the account menu' },
            { kind: 'negative', description: 'blocks protected pages after logout' },
            { kind: 'edge', description: 'logs out cleanly from multiple open tabs' },
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

    const run1Tests = store.listTests(run1.runId);
    expect(run1Tests).toHaveLength(3);
    // Persisted reqTag is null, not the ephemeral per-run item id.
    expect(run1Tests.every((t) => t.reqTag === null)).toBe(true);

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

    // All 3 scenario rows carry forward — not collapsed to 1.
    const run2Tests = store.listTests(run2.runId);
    expect(run2Tests).toHaveLength(3);
    expect(run2Tests.every((t) => t.reqTag === null)).toBe(true);

    // Every carried row must actually receive its own real result.
    expect(run2Tests.every((t) => t.status === 'passed')).toBe(true);

    // Each row has exactly one result attached to it.
    const run2Results = store.listResults(run2.runId);
    for (const t of run2Tests) {
      expect(run2Results.filter((r) => r.testId === t.id)).toHaveLength(1);
    }
  });
});
