import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOrchestrator } from './index.js';
import { readCheckpoint, writeCheckpoint, type ResumeCheckpoint } from './checkpoint.js';
import { projectsDir } from '../env/app-data.js';
import { getStore, resetStoreForTests, type HealixStore } from '../storage/store.js';
import { persistSourceContext } from '../target/context-store.js';
import type { SourceContext } from '../target/source-context.js';
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
  /** sourceContext seen by each generate() call, in call order — undefined entries mean none was passed. */
  sourceContextsSeen?: Array<SourceContext | undefined>;
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
      (probe.sourceContextsSeen ??= []).push(ctx.sourceContext);
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

  it('pause AFTER execute completes (executeComplete: true): resume skips mode.execute() entirely and reuses partialOutcome', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Resume Demo Post-Execute',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const controller = new AbortController();
    const probe: ExecuteProbe = { generateCalls: 0, executeCalls: 0 };
    const mode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(ctx: TestModeContext): Promise<GeneratedSpec[]> {
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
        const results = specs.map((s) => ({ title: s.title, status: 'passed' as const, durationMs: 5 }));
        return { passed: results.length, failed: 0, blocked: 0, flaky: 0, results };
      },
      async collectArtifacts(): Promise<{ dir: string; files: string[] }> {
        // Simulate the user clicking Pause AFTER execute already finished
        // (e.g. right before triage) — executeComplete must already be true
        // in the checkpoint this pause writes.
        controller.abort('pause');
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

    const paused = await orchestrator.run({
      projectId: project.id,
      autoApprove: true,
      signal: controller.signal,
    });
    expect(paused.status).toBe('paused');
    expect(probe.executeCalls).toBe(1);

    const runDir = join(projectsDir(), project.id, 'runs', paused.runId);
    const checkpoint = await readCheckpoint(runDir);
    expect(checkpoint?.executeComplete).toBe(true);
    expect(checkpoint?.partialOutcome?.passed).toBe(2);

    // Fresh, healthy mode for the resume attempt — proves resume() skips
    // mode.execute() entirely rather than merely succeeding when called again.
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
    expect(resumeProbe.generateCalls).toBe(0);
    // The load-bearing assertion: executeComplete:true short-circuits EXECUTE
    // entirely on resume — mode.execute() is never called again.
    expect(resumeProbe.executeCalls).toBe(0);
  });

  it('TRIAGE resume: a failure already triaged by a prior (crashed) pass is skipped, not re-triaged or duplicated', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Resume Demo Triage',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const controller = new AbortController();
    const probe: ExecuteProbe = { generateCalls: 0, executeCalls: 0 };
    const mode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(ctx: TestModeContext): Promise<GeneratedSpec[]> {
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
        // Both fail, so both are triage candidates.
        const results = specs.map((s) => ({
          title: s.title,
          status: 'failed' as const,
          durationMs: 5,
          error: 'Error: something completely unrecognized happened',
        }));
        return { passed: 0, failed: results.length, blocked: 0, flaky: 0, results };
      },
      async collectArtifacts(): Promise<{ dir: string; files: string[] }> {
        // Pause right after execute (executeComplete: true), before TRIAGE ever runs.
        controller.abort('pause');
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

    const paused = await orchestrator.run({
      projectId: project.id,
      autoApprove: true,
      signal: controller.signal,
    });
    expect(paused.status).toBe('paused');

    // Simulate a prior TRIAGE pass that crashed after persisting a verdict
    // for exactly one of the two failures (per-batch persistence means a
    // resumed run's TRIAGE phase can find some — but not all — candidates
    // already recorded).
    const tests = store.listTests(paused.runId);
    const homeTest = tests.find((t) => t.title === 'Home loads');
    if (!homeTest) throw new Error('expected a "Home loads" test row to exist after pause');
    store.recordTriageResult({
      testId: homeTest.id,
      verdict: 'flaky',
      confidence: 0.42,
      rationale: 'Recorded by a prior, crashed TRIAGE pass.',
    });

    // Capture every triage-mode prompt sent during resume, to prove the
    // already-triaged failure's title never appears in one.
    const triagePrompts: string[] = [];
    const triageCapturingProvider: ProviderAdapter = {
      ...fakeProvider,
      async complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
        if (opts && !opts.readOnly && opts.taskType === 'triage') triagePrompts.push(prompt);
        return fakeProvider.complete(prompt, opts);
      },
    };
    const resumeOrchestrator = createOrchestrator({
      provider: triageCapturingProvider,
      getMode: () => makeInterruptibleMode({ generateCalls: 0, executeCalls: 0 }, false, ''),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });
    const summary = await resumeOrchestrator.resume(paused.runId);

    expect(summary.status).toBe('failed');
    // Resume must not re-triage (or re-spend AI budget on) the already-done
    // failure — its title never appears in a triage-mode prompt this run.
    expect(triagePrompts.some((p) => p.includes('Home loads'))).toBe(false);
    // The other failure is still triaged normally.
    expect(triagePrompts.some((p) => p.includes('Login works'))).toBe(true);

    // Exactly one row per failure — the pre-existing verdict was neither
    // duplicated nor lost.
    const rows = store.listTriageResults(summary.runId);
    expect(rows.length).toBe(2);
    const testIds = rows.map((r) => r.testId);
    expect(new Set(testIds).size).toBe(testIds.length);
    const preserved = rows.find((r) => r.testId === homeTest.id);
    expect(preserved?.verdict).toBe('flaky');
    expect(preserved?.rationale).toBe('Recorded by a prior, crashed TRIAGE pass.');
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

  it('writes a checkpoint (phase: generate, plan populated) BEFORE invoking mode.generate() — so an uncooperative crash mid-call still leaves a resumable checkpoint on disk', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Resume Demo Pre-Generate Checkpoint',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const captured: { checkpoint: ResumeCheckpoint | null } = { checkpoint: null };
    const crashingMode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(ctx: TestModeContext): Promise<GeneratedSpec[]> {
        // Simulates inspecting disk state the instant before an uncooperative
        // crash (e.g. SIGKILL) would hit mid-call — nothing after this line
        // ever runs in that scenario, so whatever's on disk RIGHT NOW is
        // exactly what a real resume would have to work with. Without the
        // orchestrator's pre-generate checkpoint write, this would be null:
        // previously nothing was ever persisted before GENERATE returned.
        const runDir = dirname(ctx.projectDir);
        captured.checkpoint = await readCheckpoint(runDir);
        throw new Error('simulated crash mid-generate');
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
      getMode: () => crashingMode,
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    // An unrecognized error message (not network/credits-shaped) still
    // hard-fails the run itself — this test only cares about what landed on
    // disk DURING the call, captured above before that failure surfaced.
    const summary = await orchestrator.run({ projectId: project.id, autoApprove: true });
    expect(summary.status).toBe('error');
    const checkpoint = captured.checkpoint;
    if (!checkpoint) throw new Error('expected a checkpoint to exist during generate()');
    expect(checkpoint.phase).toBe('generate');
    expect(checkpoint.plan.items).toHaveLength(2);
  });

  it('resume() reloads the cached source context so GENERATE is not silently ungrounded post-resume', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'healix-orch-resume-repo-'));
    try {
      const store = (await getStore()) as HealixStore;
      const project = store.createProject({
        name: 'Resume Source-Context Demo',
        mode: 'playwright',
        repoPath: repoDir,
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

      const paused = await orchestrator.run({
        projectId: project.id,
        autoApprove: true,
        testingScope: 'both',
      });
      expect(paused.status).toBe('paused');
      expect(generateCalls).toBe(1);

      // Overwrite whatever the initial (real, near-empty) indexSource() pass persisted with a
      // controlled context carrying a distinctive unit — resume() must reload exactly this, not
      // silently proceed with sourceContext undefined (the bug being fixed here).
      const knownContext: SourceContext = {
        units: [{ key: 'route:/known', kind: 'route', label: 'route: /known', file: 'src/Known.tsx' }],
        forms: [],
        authPatterns: [],
        selectorHints: [],
        specSources: [],
        summary: 'Detected functionality: 1 route(s), 0 endpoint(s).',
        truncated: false,
      };
      persistSourceContext(repoDir, 'irrelevant-for-resume', knownContext);

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
      expect(probe.sourceContextsSeen?.[0]?.units).toEqual(knownContext.units);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
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

  it('PLAN mid-batch-loop resume: a checkpoint captured after batch 1 lets resume() skip it and only plan the remainder', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'healix-orch-plan-resume-'));
    try {
      mkdirSync(join(repoPath, 'src'), { recursive: true });
      // 25 real, statically-detectable routes — enough to exceed
      // PLAN_BATCH_MAX_UNITS (20) and force runPlanPhase's multi-batch path.
      const routes = Array.from(
        { length: 25 },
        (_, i) => `app.get('/route-${i}', (req, res) => res.status(200).send('ok'));`,
      ).join('\n');
      writeFileSync(
        join(repoPath, 'src', 'app.js'),
        `const express = require('express');\nconst app = express();\n${routes}\n`,
      );

      const store = (await getStore()) as HealixStore;
      const project = store.createProject({
        name: 'Plan Batch Resume Demo',
        mode: 'playwright',
        repoPath,
        baseUrl: 'https://app.example.test',
      });
      const run = store.createRun(project.id, { suiteMode: 'fresh' });
      const runDir = join(projectsDir(), project.id, 'runs', run.id);
      mkdirSync(runDir, { recursive: true });

      // A realistic mid-PLAN checkpoint: batch 0 already resolved (2 items
      // accumulated so far), the remaining batch(es) never got a chance to
      // run before the (simulated) interruption.
      const seededCheckpoint: ResumeCheckpoint = {
        runId: run.id,
        projectId: project.id,
        phase: 'plan',
        runOptions: {},
        plan: {
          summary: 'Planning in progress: 2 item(s) so far.',
          items: [
            {
              id: 'seed-1',
              title: 'Seeded item 1',
              tier: 'tierA-public',
              intent: 'x',
              scenarios: [{ kind: 'positive', description: 'x' }],
            },
            {
              id: 'seed-2',
              title: 'Seeded item 2',
              tier: 'tierA-public',
              intent: 'x',
              scenarios: [{ kind: 'positive', description: 'x' }],
            },
          ],
          planSource: 'ai',
        },
        planProgress: { completedBatchIndices: [0], failedBatches: [] },
        generatedItemIds: [],
        generatedSpecs: [],
        executeComplete: false,
        updatedAt: new Date().toISOString(),
      };
      await writeCheckpoint(runDir, seededCheckpoint);
      store.updateRunStatus(run.id, 'paused', { pauseReason: 'manual' });

      let batch0PromptSeen = false;
      const guardedProvider: ProviderAdapter = {
        ...fakeProvider,
        async complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
          if (opts?.mode === 'plan') {
            if (prompt.includes('batch 1 of')) {
              // Batch 1 (index 0) already resolved per the seeded checkpoint —
              // resume must never re-ask for it.
              batch0PromptSeen = true;
            }
            const keys = [...prompt.matchAll(/unitKey: "([^"]+)"/g)].map((m) => m[1]);
            if (keys.length > 0) {
              const body = {
                summary: `Batch covering ${keys.length} unit(s).`,
                items: keys.map((key) => ({
                  title: `Covers ${key}`,
                  tier: 'tierA-public',
                  intent: `Exercises ${key}.`,
                  unitKey: key,
                })),
              };
              return {
                provider: 'claude',
                ok: true,
                text: ['```json', JSON.stringify(body), '```'].join('\n'),
                raw: body,
                detail: 'OK',
              };
            }
          }
          return { provider: 'claude', ok: true, text: 'canned text', raw: null, detail: 'OK' };
        },
      };

      const resumeOrchestrator = createOrchestrator({
        provider: guardedProvider,
        getMode: () => makeInterruptibleMode({ generateCalls: 0, executeCalls: 0 }, false, ''),
        makeTarget: () => fakeTarget,
        makeBrowser: () => fakeBrowser,
      });

      const summary = await resumeOrchestrator.resume(run.id);

      expect(batch0PromptSeen).toBe(false);
      expect(summary.status).not.toBe('error');
      // The two seeded items survive into the finalized plan alongside
      // whatever the (skipped-batch-0-aware) remaining batches contributed —
      // read from plan.json rather than the tests table, since the fake
      // GENERATE mode here (makeInterruptibleMode) ignores the plan content
      // and always writes its own fixed CANNED_SPECS regardless.
      const finalizedPlan = JSON.parse(
        await readFile(join(runDir, 'plan', 'plan.json'), 'utf-8'),
      ) as TestPlan;
      const titles = finalizedPlan.items.map((it) => it.title);
      expect(titles).toContain('Seeded item 1');
      expect(titles).toContain('Seeded item 2');
      expect(finalizedPlan.items.length).toBeGreaterThan(2);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('BUDGET CEILING: maxCostUsd pauses (budget-exceeded) once GENERATE spend crosses it, stopping before the next batch', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Budget Ceiling Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const rawWithCost = (costUSD: number) => ({
      modelUsage: { 'fake-model': { inputTokens: 10, outputTokens: 10, costUSD } },
    });

    let generateBatchCalls = 0;
    const mode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(ctx: TestModeContext): Promise<GeneratedSpec[]> {
        const specs: GeneratedSpec[] = [];
        for (const s of CANNED_SPECS) {
          if (ctx.signal?.aborted) break;
          generateBatchCalls += 1;
          ctx.onUsage?.('generate', `batch ${generateBatchCalls}`, 'claude', rawWithCost(6));
          const abs = join(ctx.projectDir, s.path);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, s.contents, 'utf-8');
          specs.push({ ...s, path: abs });
        }
        return specs;
      },
      async execute(_ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
        const results = specs.map((s) => ({ title: s.title, status: 'passed' as const, durationMs: 5 }));
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
      maxCostUsd: 5, // below a single batch's $6 — trips after the first, before a second dispatches
    });

    expect(summary.status).toBe('paused');
    expect(store.getRun(summary.runId)?.pauseReason).toBe('budget-exceeded');
    // CANNED_SPECS has 2 items — only the first ran before the ceiling stopped the loop.
    expect(generateBatchCalls).toBe(1);

    // The partial spec never got baked into an 'execute'-phase checkpoint —
    // resume must still call mode.generate() again, not skip straight to EXECUTE.
    const runDir = join(projectsDir(), project.id, 'runs', summary.runId);
    const checkpoint = await readCheckpoint(runDir);
    expect(checkpoint?.phase).toBe('generate');
  });

  it('BUDGET CEILING resume: prior spend is seeded from stored usage, not reset to zero, on resume', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Budget Ceiling Resume Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const rawWithCost = (costUSD: number) => ({
      modelUsage: { 'fake-model': { inputTokens: 10, outputTokens: 10, costUSD } },
    });

    // Phase 1: a real run that reports $8 of GENERATE spend (under the $10
    // ceiling, so the budget ceiling itself never fires here) then pauses
    // manually right after — purely to leave a genuine phase:'generate'
    // checkpoint plus one real, persisted usage row behind.
    const pauseController = new AbortController();
    const firstMode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(ctx: TestModeContext): Promise<GeneratedSpec[]> {
        ctx.onUsage?.('generate', 'batch 1', 'claude', rawWithCost(8));
        const s = CANNED_SPECS[0]!;
        const abs = join(ctx.projectDir, s.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, s.contents, 'utf-8');
        pauseController.abort('pause');
        return [{ ...s, path: abs }];
      },
      async execute(): Promise<ExecOutcome> {
        throw new Error('must not reach EXECUTE in phase 1');
      },
      async collectArtifacts(): Promise<{ dir: string; files: string[] }> {
        return { dir: 'artifacts', files: [] };
      },
      async export(): Promise<SuiteBundle> {
        return { dir: 'export', files: [] };
      },
    };

    const firstOrchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => firstMode,
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const paused = await firstOrchestrator.run({
      projectId: project.id,
      autoApprove: true,
      maxCostUsd: 10,
      signal: pauseController.signal,
    });
    expect(paused.status).toBe('paused');
    expect(store.getRun(paused.runId)?.pauseReason).toBe('manual');
    // PLAN's own completion call also records a (cost-less, since CANNED_PLAN
    // carries no modelUsage) usage row — only the GENERATE row contributes cost.
    const seededUsage = store.listUsageForRun(paused.runId);
    const seededCost = seededUsage.reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
    expect(seededCost).toBe(8);

    // Phase 2: resume. The SAME $10 ceiling (round-tripped via the
    // checkpoint) is still configured. This mode reports just $5 more —
    // under $10 on its own, but $8 (seeded) + $5 = $13 crosses it. If the
    // seed were dropped on resume, this would wrongly proceed to EXECUTE.
    let resumeGenerateCalls = 0;
    const resumeMode: TestMode = {
      id: 'playwright',
      async scaffold(): Promise<void> {},
      async generate(ctx: TestModeContext): Promise<GeneratedSpec[]> {
        resumeGenerateCalls += 1;
        ctx.onUsage?.('generate', 'batch 2', 'claude', rawWithCost(5));
        const s = CANNED_SPECS[1]!;
        const abs = join(ctx.projectDir, s.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, s.contents, 'utf-8');
        return [{ ...s, path: abs }];
      },
      async execute(): Promise<ExecOutcome> {
        throw new Error('must not reach EXECUTE: the seeded + new spend should have crossed the ceiling');
      },
      async collectArtifacts(): Promise<{ dir: string; files: string[] }> {
        return { dir: 'artifacts', files: [] };
      },
      async export(): Promise<SuiteBundle> {
        return { dir: 'export', files: [] };
      },
    };

    const resumeOrchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => resumeMode,
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await resumeOrchestrator.resume(paused.runId);

    expect(resumeGenerateCalls).toBe(1);
    expect(summary.status).toBe('paused');
    expect(store.getRun(summary.runId)?.pauseReason).toBe('budget-exceeded');
    const totalUsage = store.listUsageForRun(summary.runId).reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
    expect(totalUsage).toBe(13);
  });
});
