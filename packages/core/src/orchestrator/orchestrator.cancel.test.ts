import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOrchestrator } from './index.js';
import type { OrchestratorEvent } from './types.js';
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

// ---------------------------------------------------------------------------
// Cooperative-cancellation coverage for the orchestrator, driven entirely
// through the DI seam (same offline fakes pattern as orchestrator.paths.test.ts):
//  - a pre-aborted signal cancels BEFORE any phase does work,
//  - an abort while parked at the approval gate resolves 'cancelled' instead
//    of hanging forever,
//  - the signal is threaded into ctx (modes) and CompleteOptions (provider),
//  - an abort mid-run stops at the next phase boundary.
// ---------------------------------------------------------------------------

const CANNED_PLAN = {
  summary: 'Offline canned plan.',
  items: [{ title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', intent: 'Landing renders.' }],
};

function fencedPlan(): string {
  return ['```json', JSON.stringify(CANNED_PLAN), '```'].join('\n');
}

/** Build a fresh fake provider that records every complete() call's options. */
function makeFakeProvider(calls: CompleteOptions[]): ProviderAdapter {
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
      return { provider: 'claude', ok: true, plan: fencedPlan(), raw: CANNED_PLAN, detail: 'OK' };
    },
    async complete(_prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
      calls.push(opts ?? {});
      return { provider: 'claude', ok: true, text: fencedPlan(), raw: CANNED_PLAN, detail: 'OK' };
    },
  };
}

const CANNED_SPECS: GeneratedSpec[] = [
  {
    path: 'tests/home.spec.ts',
    title: 'Home loads',
    reqTag: 'REQ-001',
    tier: 'tierA-public',
    contents: '// home spec',
  },
];

const ALL_PASS_OUTCOME: ExecOutcome = {
  passed: 1,
  failed: 0,
  blocked: 0,
  flaky: 0,
  results: [{ title: 'Home loads', status: 'passed', durationMs: 12 }],
};

interface ModeProbe {
  generateCalls: number;
  executeCalls: number;
  generateCtxSignal: AbortSignal | undefined;
  /** Optional hook invoked at the top of generate() (e.g. to abort mid-run). */
  onGenerate?: () => void;
}

/** Fake mode instrumented with call counters + a ctx.signal capture. */
function makeFakeMode(probe: ModeProbe): TestMode {
  return {
    id: 'playwright',
    async scaffold(_ctx: TestModeContext): Promise<void> {},
    async generate(ctx: TestModeContext, _plan: TestPlan): Promise<GeneratedSpec[]> {
      probe.generateCalls += 1;
      probe.generateCtxSignal = ctx.signal;
      probe.onGenerate?.();
      return CANNED_SPECS.map((s) => ({ ...s }));
    },
    async execute(_ctx: TestModeContext, _specs: GeneratedSpec[]): Promise<ExecOutcome> {
      probe.executeCalls += 1;
      return { ...ALL_PASS_OUTCOME, results: ALL_PASS_OUTCOME.results.map((r) => ({ ...r })) };
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
  dataDir = mkdtempSync(join(tmpdir(), 'healix-orch-cancel-'));
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

describe('orchestrator cancellation (offline DI seam)', () => {
  it('PRE-ABORTED: an already-aborted signal cancels before any phase runs', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Pre-Aborted Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const completeCalls: CompleteOptions[] = [];
    const probe: ModeProbe = { generateCalls: 0, executeCalls: 0, generateCtxSignal: undefined };
    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      provider: makeFakeProvider(completeCalls),
      getMode: () => makeFakeMode(probe),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const controller = new AbortController();
    controller.abort();

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: true, signal: controller.signal },
      { onEvent: (e) => events.push(e) },
    );

    // Resolves (never rejects) with a 'cancelled' summary.
    expect(summary.status).toBe('cancelled');
    expect(summary.runId).toMatch(/^run_/);
    expect(summary.outcome).toBeUndefined();

    // Persisted run row is terminal 'cancelled' with a finishedAt timestamp.
    const run = store.getRun(summary.runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.finishedAt).toBeTruthy();

    // No phase did any work: no provider completion, no generate/execute, no
    // test rows.
    expect(completeCalls).toHaveLength(0);
    expect(probe.generateCalls).toBe(0);
    expect(probe.executeCalls).toBe(0);
    expect(store.listTests(summary.runId)).toHaveLength(0);

    // The cancellation surfaced as an info event; no downstream phases appear.
    const cancelled = events.find((e) => /cancelled/i.test(e.message));
    expect(cancelled?.level).toBe('info');
    const phases = events.map((e) => String(e.phase));
    expect(phases).not.toContain('generate');
    expect(phases).not.toContain('execute');
    expect(phases).not.toContain('done');
  });

  it('APPROVAL-GATE: aborting while parked at the gate resolves cancelled instead of hanging', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Gate Abort Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const completeCalls: CompleteOptions[] = [];
    const probe: ModeProbe = { generateCalls: 0, executeCalls: 0, generateCtxSignal: undefined };
    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      provider: makeFakeProvider(completeCalls),
      getMode: () => makeFakeMode(probe),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const controller = new AbortController();

    // The gate NEVER resolves — only the abort race can unblock the run.
    let gateEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      gateEntered = resolve;
    });
    const onPlan = (_plan: TestPlan): Promise<boolean> => {
      gateEntered();
      return new Promise<boolean>(() => {
        /* intentionally pending forever */
      });
    };

    const runPromise = orchestrator.run(
      { projectId: project.id, autoApprove: false, signal: controller.signal },
      { onEvent: (e) => events.push(e), onPlan },
    );

    // Abort only once the run is actually parked at the gate.
    await entered;
    controller.abort();

    const summary = await runPromise;
    expect(summary.status).toBe('cancelled');

    const run = store.getRun(summary.runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.finishedAt).toBeTruthy();

    // Nothing past the gate ran.
    expect(probe.generateCalls).toBe(0);
    expect(probe.executeCalls).toBe(0);

    const gateCancel = events.find(
      (e) => e.phase === 'approve' && /cancelled while awaiting approval/i.test(e.message),
    );
    expect(gateCancel).toBeDefined();
  });

  it('MID-RUN: aborting during generate stops at the next phase boundary (execute never runs)', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Mid-Run Abort Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const controller = new AbortController();
    const completeCalls: CompleteOptions[] = [];
    const probe: ModeProbe = {
      generateCalls: 0,
      executeCalls: 0,
      generateCtxSignal: undefined,
      // Abort while generation is "in flight"; the cooperative boundary check
      // before EXECUTE must then cancel the run.
      onGenerate: () => controller.abort(),
    };
    const orchestrator = createOrchestrator({
      provider: makeFakeProvider(completeCalls),
      getMode: () => makeFakeMode(probe),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run({
      projectId: project.id,
      autoApprove: true,
      signal: controller.signal,
    });

    expect(summary.status).toBe('cancelled');
    expect(probe.generateCalls).toBe(1);
    expect(probe.executeCalls).toBe(0);

    const run = store.getRun(summary.runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.finishedAt).toBeTruthy();
  });

  it('PROPAGATION: the run signal is threaded into ctx.signal and CompleteOptions.signal', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Signal Propagation Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const controller = new AbortController();
    const completeCalls: CompleteOptions[] = [];
    const probe: ModeProbe = { generateCalls: 0, executeCalls: 0, generateCtxSignal: undefined };
    const orchestrator = createOrchestrator({
      provider: makeFakeProvider(completeCalls),
      getMode: () => makeFakeMode(probe),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    // Signal provided but never aborted: the run completes normally AND every
    // downstream consumer received exactly this signal instance.
    const summary = await orchestrator.run({
      projectId: project.id,
      autoApprove: true,
      signal: controller.signal,
    });

    expect(summary.status).toBe('passed');
    // The plan completion carried the signal.
    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
    expect(completeCalls[0]?.signal).toBe(controller.signal);
    // The mode ctx carried the signal.
    expect(probe.generateCtxSignal).toBe(controller.signal);
  });
});
