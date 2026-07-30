import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOrchestrator } from './index.js';
import { diffAgainstBase } from './topup.js';
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
 * This file covers two DISTINCT mechanisms, per the KB-driven redesign
 * (docs/design/retry-pass-coverage-kb-redesign.md §3b):
 *
 * 1. Repair (RunOptions.retryItemIds): narrows planning to reuse ONLY the
 *    named ids from the base run's own plan.json, skipping AI planning
 *    entirely, via a NEW `suiteMode: 'topup'` run — generation's existing
 *    base-run diff then naturally regenerates just those items. This is the
 *    OLD Retry-pass mechanism, kept exactly as-is because Repair still
 *    depends on it (`topup.ts`'s `forceRegenerate` — "the escape hatch
 *    Repair (and, degenerately, Retry-pass) need") — zero code changes here,
 *    only test relabeling for the tests that used to describe this as
 *    "Retry-pass" before the redesign.
 * 2. Retry-pass (orchestrator.retryPass(runId)): the NEW same-run Knowledge
 *    Base mechanism — no new run row, no base_run_id. Its own describe block
 *    is further down this file.
 *
 * Offline DI seam throughout, same pattern as orchestrator.topup.test.ts.
 */

const SEED_ITEMS = [
  { title: 'Home loads', reqTag: 'REQ-A', tier: 'tierA-public', intent: 'Landing renders.' },
  { title: 'Checkout works', reqTag: 'REQ-B', tier: 'tierA-public', intent: 'Checkout flow.' },
  { title: 'Settings works', reqTag: 'REQ-C', tier: 'tierA-public', intent: 'Settings page.' },
];

function fakeProviderWithPlan(
  planCalls: CompleteOptions[],
  seedItems: readonly unknown[] = SEED_ITEMS,
): ProviderAdapter {
  const plan = { summary: 'canned plan', items: seedItems };
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
      if (opts?.mode === 'plan') {
        planCalls.push(opts);
        return { provider: 'claude', ok: true, text: fenced, raw: plan, detail: 'OK' };
      }
      return { provider: 'claude', ok: true, text: 'not used', raw: null, detail: 'OK' };
    },
  };
}

/**
 * generate() drops any item whose reqTag is in `dropReqTags` — simulating a
 * per-item generation failure that leaves no test row (a real "generation
 * gap"). Writes real spec files under ctx.projectDir (mirroring the real
 * Playwright mode) so top-up's hydrateCarriedSpecs can genuinely copy a
 * carried-forward test's file bytes forward, same as orchestrator.topup.test.ts's
 * makeRealisticFakeMode.
 */
function makeFakeMode(generateCalls: TestPlan[], dropReqTags: ReadonlySet<string> = new Set()): TestMode {
  return {
    id: 'playwright',
    async scaffold(_ctx: TestModeContext): Promise<void> {},
    async generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
      generateCalls.push(plan);
      const specs: GeneratedSpec[] = [];
      for (const item of plan.items) {
        if (item.reqTag && dropReqTags.has(item.reqTag)) {
          // Mirrors real generate.ts's recordGenOutcome: this fake bypasses
          // it entirely, so it has to fire the KB callback itself — the
          // Knowledge Base's dropped/generated tracking depends on it.
          ctx.onKbItemOutcome?.(item.id, 'dropped');
          continue;
        }
        // Mirrors generate.ts's real fallback (`item.reqTag ?? item.id`) — a
        // reqTag-less item still needs a stable, unique-per-item spec.reqTag
        // for this-run's own file naming/bookkeeping, even though it must
        // NOT be what gets persisted as the test row's actual reqTag (that's
        // exactly the bug this test file is guarding against).
        const specReqTag = item.reqTag ?? item.id;
        const relPath = join('tests', item.tier, `${specReqTag}.spec.ts`);
        const absPath = join(ctx.projectDir, relPath);
        await mkdir(dirname(absPath), { recursive: true });
        // One `test(...)` line per scenario, each literally carrying the
        // `[REQ:tag]` marker in its title text (mirrors real generate.ts's
        // per-test tagging requirement). Baking it into the actual file bytes,
        // not just this spec's in-memory title, matters once the spec is
        // carried forward: hydrateCarriedSpecs copies the file byte-for-byte,
        // and that's the only place left for a reqTag-less item's tag to
        // survive for registerSpecRows to recover.
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
          planItemId: item.id,
        });
        ctx.onKbItemOutcome?.(item.id, 'generated');
      }
      return specs;
    },
    async execute(_ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
      // Real Playwright discovers test files from disk and runs each physical
      // file exactly once, regardless of how many bookkeeping entries the JS
      // side has for it — hydrateCarriedSpecs deliberately pushes one
      // GeneratedSpec per carried TEST ROW, so a multi-scenario carried spec
      // can appear multiple times here for the same file. Dedupe by path
      // before counting scenarios (same pattern as orchestrator.topup.test.ts),
      // or a carried multi-scenario spec's results get multiplied.
      const uniqueSpecs = [...new Map(specs.map((s) => [s.path, s])).values()];
      const results = uniqueSpecs.flatMap((s) => {
        const scenarioCount = Math.max((s.contents.match(/^test\(/gm) ?? []).length, 1);
        return Array.from({ length: scenarioCount }, () => ({
          title: s.title,
          status: 'passed' as const,
          durationMs: 1,
        }));
      });
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

/**
 * Same as makeFakeMode, but execute() always throws — simulating a run that
 * errors out during the (now single, merged-invocation) EXECUTE step. Specs
 * already generated/registered before the crash stay at their initial
 * 'pending' status forever (index.ts's deleteUnexecutedTests cleanup never
 * runs for a run that errors out of EXECUTE) — the exact real-world case
 * Retry-pass must also catch, not just a missing test row.
 */
function makeCrashingFakeMode(generateCalls: TestPlan[]): TestMode {
  const base = makeFakeMode(generateCalls);
  return {
    ...base,
    async execute(_ctx: TestModeContext, _specs: GeneratedSpec[]) {
      throw new Error('simulated crash executing the suite');
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
  drainNetworkEvents() {
    return [];
  },
  async stop(): Promise<void> {},
};

let dataDir: string;
const prevDataDir = process.env.HEALIX_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-orch-retry-pass-'));
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

async function readPlan(projectId: string, runId: string): Promise<TestPlan> {
  const raw = await readFile(
    join(dataDir, 'projects', projectId, 'runs', runId, 'plan', 'plan.json'),
    'utf-8',
  );
  return JSON.parse(raw) as TestPlan;
}

describe('Repair (RunOptions.retryItemIds — the OLD mechanism, unchanged; retry-pass no longer uses it)', () => {
  it('regenerates exactly the requested gap item(s) via a new topup run, with full AI planning NOT invoked', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Retry Pass Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // ---- Run 1: fresh, 3-item plan; generation silently drops REQ-B (a real generation gap). ----
    const run1PlanCalls: CompleteOptions[] = [];
    const run1GenerateCalls: TestPlan[] = [];
    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan(run1PlanCalls),
      getMode: () => makeFakeMode(run1GenerateCalls, new Set(['REQ-B'])),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });

    expect(run1.status).toBe('passed');
    expect(run1PlanCalls).toHaveLength(1);
    expect(store.listTests(run1.runId)).toHaveLength(2);

    const plan1 = await readPlan(project.id, run1.runId);
    const gaps = diffAgainstBase(plan1.items, store.listTests(run1.runId)).toGenerate;
    expect(gaps.map((g) => g.reqTag)).toEqual(['REQ-B']);

    // ---- Run 2: retry-pass targeting only that gap's plan item id. ----
    const run2PlanCalls: CompleteOptions[] = [];
    const run2GenerateCalls: TestPlan[] = [];
    const run2 = await createOrchestrator({
      provider: fakeProviderWithPlan(run2PlanCalls),
      getMode: () => makeFakeMode(run2GenerateCalls), // no drops this time — REQ-B succeeds
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({
      projectId: project.id,
      suiteMode: 'topup',
      baseRunId: run1.runId,
      autoApprove: true,
      retryItemIds: gaps.map((g) => g.id),
    });

    expect(run2.status).toBe('passed');
    // No AI plan call at all — retry-pass reused the base plan's item directly.
    expect(run2PlanCalls).toHaveLength(0);
    // Generation was invoked with exactly the one targeted item.
    expect(run2GenerateCalls.flatMap((p) => p.items).map((i) => i.reqTag)).toEqual(['REQ-B']);

    const run2Tests = store.listTests(run2.runId);
    expect(new Set(run2Tests.map((t) => t.reqTag))).toEqual(new Set(['REQ-A', 'REQ-B', 'REQ-C']));
  });

  it("falls back to a full re-plan when the base run's plan.json is unreadable", async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Retry Pass Unreadable Base',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const run1PlanCalls: CompleteOptions[] = [];
    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan(run1PlanCalls),
      getMode: () => makeFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('passed');

    // Simulate an unreadable base plan (deleted/corrupted on disk).
    await rm(join(dataDir, 'projects', project.id, 'runs', run1.runId, 'plan', 'plan.json'), { force: true });

    const run2PlanCalls: CompleteOptions[] = [];
    const run2GenerateCalls: TestPlan[] = [];
    const events: string[] = [];
    const run2 = await createOrchestrator({
      provider: fakeProviderWithPlan(run2PlanCalls),
      getMode: () => makeFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run(
      {
        projectId: project.id,
        suiteMode: 'topup',
        baseRunId: run1.runId,
        autoApprove: true,
        retryItemIds: ['pli_doesnotexist'],
      },
      { onEvent: (e) => events.push(e.message) },
    );

    expect(run2.status).toBe('passed');
    // Fell all the way back to a real AI plan call, not a silent empty plan.
    expect(run2PlanCalls).toHaveLength(1);
    expect(events.some((m) => m.includes('Could not reload base plan'))).toBe(true);
  });

  it('falls back to a full re-plan when none of the requested ids match the base plan', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Retry Pass No Match',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('passed');

    const run2PlanCalls: CompleteOptions[] = [];
    const events: string[] = [];
    const run2 = await createOrchestrator({
      provider: fakeProviderWithPlan(run2PlanCalls),
      getMode: () => makeFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run(
      {
        projectId: project.id,
        suiteMode: 'topup',
        baseRunId: run1.runId,
        autoApprove: true,
        retryItemIds: ['pli_nonexistent'],
      },
      { onEvent: (e) => events.push(e.message) },
    );

    expect(run2.status).toBe('passed');
    expect(run2PlanCalls).toHaveLength(1);
    expect(events.some((m) => m.includes('none of the given item ids matched'))).toBe(true);
  });

  it('real cross-run Top-up: a reqTag-less item already covered by the base run is not regenerated (regression)', async () => {
    // Root-cause regression for a real bug found via manual testing: when a
    // plan item has no reqTag (common for simple frontend apps — the AI
    // never assigns one), the persisted test row's reqTag column is null
    // (registerSpecRows persists the item's TRUE reqTag, not generate.ts's
    // internal item.id fallback). topup.ts's computeIdentityKey strips the
    // deterministic `[REQ:...]`/scenario-suffix decoration off a stored
    // test's title before falling back to title-matching, so it correctly
    // recovers the plan item's raw title for comparison across two
    // INDEPENDENTLY-planned runs (unlike Retry-pass/Repair's same-run id
    // matching, real Top-up genuinely can't rely on plan-item ids — a fresh
    // plan mints brand new ones every time).
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Real Topup ReqTag-less Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const NO_REQTAG_ITEMS = [
      { title: 'Home loads', tier: 'tierA-public', intent: 'Landing renders.' },
      { title: 'Checkout works', tier: 'tierA-public', intent: 'Checkout flow.' },
    ];

    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([], NO_REQTAG_ITEMS),
      getMode: () => makeFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('passed');
    expect(store.listTests(run1.runId)).toHaveLength(2);
    // Persisted reqTag is null, not the ephemeral per-run item id.
    expect(store.listTests(run1.runId).every((t) => t.reqTag === null)).toBe(true);

    // A genuinely INDEPENDENT second plan call (new provider instance, new
    // plan-item ids minted fresh) proposing the SAME two features again —
    // this is what a real Top-up run does, unlike Retry-pass which reuses
    // the base run's own plan.json verbatim.
    const run2GenerateCalls: TestPlan[] = [];
    const run2 = await createOrchestrator({
      provider: fakeProviderWithPlan([], NO_REQTAG_ITEMS),
      getMode: () => makeFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({
      projectId: project.id,
      suiteMode: 'topup',
      baseRunId: run1.runId,
      autoApprove: true,
    });

    expect(run2.status).toBe('passed');
    // Both items recognized as already covered by title — zero regenerated.
    expect(run2GenerateCalls.flatMap((p) => p.items)).toHaveLength(0);
    expect(store.listTests(run2.runId)).toHaveLength(2);
  });

  it('a run that errors out mid-EXECUTE leaves already-generated rows genuinely "pending" (precondition the new retry-pass KB relies on)', async () => {
    // The KB must mirror not just plan items with NO test row at all, but
    // also ones that got a spec generated and registered, then never
    // actually executed because the run crashed during EXECUTE before
    // index.ts's deleteUnexecutedTests cleanup could run (that cleanup only
    // fires on EXECUTE's happy path). All in-scope tiers now run in a single
    // merged Playwright invocation (see orchestrator/index.ts's EXECUTE
    // section and modes/playwright/execute.ts) rather than one process per
    // tier, so a crash there means the WHOLE execute step never persisted
    // any result — this proves the DB-level precondition is real: every
    // already-registered row sits at 'pending' and the run still settles as
    // 'error', not silently dropping those rows.
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Crash Mid-Execute Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const CRASH_ITEMS = [
      { title: 'Home loads', reqTag: 'REQ-A', tier: 'tierA-public', intent: 'Landing renders.' },
    ];
    const run1GenerateCalls: TestPlan[] = [];
    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([], CRASH_ITEMS),
      getMode: () => makeCrashingFakeMode(run1GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });

    expect(run1.status).toBe('error');
    // Generation succeeded (the row exists) — only EXECUTE crashed, so the
    // row was never cleaned up by deleteUnexecutedTests and sits at 'pending'.
    const tests = store.listTests(run1.runId);
    expect(tests).toHaveLength(1);
    expect(tests[0].status).toBe('pending');
  });

  it('Repair case: an item that ALREADY has a covering test is still actually regenerated when targeted, not silently carried forward', async () => {
    // Regression for a real bug found via isolated real-app verification:
    // Repair's whole precondition is a `test_is_wrong` verdict, which can only
    // exist on an already-EXECUTED test — meaning diffAgainstBase's ordinary
    // "existing test = already covered, don't regenerate" rule would otherwise
    // always classify a Repair target as covered and carry the old (wrong)
    // spec forward unchanged, never calling generate() for it at all.
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Repair Targeted Regeneration Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // ---- Run 1: fresh, all 3 items succeed and get real covering tests. ----
    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });

    expect(run1.status).toBe('passed');
    const run1Tests = store.listTests(run1.runId);
    expect(run1Tests).toHaveLength(3);
    expect(run1Tests.every((t) => t.status === 'passed')).toBe(true);

    const plan1 = await readPlan(project.id, run1.runId);
    const repairTargetItem = plan1.items.find((it) => it.reqTag === 'REQ-B')!;
    const repairTargetTest = run1Tests.find((t) => t.reqTag === 'REQ-B')!;
    // Precondition: REQ-B already has a covering test — diffAgainstBase alone
    // would treat it as covered, exactly the trap Repair must avoid.
    expect(diffAgainstBase(plan1.items, run1Tests).toGenerate).toHaveLength(0);

    // Simulate a real repair-worthy verdict: REQ-B's test was triaged wrong.
    store.recordTriageResult({
      testId: repairTargetTest.id,
      verdict: 'test_is_wrong',
      confidence: 0.9,
      rationale: 'Stale selector.',
    });

    // ---- Run 2: repair, targeting REQ-B's plan item id via retryItemIds. ----
    const run2GenerateCalls: TestPlan[] = [];
    const run2 = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({
      projectId: project.id,
      suiteMode: 'topup',
      baseRunId: run1.runId,
      autoApprove: true,
      retryItemIds: [repairTargetItem.id],
    });

    expect(run2.status).toBe('passed');
    // The targeted item was ACTUALLY regenerated — generate() was invoked for it —
    // not silently skipped because a covering test already existed.
    expect(run2GenerateCalls.flatMap((p) => p.items).map((i) => i.reqTag)).toEqual(['REQ-B']);

    // The new run carries the other two items forward and has exactly one
    // fresh row for REQ-B — the stale original isn't duplicated alongside it.
    const run2Tests = store.listTests(run2.runId);
    expect(run2Tests.filter((t) => t.reqTag === 'REQ-B')).toHaveLength(1);
    expect(run2Tests.filter((t) => t.reqTag === 'REQ-B')[0].id).not.toBe(repairTargetTest.id);
    expect(new Set(run2Tests.map((t) => t.reqTag))).toEqual(new Set(['REQ-A', 'REQ-B', 'REQ-C']));
  });

  it('MULTI-SCENARIO CARRY-FORWARD, REQTAG-LESS: a reqTag-less item merely carried forward during Repair keeps all its scenario rows (regression)', async () => {
    // Repair carries every NON-targeted item forward through the exact
    // same hydrateCarriedSpecs/registerSpecRows path real Top-up uses (see
    // orchestrator.topup.test.ts's own REQTAG-LESS regression test for the
    // full mechanism). This locks down that a reqTag-less, multi-scenario item
    // NOT targeted by retryItemIds doesn't collapse to 1 row when a DIFFERENT
    // item is the one actually being repaired/regenerated — Repair is a
    // distinct caller of the same carry-forward code, worth covering on its own.
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Retry-pass Carry ReqTag-less Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const SEED_WITH_MULTI_SCENARIO_ITEM = [
      ...SEED_ITEMS,
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
    ];

    // ---- Run 1: fresh — 3 real-reqTag items + 1 reqTag-less, 3-scenario item. ----
    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([], SEED_WITH_MULTI_SCENARIO_ITEM),
      getMode: () => makeFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });

    expect(run1.status).toBe('passed');
    const run1Tests = store.listTests(run1.runId);
    // 3 single-scenario items + 1 three-scenario item = 6 rows.
    expect(run1Tests).toHaveLength(6);
    expect(run1Tests.filter((t) => t.reqTag === null)).toHaveLength(3);

    const plan1 = await readPlan(project.id, run1.runId);
    const repairTargetItem = plan1.items.find((it) => it.reqTag === 'REQ-B')!;

    // ---- Run 2: retry-pass targeting only REQ-B; the reqTag-less item is untouched, merely carried. ----
    const run2GenerateCalls: TestPlan[] = [];
    const run2 = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({
      projectId: project.id,
      suiteMode: 'topup',
      baseRunId: run1.runId,
      autoApprove: true,
      retryItemIds: [repairTargetItem.id],
    });

    expect(run2.status).toBe('passed');
    // Only REQ-B was actually regenerated — the reqTag-less item was carried, not regenerated.
    expect(run2GenerateCalls.flatMap((p) => p.items).map((i) => i.reqTag)).toEqual(['REQ-B']);

    const run2Tests = store.listTests(run2.runId);
    expect(run2Tests).toHaveLength(6);

    // The reqTag-less item's 3 scenario rows carried forward — not collapsed to 1.
    const run2LogoutTests = run2Tests.filter((t) => t.reqTag === null);
    expect(run2LogoutTests).toHaveLength(3);
    expect(run2LogoutTests.every((t) => t.status === 'passed')).toBe(true);
    const run2Results = store.listResults(run2.runId);
    for (const t of run2LogoutTests) {
      expect(run2Results.filter((r) => r.testId === t.id)).toHaveLength(1);
    }
  });

  it('retryItemIds survives a pause/resume round-trip via the checkpoint', async () => {
    // Direct plumbing check, same shape as orchestrator.coverage-loop.test.ts's
    // equivalent for coverageLoopEnabled/coverageTarget — proves this new
    // RunOptions field round-trips through ResumeCheckpoint.runOptions so a
    // paused retry-pass/repair run resumes with the same target ids instead of
    // silently degrading to an ordinary full top-up.
    const { writeCheckpoint, readCheckpoint } = await import('./checkpoint.js');
    const runDir = mkdtempSync(join(tmpdir(), 'healix-retry-pass-checkpoint-'));
    try {
      await writeCheckpoint(runDir, {
        runId: 'run_test',
        projectId: 'prj_test',
        phase: 'generate',
        runOptions: { retryItemIds: ['pli_a', 'pli_b'] },
        plan: { summary: 'x', items: [] },
        generatedItemIds: [],
        generatedSpecs: [],
        executeComplete: false,
        updatedAt: new Date().toISOString(),
      });
      const checkpoint = await readCheckpoint(runDir);
      expect(checkpoint?.runOptions.retryItemIds).toEqual(['pli_a', 'pli_b']);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe('Retry-pass (orchestrator.retryPass(runId) — the NEW same-run Knowledge Base mechanism)', () => {
  it('regenerates a dropped item on the SAME run — no new run row, KB flips dropped -> generated', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Retry-pass Same-run Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // ---- Initial run: generation silently drops REQ-B. ----
    const run1GenerateCalls: TestPlan[] = [];
    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode(run1GenerateCalls, new Set(['REQ-B'])),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });

    expect(run1.status).toBe('passed');
    expect(store.listTests(run1.runId)).toHaveLength(2);
    expect(store.listDroppedPlanKbItems(run1.runId)).toHaveLength(1);

    // ---- Retry-pass on the SAME runId: no drops this time, REQ-B succeeds. ----
    const run2GenerateCalls: TestPlan[] = [];
    const summary = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).retryPass(run1.runId);

    expect(summary.status).toBe('passed');
    // Same runId — no new run row was ever created.
    expect(summary.runId).toBe(run1.runId);
    expect(store.listRuns(project.id)).toHaveLength(1);

    // generate() was invoked with exactly the one previously-dropped item.
    expect(run2GenerateCalls.flatMap((p) => p.items).map((i) => i.reqTag)).toEqual(['REQ-B']);

    const tests = store.listTests(run1.runId);
    expect(new Set(tests.map((t) => t.reqTag))).toEqual(new Set(['REQ-A', 'REQ-B', 'REQ-C']));
    expect(store.listDroppedPlanKbItems(run1.runId)).toHaveLength(0);
  });

  it('executes a pending (generated-but-never-run) scenario WITHOUT regenerating it', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Retry-pass Pending Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const CRASH_ITEMS = [
      { title: 'Home loads', reqTag: 'REQ-A', tier: 'tierA-public', intent: 'Landing renders.' },
    ];
    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([], CRASH_ITEMS),
      getMode: () => makeCrashingFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });

    expect(run1.status).toBe('error');
    const beforeTests = store.listTests(run1.runId);
    expect(beforeTests).toHaveLength(1);
    expect(beforeTests[0].status).toBe('pending');
    expect(store.listPendingPlanKbScenarios(run1.runId)).toHaveLength(1);
    expect(store.listDroppedPlanKbItems(run1.runId)).toHaveLength(0);

    // ---- Retry-pass: the row is 'pending', not 'dropped' — generate() must NOT be called for it. ----
    const run2GenerateCalls: TestPlan[] = [];
    const summary = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).retryPass(run1.runId);

    expect(summary.status).toBe('passed');
    expect(run2GenerateCalls.flatMap((p) => p.items)).toHaveLength(0);

    const afterTests = store.listTests(run1.runId);
    expect(afterTests).toHaveLength(1);
    expect(afterTests[0].status).toBe('passed');
    expect(store.listPendingPlanKbScenarios(run1.runId)).toHaveLength(0);
  });

  it("returns retryPassResult: 'nothing-to-retry' and does no work when the KB has nothing outstanding", async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Retry-pass Nothing To Retry Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode([]), // no drops
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('passed');

    const run2GenerateCalls: TestPlan[] = [];
    const summary = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).retryPass(run1.runId);

    expect(summary.retryPassResult).toBe('nothing-to-retry');
    expect(run2GenerateCalls).toHaveLength(0);
    // Status is left exactly as it was — retryPass took no action at all.
    expect(summary.status).toBe(run1.status);
  });

  it("reuses the original run's testingScope from run-config.json instead of defaulting it", async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Retry-pass Config Reuse Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode([], new Set(['REQ-B'])), // drop REQ-B so there's something to retry
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true, testingScope: 'frontend' });
    expect(run1.status).toBe('passed');

    const seenScopes: Array<string | undefined> = [];
    const captureMode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
        seenScopes.push(ctx.testingScope);
        return makeFakeMode([]).generate(ctx, plan);
      },
      async execute(ctx, specs) {
        return makeFakeMode([]).execute(ctx, specs);
      },
      async collectArtifacts() {
        return { dir: 'artifacts', files: [] };
      },
      async export() {
        return { dir: 'export', files: [] };
      },
    };

    const summary = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => captureMode,
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).retryPass(run1.runId);

    expect(summary.status).toBe('passed');
    // Never defaulted to 'both' — the ORIGINAL run's 'frontend' scope survived.
    expect(seenScopes).toEqual(['frontend']);
  });

  it('triages a NEWLY-failing regenerated item and includes the verdict in the refreshed report (old verdicts untouched)', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Retry-pass Fresh Triage Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // ---- Initial run: REQ-B dropped, everything else passes. ----
    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode([], new Set(['REQ-B'])),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('passed');
    expect(store.listTriageResults(run1.runId)).toHaveLength(0);

    // ---- Retry-pass: REQ-B regenerates successfully but FAILS on execution — a genuinely new failure. ----
    const failingMode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
        return makeFakeMode([]).generate(ctx, plan);
      },
      async execute(_ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
        const results = specs.map((s) => ({
          title: s.title,
          status: (s.reqTag === 'REQ-B' ? 'failed' : 'passed') as 'failed' | 'passed',
          durationMs: 1,
          ...(s.reqTag === 'REQ-B' ? { error: 'expect(locator).toBeVisible() failed' } : {}),
        }));
        return {
          passed: results.filter((r) => r.status === 'passed').length,
          failed: results.filter((r) => r.status === 'failed').length,
          blocked: 0,
          flaky: 0,
          results,
        };
      },
      async collectArtifacts() {
        return { dir: 'artifacts', files: [] };
      },
      async export() {
        return { dir: 'export', files: [] };
      },
    };

    const summary = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => failingMode,
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).retryPass(run1.runId);

    expect(summary.status).toBe('failed');
    const triageRows = store.listTriageResults(run1.runId);
    expect(triageRows).toHaveLength(1);
    // No AI reply configured on this fake provider, so analyze() falls back
    // to the deterministic rule baseline — still a real, persisted verdict,
    // which is exactly what this test needs to prove the wiring works.
    expect(triageRows[0]!.verdict).toBeTruthy();

    const report = JSON.parse(
      await readFile(join(dataDir, 'projects', project.id, 'runs', run1.runId, 'reports', 'report.json'), 'utf-8'),
    ) as { triage: Array<{ title: string }> };
    expect(report.triage).toHaveLength(1);
  });

  it('two items sharing the same reqTag (e.g. a UI-tier item and its tierC-api contract counterpart) both get KB-linked correctly, not just whichever comes first (regression)', async () => {
    // Root-cause regression for a real bug found via manual testing: a real
    // plan legitimately pairs a UI-tier item and a tierC-api item under the
    // SAME functional reqTag. registerSpecRows used to resolve "which plan
    // item does this spec belong to" purely by reqTag string, which silently
    // picked whichever of the two items came first in the list — the other
    // item's scenarios never got linkPlanKbScenarioTest called on them at all,
    // leaving them stuck at KB status 'pending' with testId permanently null,
    // even though their real Playwright tests executed fine. The fix threads
    // GeneratedSpec.planItemId (set by generate.ts, which always knows exactly
    // which item it's processing) through to registerSpecRows so it resolves
    // the exact originating item instead of guessing.
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'ReqTag Collision Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const COLLIDING_ITEMS = [
      {
        title: 'User registration via UI',
        reqTag: 'REQ-001',
        tier: 'tierA-public',
        intent: 'UI registration flow.',
        scenarios: [{ kind: 'positive', description: 'succeeds with valid input' }],
      },
      {
        title: 'POST /api/auth/register API contract',
        reqTag: 'REQ-001',
        tier: 'tierC-api',
        intent: 'API contract for registration.',
        scenarios: [{ kind: 'positive', description: 'returns 200 with a token' }],
      },
    ];

    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([], COLLIDING_ITEMS),
      getMode: () => makeFakeMode([]),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });

    expect(run1.status).toBe('passed');

    const kbItems = store.listPlanKbItems(run1.runId);
    expect(kbItems).toHaveLength(2);
    expect(kbItems.every((it) => it.status === 'generated')).toBe(true);

    const kbScenarios = store.listPlanKbScenarios(run1.runId);
    expect(kbScenarios).toHaveLength(2);
    // BOTH items' scenarios got linked to a real test row and reflect their
    // actual execution outcome — neither is silently stuck at 'pending'.
    for (const kbItem of kbItems) {
      const scenario = kbScenarios.find((s) => s.kbItemId === kbItem.id);
      expect(scenario).toBeDefined();
      expect(scenario!.testId).not.toBeNull();
      expect(scenario!.status).toBe('passed');
    }
  });

  it('a spec quarantined by the LATER validate() step (not generate.ts\'s own checks) gets the KB corrected to dropped, so retry-pass can regenerate it (regression)', async () => {
    // Root-cause regression for a real bug found via manual testing on a real
    // app: generate.ts's own per-item checks can accept a spec — recording the
    // item 'generated' via ctx.onKbItemOutcome — that STILL fails the separate,
    // LATER mode.validate() parse-check (a genuine codegen defect the
    // regex/string gates can't catch; see index.ts's "Pre-execution validation
    // gate" comment). Before this fix, the KB never learned about that later
    // rejection: the item stayed stuck at 'generated'/'pending' forever, since
    // registerSpecRows (and therefore linkPlanKbScenarioTest) is never called
    // for a quarantined spec — retry-pass had no dropped item to regenerate,
    // and no linked test row to execute either. A permanent, silent dead end.
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Quarantine KB Correction Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    function quarantiningMode(generateCalls: TestPlan[]): TestMode {
      const base = makeFakeMode(generateCalls);
      return {
        ...base,
        async validate(_ctx, specs) {
          const quarantined = specs.filter((s) => s.reqTag === 'REQ-B');
          const ok = specs.filter((s) => s.reqTag !== 'REQ-B');
          return {
            ok,
            repaired: [],
            quarantined: quarantined.map((spec) => ({
              spec,
              reason: 'simulated codegen defect',
              category: 'codegen-defect' as const,
            })),
            warnings: [],
          };
        },
      };
    }

    // ---- Initial run: REQ-B's spec is "accepted" by generate() but quarantined by validate(). ----
    const run1GenerateCalls: TestPlan[] = [];
    const run1 = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => quarantiningMode(run1GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });

    expect(run1.status).toBe('passed');
    // REQ-B never got a test row at all — registerSpecRows never ran for it.
    const run1Tests = store.listTests(run1.runId);
    expect(run1Tests.some((t) => t.reqTag === 'REQ-A')).toBe(true);
    expect(run1Tests.some((t) => t.reqTag === 'REQ-B')).toBe(false);
    // The KB correctly reflects the quarantine as a drop, not stuck at 'generated'/'pending'.
    expect(store.listDroppedPlanKbItems(run1.runId)).toHaveLength(1);
    expect(store.listPendingPlanKbScenarios(run1.runId)).toHaveLength(0);

    // ---- Retry-pass: REQ-B is now a real dropped item, so it actually gets regenerated. ----
    const run2GenerateCalls: TestPlan[] = [];
    const summary = await createOrchestrator({
      provider: fakeProviderWithPlan([]),
      getMode: () => makeFakeMode(run2GenerateCalls),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).retryPass(run1.runId);

    expect(summary.status).toBe('passed');
    expect(run2GenerateCalls.flatMap((p) => p.items).map((i) => i.reqTag)).toEqual(['REQ-B']);
    expect(store.listTests(run1.runId).some((t) => t.reqTag === 'REQ-B')).toBe(true);
    expect(store.listDroppedPlanKbItems(run1.runId)).toHaveLength(0);
  });
});
