import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOrchestrator } from './index.js';
import type { OrchestratorEvent } from './types.js';
import type { RunReport } from './report.js';
import { getStore, resetStoreForTests, type HealixStore } from '../storage/store.js';
import { projectsDir } from '../env/app-data.js';
import { ProviderRouter } from '../providers/router.js';
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

// ---------------------------------------------------------------------------
// Shared fakes — same pattern as orchestrator.integration.test.ts. Every
// dependency is fully offline: ready/authenticated provider, canned mode,
// inert target, and a no-op browser. Individual tests clone + tweak these so a
// single behavior is exercised per case.
// ---------------------------------------------------------------------------

/** Canned plan body the fake provider emits as a fenced JSON object. */
const CANNED_PLAN = {
  summary: 'Offline canned plan.',
  items: [
    { title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', intent: 'Landing renders.' },
    { title: 'Login works', reqTag: 'REQ-002', tier: 'tierB-auth', intent: 'User can sign in.' },
  ],
};

function fencedPlan(): string {
  return ['```json', JSON.stringify(CANNED_PLAN), '```'].join('\n');
}

/** ProviderAdapter that never touches the network: ready, authenticated, canned. */
const fakeProvider: ProviderAdapter = {
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
    return { provider: 'claude', ok: true, plan: fencedPlan(), raw: CANNED_PLAN, detail: 'OK' };
  },
  async complete(_prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
    if (opts?.mode === 'plan') {
      return { provider: 'claude', ok: true, text: fencedPlan(), raw: CANNED_PLAN, detail: 'OK' };
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

const CANNED_SPECS: GeneratedSpec[] = [
  {
    path: 'tests/home.spec.ts',
    title: 'Home loads',
    reqTag: 'REQ-001',
    tier: 'tierA-public',
    contents: '// home spec',
  },
  {
    path: 'tests/login.spec.ts',
    title: 'Login works',
    reqTag: 'REQ-002',
    tier: 'tierB-auth',
    contents: '// login spec',
  },
];

/** Every spec passes — drives the run to a 'passed' summary. */
const ALL_PASS_OUTCOME: ExecOutcome = {
  passed: 2,
  failed: 0,
  blocked: 0,
  flaky: 0,
  results: [
    { title: 'Home loads', status: 'passed', durationMs: 12 },
    { title: 'Login works', status: 'passed', durationMs: 34 },
  ],
};

/** Build a fresh TestMode whose phases return canned, side-effect-free data. */
function makeFakeMode(outcome: ExecOutcome): TestMode {
  return {
    id: 'playwright',
    async scaffold(_ctx: TestModeContext): Promise<void> {
      /* noop */
    },
    async generate(_ctx: TestModeContext, _plan: TestPlan): Promise<GeneratedSpec[]> {
      return CANNED_SPECS.map((s) => ({ ...s }));
    },
    async execute(_ctx: TestModeContext, _specs: GeneratedSpec[]): Promise<ExecOutcome> {
      return { ...outcome, results: outcome.results.map((r) => ({ ...r })) };
    },
    async collectArtifacts(_ctx: TestModeContext): Promise<{ dir: string; files: string[] }> {
      return { dir: 'artifacts', files: ['test-results/x.png'] };
    },
    async export(_ctx: TestModeContext): Promise<SuiteBundle> {
      return { dir: 'export', files: ['playwright.config.ts'] };
    },
  };
}

/** TargetAdapter stub: nothing real launches or probes. */
const fakeTarget: TargetAdapter = {
  async detect(_repoPath: string): Promise<DetectedProject> {
    return {
      kind: 'frontend',
      framework: null,
      packageManager: null,
      startCommand: null,
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

/** A no-op BrowserSurface; tests that need frames build a richer one inline. */
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
  dataDir = mkdtempSync(join(tmpdir(), 'healix-orch-paths-'));
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

describe('orchestrator paths (offline DI seam)', () => {
  it('ALL-PASS: drives to a passed summary, writes report.json, persists exactly one row per spec', async () => {
    const store = (await getStore()) as HealixStore;
    expect(store).not.toBeNull();

    const project = store.createProject({
      name: 'All Pass Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeFakeMode(ALL_PASS_OUTCOME),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: true },
      { onEvent: (e) => events.push(e) },
    );

    // ---- RunSummary: passed (no failures) ----
    expect(summary.status).toBe('passed');
    expect(summary.runId).toMatch(/^run_/);
    expect(summary.outcome?.passed).toBe(2);
    expect(summary.outcome?.failed).toBe(0);
    expect(summary.reportPath).toBeDefined();

    // ---- persisted run is terminal 'passed' ----
    const run = store.getRun(summary.runId);
    expect(run?.status).toBe('passed');
    expect(run?.finishedAt).toBeTruthy();

    // ---- exactly two test rows, no duplicates ----
    const tests = store.listTests(summary.runId);
    expect(tests).toHaveLength(2);
    expect(tests.map((t) => t.title).sort()).toEqual(['Home loads', 'Login works']);
    expect(new Set(tests.map((t) => t.id)).size).toBe(2);

    // ---- exactly one result row per spec (no duplicate result rows) ----
    const results = store.listResults(summary.runId);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'passed')).toBe(true);
    expect(new Set(results.map((r) => r.testId)).size).toBe(2);

    // ---- report.json written under reports/ with an all-passed outcome ----
    const expectedReportPath = join(
      projectsDir(),
      project.id,
      'runs',
      summary.runId,
      'reports',
      'report.json',
    );
    expect(summary.reportPath).toBe(expectedReportPath);

    const report = JSON.parse(await readFile(expectedReportPath, 'utf8')) as RunReport;
    expect(report.outcome?.passed).toBe(2);
    expect(report.outcome?.failed).toBe(0);
    // No failures → no triage entries.
    expect(report.triage).toHaveLength(0);

    // 'done' event reflects the passed run.
    const done = events.find((e) => e.phase === 'done');
    expect(done?.message).toContain('passed');
  });

  it('APPROVAL-GATE reject: onPlan returning false cancels the run before execute', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Approval Reject Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // Instrument generate/execute with manual call counters (matching the
    // closure-based style of the existing integration test) so we can prove
    // neither runs once the plan is rejected.
    const base = makeFakeMode(ALL_PASS_OUTCOME);
    let generateCalls = 0;
    let executeCalls = 0;
    const mode: TestMode = {
      ...base,
      async generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
        generateCalls += 1;
        return base.generate(ctx, plan);
      },
      async execute(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
        executeCalls += 1;
        return base.execute(ctx, specs);
      },
    };

    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => mode,
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    let onPlanCalls = 0;
    const onPlan = async (_plan: TestPlan): Promise<boolean> => {
      onPlanCalls += 1;
      return false;
    };

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: false },
      { onEvent: (e) => events.push(e), onPlan },
    );

    // ---- run cancelled, no execution ----
    expect(summary.status).toBe('cancelled');
    expect(summary.outcome).toBeUndefined();
    expect(onPlanCalls).toBe(1);
    expect(generateCalls).toBe(0);
    expect(executeCalls).toBe(0);

    // ---- persisted run is terminal 'cancelled' ----
    const run = store.getRun(summary.runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.finishedAt).toBeTruthy();

    // ---- no test rows were created (generate never ran) ----
    expect(store.listTests(summary.runId)).toHaveLength(0);

    // ---- the approve phase recorded the rejection; no execute phase exists ----
    const phases = events.map((e) => String(e.phase));
    expect(phases).toContain('approve');
    expect(phases).not.toContain('execute');
    const rejected = events.find((e) => e.phase === 'approve' && /reject/i.test(e.message));
    expect(rejected).toBeDefined();
  });

  it('PROVIDER FALLBACK: a ProviderRouter selects a ready fallback when the preferred provider is unhealthy', async () => {
    // The router fallback unit, driven purely by injected providers (the
    // orchestrator constructs its own router internally, so we exercise the
    // fallback logic directly with deterministic fakes). Preferred provider
    // ('claude') is unhealthy; the fallback ('openai') is ready.
    const unhealthyClaude: ProviderAdapter = {
      ...fakeProvider,
      async health(): Promise<HealthResult> {
        return {
          provider: 'claude',
          status: 'not-authenticated',
          installed: true,
          binPath: '/fake/claude',
          version: '1.0.0',
          authenticated: false,
          model: null,
          latencyMs: 1,
          detail: 'not logged in',
        };
      },
    };
    const readyOpenAI: ProviderAdapter = {
      ...fakeProvider,
      id: 'openai',
      label: 'Fake OpenAI',
      async health(): Promise<HealthResult> {
        return {
          provider: 'openai',
          status: 'ready',
          installed: true,
          binPath: '/fake/openai',
          version: '2.0.0',
          authenticated: true,
          model: 'fake-openai',
          latencyMs: 1,
          detail: 'OK',
        };
      },
      async complete(_prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
        if (opts?.mode === 'plan') {
          return { provider: 'openai', ok: true, text: fencedPlan(), raw: CANNED_PLAN, detail: 'OK' };
        }
        return { provider: 'openai', ok: true, text: 'canned text', raw: null, detail: 'OK' };
      },
    };

    const router = new ProviderRouter([unhealthyClaude, readyOpenAI]);
    // Auto-select for 'plan' must skip the unhealthy preferred and land on the ready fallback.
    const selected = await router.select('plan');
    expect(selected?.provider.id).toBe('openai');
    // firstReady excluding the (unhealthy) preferred id returns the ready fallback.
    const fallback = await router.firstReady('plan', { exclude: 'claude' });
    expect(fallback?.id).toBe('openai');
  });

  it('PROVIDER FALLBACK: a degraded primary still produces a plan (fallback) and emits a warn event', async () => {
    // Orchestrator-level coverage of the degraded-provider path via the provider
    // override seam: the injected provider returns ok:false for the plan
    // completion, so the orchestrator cannot parse a model plan and falls back to
    // a synthesized plan — emitting at least one warn — yet the run still
    // completes (it still plans).
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Fallback Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const degradedProvider: ProviderAdapter = {
      ...fakeProvider,
      async complete(_prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
        if (opts?.mode === 'plan') {
          // Preferred provider cannot deliver a usable plan (provider-level failure).
          return { provider: 'claude', ok: false, text: '', raw: null, detail: 'temporarily unavailable' };
        }
        return { provider: 'claude', ok: true, text: 'canned text', raw: null, detail: 'OK' };
      },
    };

    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      provider: degradedProvider,
      getMode: () => makeFakeMode(ALL_PASS_OUTCOME),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: true },
      { onEvent: (e) => events.push(e) },
    );

    // The run still completes — it planned via the synthesized fallback.
    expect(['passed', 'failed']).toContain(summary.status);
    expect(summary.reportPath).toBeDefined();

    // A warn was emitted during planning about the unusable provider / fallback.
    const planWarns = events.filter((e) => e.phase === 'plan' && e.level === 'warn');
    expect(planWarns.length).toBeGreaterThanOrEqual(1);
    expect(planWarns.some((e) => /fallback|no usable plan/i.test(e.message))).toBe(true);

    // The synthesized fallback plan was actually used (it has at least one item).
    const reportPath = join(projectsDir(), project.id, 'runs', summary.runId, 'reports', 'report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as RunReport;
    expect(report.plan.items.length).toBeGreaterThan(0);
  });

  it('LIVE FRAMES: computer-use exploration mirrors frames, then unsubscribes and stops the browser', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Live Frames Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // A browser that emits exactly one frame on subscription and records its
    // unsubscribe + stop calls so we can assert correct teardown ordering.
    let unsubscribeCalled = false;
    let stopCalled = false;
    let subscribedAfterStartAndGoto = false;
    let started = false;
    let navigated = false;

    const framingBrowser: BrowserSurface = {
      async start(_opts?: BrowserSurfaceOptions): Promise<void> {
        started = true;
      },
      async goto(_url: string): Promise<void> {
        navigated = true;
      },
      async screenshot(): Promise<Buffer> {
        return Buffer.alloc(0);
      },
      async snapshot(): Promise<DomSnapshot> {
        return { url: 'https://app.example.test', title: 'Home', interactiveElements: [] };
      },
      async click(_selector: string): Promise<void> {},
      async clickAt(_point: Point): Promise<void> {},
      async type(_selector: string, _text: string): Promise<void> {},
      async pressKey(_key: string): Promise<void> {},
      onFrame(cb: (png: Buffer) => void): () => void {
        // Subscription must happen only after start() + goto() so the UI mirrors
        // the live page.
        subscribedAfterStartAndGoto = started && navigated;
        // Emit a single synchronous frame.
        cb(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return () => {
          unsubscribeCalled = true;
        };
      },
      async stop(): Promise<void> {
        stopCalled = true;
      },
    };

    const frames: Buffer[] = [];
    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeFakeMode(ALL_PASS_OUTCOME),
      makeTarget: () => fakeTarget,
      makeBrowser: () => framingBrowser,
    });

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: true, explorationMode: 'computer-use' },
      { onFrame: (png) => frames.push(png) },
    );

    // The run completed normally.
    expect(['passed', 'failed']).toContain(summary.status);

    // At least one frame buffer reached the onFrame hook.
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.isBuffer(frames[0])).toBe(true);
    expect(frames[0]?.length).toBeGreaterThan(0);

    // Subscription happened after start() + goto(), and teardown unsubscribed and
    // stopped the browser.
    expect(subscribedAfterStartAndGoto).toBe(true);
    expect(unsubscribeCalled).toBe(true);
    expect(stopCalled).toBe(true);
  });

  it('FALSE-GREEN GUARD: a run that generates zero specs settles as error, not passed', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Zero Spec Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // generate() yields nothing and execute() returns an empty outcome — the
    // pipeline verified nothing, so the run must NOT be reported 'passed'.
    const emptyOutcome: ExecOutcome = { passed: 0, failed: 0, blocked: 0, flaky: 0, results: [] };
    const mode: TestMode = {
      ...makeFakeMode(emptyOutcome),
      async generate(): Promise<GeneratedSpec[]> {
        return [];
      },
    };

    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => mode,
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: true },
      { onEvent: (e) => events.push(e) },
    );

    expect(summary.status).toBe('error');
    expect(summary.outcome?.passed).toBe(0);
    expect(store.getRun(summary.runId)?.status).toBe('error');

    // The 'done' event explains WHY nothing was verified — not a bare "passed".
    const done = events.find((e) => e.phase === 'done');
    expect(done?.level).toBe('error');
    expect(done?.message).toMatch(/no runnable specs|verified nothing/i);
  });

  it('FALSE-GREEN GUARD: an all-blocked outcome settles as error, not passed', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'All Blocked Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // Specs generate fine, but every test is blocked (e.g. missing Tier-B auth):
    // nothing actually passed, so the run must be 'error', never a false green.
    const allBlocked: ExecOutcome = {
      passed: 0,
      failed: 0,
      blocked: 2,
      flaky: 0,
      results: [
        { title: 'Home loads', status: 'blocked', durationMs: 5 },
        { title: 'Login works', status: 'blocked', durationMs: 6 },
      ],
    };

    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeFakeMode(allBlocked),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: true },
      { onEvent: (e) => events.push(e) },
    );

    expect(summary.status).toBe('error');
    expect(summary.outcome?.blocked).toBe(2);
    expect(summary.outcome?.passed).toBe(0);
    expect(store.getRun(summary.runId)?.status).toBe('error');

    const done = events.find((e) => e.phase === 'done');
    expect(done?.level).toBe('error');
    expect(done?.message).toMatch(/no tests passed|verified nothing/i);
  });

  it('TRIAGE AI ESCALATION: a failed spec drives an AI-escalated triage call with a per-call abort signal', async () => {
    // Regression coverage for the orphaned-triage-process bug: the orchestrator
    // must give each AI-escalated triage call its own AbortController (so a
    // slow call can be killed instead of abandoned to keep running in the
    // background after the run reports complete). This asserts the provider's
    // complete() call made during triage actually receives a live signal.
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Triage Escalation Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const oneFailedOutcome: ExecOutcome = {
      passed: 1,
      failed: 1,
      blocked: 0,
      flaky: 0,
      results: [
        { title: 'Home loads', status: 'passed', durationMs: 12 },
        { title: 'Login works', status: 'failed', durationMs: 34, error: 'expect(locator).toBeVisible() failed' },
      ],
    };

    const triageCompleteOpts: CompleteOptions[] = [];
    const triageAwareProvider: ProviderAdapter = {
      ...fakeProvider,
      async complete(_prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
        if (opts?.mode === 'plan') {
          return { provider: 'claude', ok: true, text: fencedPlan(), raw: CANNED_PLAN, detail: 'OK' };
        }
        // Codegen and triage both land here (neither sets mode:'plan'), but only
        // triage.analyze() calls provider.complete() without readOnly:true (see
        // triage/index.ts vs. generate.ts's readOnly:true codegen calls) — use
        // that to isolate triage's escalation call specifically.
        if (opts && !opts.readOnly) triageCompleteOpts.push(opts);
        return { provider: 'claude', ok: true, text: 'canned text', raw: null, detail: 'OK' };
      },
    };

    const orchestrator = createOrchestrator({
      provider: triageAwareProvider,
      getMode: () => makeFakeMode(oneFailedOutcome),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run({ projectId: project.id, autoApprove: true }, {});

    expect(['passed', 'failed']).toContain(summary.status);
    expect(triageCompleteOpts.length).toBeGreaterThanOrEqual(1);
    // Every triage-escalation call must carry its own live (not-yet-aborted)
    // AbortSignal, proving the orchestrator's per-call AbortController wiring
    // (withTimeoutAbort) reaches all the way down to provider.complete().
    for (const opts of triageCompleteOpts) {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      expect(opts.signal?.aborted).toBe(false);
    }
  });
});
