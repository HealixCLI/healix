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
// Same offline-DI-seam fake pattern as orchestrator.paths.test.ts. Two tiers
// (tierA-public, tierB-auth) so EXECUTE's per-tier loop has something to
// actually split across — the whole point of these tests.
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
  { path: 'tests/home.spec.ts', title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', contents: '// home' },
  { path: 'tests/login.spec.ts', title: 'Login works', reqTag: 'REQ-002', tier: 'tierB-auth', contents: '// login' },
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
  async stop(): Promise<void> {},
};

interface ExecuteProbe {
  generateCalls: number;
  executeCallsByTier: string[];
}

/** TestMode whose execute() throws for a specific tier's call (once), simulating a mid-suite interruption. */
function makeInterruptibleMode(probe: ExecuteProbe, failOnTier: string | null, failMessage: string): TestMode {
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
    async execute(_ctx: TestModeContext, specs: GeneratedSpec[], opts?: { onlyTier?: string }): Promise<ExecOutcome> {
      const tier = opts?.onlyTier ?? specs[0]?.tier ?? 'unknown';
      probe.executeCallsByTier.push(tier);
      if (!failed && failOnTier !== null && tier === failOnTier) {
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
  it('EXECUTE network interruption: pauses (not errors) after the completed tier, checkpoint reflects progress', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Resume Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const probe: ExecuteProbe = { generateCalls: 0, executeCallsByTier: [] };
    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeInterruptibleMode(probe, 'tierB-auth', 'request to provider failed, reason: fetch failed'),
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
    expect(checkpoint?.completedTiers).toEqual(['tierA-public']);
    expect(checkpoint?.generatedSpecs.map((s) => s.title).sort()).toEqual(['Home loads', 'Login works']);

    expect(probe.generateCalls).toBe(1);
    expect(probe.executeCallsByTier).toEqual(['tierA-public', 'tierB-auth']);
  });

  it('resume() after an EXECUTE-phase pause: skips GENERATE and the already-done tier, only runs the remaining one', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Resume Demo 2',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const failingProbe: ExecuteProbe = { generateCalls: 0, executeCallsByTier: [] };
    const failingOrchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeInterruptibleMode(failingProbe, 'tierB-auth', 'socket hang up'),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const paused = await failingOrchestrator.run({ projectId: project.id, autoApprove: true });
    expect(paused.status).toBe('paused');

    // A fresh, healthy mode for the resume attempt — proves resume() doesn't
    // reuse the failing one, and lets us assert exactly what it invokes.
    const resumeProbe: ExecuteProbe = { generateCalls: 0, executeCallsByTier: [] };
    const resumeOrchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeInterruptibleMode(resumeProbe, null, ''),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const summary = await resumeOrchestrator.resume(paused.runId);

    expect(summary.status).toBe('passed');
    expect(summary.outcome?.passed).toBe(2);
    // GENERATE was fully done before the pause — resume must not regenerate.
    expect(resumeProbe.generateCalls).toBe(0);
    // tierA-public already completed before the pause — resume runs ONLY tierB-auth.
    expect(resumeProbe.executeCallsByTier).toEqual(['tierB-auth']);

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

  it('GENERATE network interruption: pauses before anything is generated; resume redoes GENERATE from scratch', async () => {
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
    expect(checkpoint?.completedTiers).toEqual([]);

    const probe: ExecuteProbe = { generateCalls: 0, executeCallsByTier: [] };
    const resumeOrchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeInterruptibleMode(probe, null, ''),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const summary = await resumeOrchestrator.resume(paused.runId);
    expect(summary.status).toBe('passed');
    expect(probe.generateCalls).toBe(1);
    expect(probe.executeCallsByTier.sort()).toEqual(['tierA-public', 'tierB-auth']);
  });

  it('MANUAL PAUSE: aborting with reason "pause" settles paused/manual instead of cancelled', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Manual Pause Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const controller = new AbortController();
    let tierACalled = false;
    const mode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(): Promise<GeneratedSpec[]> {
        return CANNED_SPECS.map((s) => ({ ...s }));
      },
      async execute(_ctx, specs: GeneratedSpec[]): Promise<ExecOutcome> {
        if (specs[0]?.tier === 'tierA-public') {
          tierACalled = true;
          // Simulate the user clicking Pause while tier A is running.
          controller.abort('pause');
        }
        const results = specs.map((s) => ({ title: s.title, status: 'passed' as const }));
        return { passed: results.length, failed: 0, blocked: 0, flaky: 0, results };
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

    expect(tierACalled).toBe(true);
    expect(summary.status).toBe('paused');
    expect(store.getRun(summary.runId)?.pauseReason).toBe('manual');

    const runDir = join(projectsDir(), project.id, 'runs', summary.runId);
    const checkpoint = await readCheckpoint(runDir);
    expect(checkpoint?.completedTiers).toEqual(['tierA-public']);
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
    const run = store.createRun(project.id, { provider: null, mode: 'playwright', suiteMode: 'fresh', baseRunId: null });

    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => makeInterruptibleMode({ generateCalls: 0, executeCallsByTier: [] }, null, ''),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.resume(run.id);
    expect(summary.status).toBe('error');
  });
});
