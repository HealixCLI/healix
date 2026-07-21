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
    // The plan phase asks with mode:'plan'; return the canned plan there. Any
    // other completion (e.g. triage analyze) returns inert canned text so the
    // deterministic triage baseline is used.
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

const CANNED_OUTCOME: ExecOutcome = {
  passed: 1,
  failed: 1,
  blocked: 0,
  flaky: 0,
  results: [
    { title: 'Home loads', status: 'passed', durationMs: 12 },
    {
      title: 'Login works',
      status: 'failed',
      durationMs: 34,
      error: 'Error: expected dashboard heading but saw login form',
      artifacts: ['test-results/login/failure.png'],
    },
  ],
};

/** TestMode whose every phase returns canned, side-effect-free data. */
// Tier-aware: the orchestrator invokes execute() once per in-scope tier
// rather than once for the whole suite, so a result whose title matches one
// of THIS call's specs belongs to this tier; anything matching no generated
// spec at all is delivered once, on the first call, so it isn't dropped.
let fakeModeExecuteCallCount = 0;
const fakeModeAllGeneratedTitles = new Set(CANNED_SPECS.map((s) => s.title));
const fakeMode: TestMode = {
  id: 'playwright',
  async scaffold(_ctx: TestModeContext): Promise<void> {
    /* noop */
  },
  async generate(_ctx: TestModeContext, _plan: TestPlan): Promise<GeneratedSpec[]> {
    return CANNED_SPECS.map((s) => ({ ...s }));
  },
  async execute(_ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
    fakeModeExecuteCallCount += 1;
    const specTitles = new Set(specs.map((s) => s.title));
    const results = CANNED_OUTCOME.results
      .filter(
        (r) =>
          specTitles.has(r.title) ||
          (fakeModeExecuteCallCount === 1 && !fakeModeAllGeneratedTitles.has(r.title)),
      )
      .map((r) => ({ ...r }));
    return {
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      blocked: results.filter((r) => r.status === 'blocked').length,
      flaky: results.filter((r) => r.status === 'flaky').length,
      results,
    };
  },
  async collectArtifacts(_ctx: TestModeContext): Promise<{ dir: string; files: string[] }> {
    return { dir: 'artifacts', files: ['test-results/x.png'] };
  },
  async export(_ctx: TestModeContext): Promise<SuiteBundle> {
    return { dir: 'export', files: ['playwright.config.ts'] };
  },
};

/** TargetAdapter stub: nothing real launches or probes. */
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

/** BrowserSurface stub: every action resolves immediately; nothing is driven. */
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
  // Hermetic per-test data dir; resetStoreForTests() forces getStore() to
  // re-open against this fresh HEALIX_DATA_DIR.
  dataDir = mkdtempSync(join(tmpdir(), 'healix-orch-'));
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

describe('orchestrator integration (offline DI seam)', () => {
  it('drives a full run to a failed summary, persists rows, and writes a report', async () => {
    const store = (await getStore()) as HealixStore;
    expect(store).not.toBeNull();

    const project = store.createProject({
      name: 'Integration Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      provider: fakeProvider,
      getMode: () => fakeMode,
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: true },
      { onEvent: (e) => events.push(e) },
    );

    // ---- RunSummary: failed (1 failed result) ----
    expect(summary.status).toBe('failed');
    expect(summary.runId).toMatch(/^run_/);
    expect(summary.outcome?.passed).toBe(1);
    expect(summary.outcome?.failed).toBe(1);
    expect(summary.reportPath).toBeDefined();

    // ---- persisted run ----
    const run = store.getRun(summary.runId);
    expect(run).not.toBeNull();
    expect(run?.status).toBe('failed');
    expect(run?.finishedAt).toBeTruthy();

    // ---- persisted tests: exactly 2, no duplicate rows ----
    const tests = store.listTests(summary.runId);
    expect(tests).toHaveLength(2);
    const titles = tests.map((t) => t.title).sort();
    expect(titles).toEqual(['Home loads', 'Login works']);
    // No duplicate test rows (one per canned spec).
    expect(new Set(tests.map((t) => t.id)).size).toBe(2);

    // ---- events emitted to the hook ----
    expect(events.length).toBeGreaterThan(0);
    const phases = new Set(events.map((e) => String(e.phase)));
    expect(phases.has('plan')).toBe(true);
    expect(phases.has('generate')).toBe(true);
    expect(phases.has('execute')).toBe(true);
    expect(phases.has('done')).toBe(true);

    // ---- report.json under reports/ ----
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

    // The report carries the collected artifact list.
    expect(report.artifacts).toEqual(['test-results/x.png']);

    // ...and a triage entry for the single failure.
    expect(report.triage).toHaveLength(1);
    expect(report.triage[0]?.title).toBe('Login works');
    expect(report.triage[0]?.error).toContain('dashboard heading');
    expect(report.triage[0]?.triage.verdict).toBeTruthy();
    expect(typeof report.triage[0]?.triage.confidence).toBe('number');

    // The report is written during the REPORT phase, so its embedded run status
    // is 'reporting' (the terminal 'failed' status is set afterwards). The
    // failure itself is reflected in the embedded outcome.
    expect(report.run.status).toBe('reporting');
    expect(report.outcome?.failed).toBe(1);
  });

  it('createOrchestrator() with no overrides is the same factory shape', () => {
    // No-arg construction must not throw; behavior parity is exercised elsewhere.
    const orchestrator = createOrchestrator();
    expect(typeof orchestrator.run).toBe('function');
  });
});
