import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOrchestrator } from './index.js';
import { readCheckpoint } from './checkpoint.js';
import { projectsDir } from '../env/app-data.js';
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
// Same offline-DI-seam fake pattern as orchestrator.paths.test.ts. All tiers
// run in a SINGLE mode.execute() call now (see modes/playwright/execute.ts —
// tier-level splitting was replaced by that mode's own test-level, write-
// through checkpoint), so these tests exercise the ORCHESTRATOR's contract
// with mode.execute() (called once per attempt, resumed by calling it again)
// rather than per-tier bookkeeping, which no longer exists at this layer.
// ---------------------------------------------------------------------------

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
    return { provider: 'claude', ok: true, text: 'canned text', raw: null, detail: 'OK' };
  },
};

const CANNED_SPECS: GeneratedSpec[] = [
  {
    path: 'tests/home.spec.ts',
    title: 'Home loads',
    reqTag: 'REQ-001',
    tier: 'tierA-public',
    contents: '// home',
  },
  {
    path: 'tests/login.spec.ts',
    title: 'Login works',
    reqTag: 'REQ-002',
    tier: 'tierB-auth',
    contents: '// login',
  },
];

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

interface ExecuteProbe {
  generateCalls: number;
  executeCalls: number;
}

/** TestMode whose execute() throws once (simulating an interruption), then succeeds on any later call. */
function makeInterruptibleMode(probe: ExecuteProbe, shouldFail: boolean, failMessage: string): TestMode {
  let failed = false;
  return {
    id: 'playwright',
    async scaffold(_ctx: TestModeContext): Promise<void> {},
    // Writes real files under ctx.projectDir (like a real mode does), with
    // absolute paths — resume's hydrateCheckpointedSpecs reads these back
    // from disk, so the fixture has to actually put them there.
    async generate(ctx: TestModeContext, _plan: TestPlan): Promise<GeneratedSpec[]> {
      probe.generateCalls += 1;
      const specs: GeneratedSpec[] = [];
      for (const s of CANNED_SPECS) {
        const abs = join(ctx.projectDir, s.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, s.contents, 'utf-8');
        specs.push({ ...s, path: abs });
      }
      return specs;
    },
    async execute(_ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
      probe.executeCalls += 1;
      if (!failed && shouldFail) {
        failed = true;
        throw new Error(failMessage);
      }
      const results = specs.map((s) => ({ title: s.title, status: 'passed' as const, durationMs: 5 }));
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

let dataDir: string;
const prevDataDir = process.env.HEALIX_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-orch-resume-'));
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

describe('orchestrator pause/resume (offline DI seam)', () => {
  it('EXECUTE interruption: pauses (not errors), checkpoint reflects executeComplete: false', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Resume Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const probe: ExecuteProbe = { generateCalls: 0, executeCalls: 0 };
    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeInterruptibleMode(probe, true, 'request to provider failed, reason: fetch failed'),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run({ projectId: project.id, autoApprove: true });

    expect(summary.status).toBe('paused');
    const run = store.getRun(summary.runId);
    expect(run?.status).toBe('paused');
    expect(run?.pauseReason).toBe('network');
    // Never terminal — must survive failOrphanedRuns()'s reaping sweep.
    expect(run?.finishedAt).toBeTruthy();

    const runDir = join(projectsDir(), project.id, 'runs', summary.runId);
    const checkpoint = await readCheckpoint(runDir);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.phase).toBe('execute');
    expect(checkpoint?.executeComplete).toBe(false);
    expect(checkpoint?.generatedSpecs.map((s) => s.title).sort()).toEqual(['Home loads', 'Login works']);

    expect(probe.generateCalls).toBe(1);
    expect(probe.executeCalls).toBe(1);
  });

  it('resume() after an EXECUTE-phase pause: skips GENERATE, re-executes the full suite exactly once', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Resume Demo 2',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const failingProbe: ExecuteProbe = { generateCalls: 0, executeCalls: 0 };
    const failingOrchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeInterruptibleMode(failingProbe, true, 'socket hang up'),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const paused = await failingOrchestrator.run({ projectId: project.id, autoApprove: true });
    expect(paused.status).toBe('paused');

    // A fresh, healthy mode for the resume attempt — proves resume() doesn't
    // reuse the failing one, and lets us assert exactly what it invokes.
    const resumeProbe: ExecuteProbe = { generateCalls: 0, executeCalls: 0 };
    const resumeOrchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeInterruptibleMode(resumeProbe, false, ''),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const summary = await resumeOrchestrator.resume(paused.runId);

    expect(summary.status).toBe('passed');
    expect(summary.outcome?.passed).toBe(2);
    // GENERATE was fully done before the pause — resume must not regenerate.
    expect(resumeProbe.generateCalls).toBe(0);
    // Tier-level skipping no longer exists at the orchestrator layer — the
    // WHOLE suite is handed to mode.execute() again in one call; it's that
    // mode's own on-disk checkpoint (tested separately in execute.test.ts)
    // that would skip already-finished tests within this single call.
    expect(resumeProbe.executeCalls).toBe(1);

    const run = store.getRun(summary.runId);
    expect(run?.id).toBe(paused.runId);
    expect(run?.status).toBe('passed');

    // Both tiers' test rows exist exactly once — no duplicates from GENERATE
    // having run only for the original (pre-pause) attempt.
    const tests = store.listTests(summary.runId);
    expect(tests).toHaveLength(2);
    expect(new Set(tests.map((t) => t.id)).size).toBe(2);

    // Checkpoint is cleaned up once the run reaches a terminal state.
    const runDir = join(projectsDir(), project.id, 'runs', summary.runId);
    expect(await readCheckpoint(runDir)).toBeNull();
  });

  it('GENERATE network interruption: pauses before anything is generated; resume redoes GENERATE then executes once', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Resume Demo 3',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    let generateCalls = 0;
    const failingMode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(): Promise<GeneratedSpec[]> {
        generateCalls += 1;
        throw new Error('ECONNREFUSED 127.0.0.1:443');
      },
      async execute(): Promise<ExecOutcome> {
        return { passed: 0, failed: 0, blocked: 0, flaky: 0, results: [] };
      },
      async collectArtifacts(): Promise<{ dir: string; files: string[] }> {
        return { dir: 'artifacts', files: [] };
      },
      async export(): Promise<SuiteBundle> {
        return { dir: 'export', files: [] };
      },
    };
    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => failingMode,
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const paused = await orchestrator.run({ projectId: project.id, autoApprove: true });
    expect(paused.status).toBe('paused');
    expect(store.getRun(paused.runId)?.pauseReason).toBe('network');
    expect(generateCalls).toBe(1);

    const runDir = join(projectsDir(), project.id, 'runs', paused.runId);
    const checkpoint = await readCheckpoint(runDir);
    expect(checkpoint?.phase).toBe('generate');
    expect(checkpoint?.executeComplete).toBe(false);

    const probe: ExecuteProbe = { generateCalls: 0, executeCalls: 0 };
    const resumeOrchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeInterruptibleMode(probe, false, ''),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const summary = await resumeOrchestrator.resume(paused.runId);
    expect(summary.status).toBe('passed');
    expect(probe.generateCalls).toBe(1);
    expect(probe.executeCalls).toBe(1);
  });

  it('MANUAL PAUSE mid-execute (no throw): an aborted-but-returned outcome settles paused/manual, not a false "complete"', async () => {
    // Regression for the single-invocation model: the REAL execute.ts detects
    // ctx.signal aborting mid-run and returns a normal, non-throwing
    // zeroed/aborted outcome (never an exception) — see abortedOutcome() in
    // modes/playwright/execute.ts. The orchestrator must recognize that via
    // its OWN checkCancelled() check right after the await, not just its
    // catch-block pause handling, or an aborted call would be misread as a
    // genuinely completed (zero passed, zero failed) execute phase.
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Manual Pause Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const controller = new AbortController();
    let executeCalled = false;
    const mode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(): Promise<GeneratedSpec[]> {
        return CANNED_SPECS.map((s) => ({ ...s }));
      },
      async execute(): Promise<ExecOutcome> {
        executeCalled = true;
        // Simulate the user clicking Pause while Playwright is running.
        controller.abort('pause');
        return { passed: 0, failed: 0, blocked: 0, flaky: 0, results: [], raw: { aborted: true } };
      },
      async collectArtifacts(): Promise<{ dir: string; files: string[] }> {
        return { dir: 'artifacts', files: [] };
      },
      async export(): Promise<SuiteBundle> {
        return { dir: 'export', files: [] };
      },
    };

    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => mode,
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run({
      projectId: project.id,
      autoApprove: true,
      signal: controller.signal,
    });

    expect(executeCalled).toBe(true);
    expect(summary.status).toBe('paused');
    expect(store.getRun(summary.runId)?.pauseReason).toBe('manual');

    const runDir = join(projectsDir(), project.id, 'runs', summary.runId);
    const checkpoint = await readCheckpoint(runDir);
    expect(checkpoint?.executeComplete).toBe(false);
  });

  it('MANUAL PAUSE mid-provider-call: an in-flight generate() call killed by the pause abort still settles paused, not error', async () => {
    // Regression: a live pause aborts ctx.signal, which is exactly what kills
    // an in-flight provider completion — but the resulting error ("Completion
    // aborted", or similar) does NOT match classifyTransientFailure's network/
    // credits regexes. The orchestrator must check isPauseRequested() BEFORE
    // pattern-matching the error text, or this misclassifies as a hard error.
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Manual Pause Mid-Call Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const controller = new AbortController();
    const mode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(): Promise<GeneratedSpec[]> {
        // Simulate the user clicking Pause while this provider call is in flight.
        controller.abort('pause');
        // A real provider call rejects with a generic message once its signal
        // aborts — deliberately NOT a recognizable network/credits pattern.
        throw new Error('Completion aborted.');
      },
      async execute(): Promise<ExecOutcome> {
        return { passed: 0, failed: 0, blocked: 0, flaky: 0, results: [] };
      },
      async collectArtifacts(): Promise<{ dir: string; files: string[] }> {
        return { dir: 'artifacts', files: [] };
      },
      async export(): Promise<SuiteBundle> {
        return { dir: 'export', files: [] };
      },
    };

    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => mode,
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run({
      projectId: project.id,
      autoApprove: true,
      signal: controller.signal,
    });

    expect(summary.status).toBe('paused');
    expect(store.getRun(summary.runId)?.pauseReason).toBe('manual');
  });

  it('resume() with no checkpoint (e.g. a hard-errored run) fails cleanly with status error', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'No Checkpoint Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });
    const run = store.createRun(project.id, {
      provider: null,
      mode: 'playwright',
      suiteMode: 'fresh',
      baseRunId: null,
    });

    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeInterruptibleMode({ generateCalls: 0, executeCalls: 0 }, false, ''),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.resume(run.id);
    expect(summary.status).toBe('error');
  });
});
