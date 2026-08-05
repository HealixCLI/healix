/**
 * Integration coverage for the TRIAGE phase's KB-evidence wiring (see
 * triage/evidence.ts) — confirms the actual prompt sent to the provider for
 * a real failing test, executed through the orchestrator, contains the four
 * new evidence sections (requirement/mockEvidence/executionEvidence/
 * explorationContext), sourced from the durable KB tables rather than a
 * live in-memory ExecOutcome.
 *
 * Exercised via Retry-pass's own fresh-triage step (§7a, orchestrator.retryPass)
 * rather than the inline TRIAGE phase, because it gives a stable point to seed
 * KB rows against a KNOWN testId before the failing execution runs — but both
 * call sites share the same triage/evidence.ts builder (see index.ts), so this
 * is also the acceptance criterion that the two call sites are equivalent in
 * richness.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const CRASH_ITEMS = [
  { title: 'Login works', reqTag: 'REQ-LOGIN', tier: 'tierA-public', intent: 'Login flow.' },
];
// A reqTag-less item: PLAN's own KB-foundation wiring only seeds a
// `requirements` row when an item has a reqTag (see index.ts's
// `if (item.reqTag) { store.seedRequirement(...) }`), so this is the one
// that genuinely leaves ALL four evidence sources absent for the "omits
// everything" test below — a reqTag'd item would get a requirement row
// seeded by PLAN regardless of anything this story's own wiring does.
const NO_REQTAG_ITEMS = [{ title: 'Home loads', tier: 'tierA-public', intent: 'Landing renders.' }];

/** Provider that captures every triage-tagged provider.complete() prompt (see engine.analyze's `taskType: 'triage'`). */
function makeCapturingProvider(
  triagePrompts: string[],
  items: readonly unknown[] = CRASH_ITEMS,
): ProviderAdapter {
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
    async complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
      if (opts?.mode === 'plan') {
        return { provider: 'claude', ok: true, text: fenced, raw: plan, detail: 'OK' };
      }
      if (opts?.taskType === 'triage') {
        triagePrompts.push(prompt);
      }
      // No fenced verdict JSON — analyze() falls back to the deterministic
      // rule baseline, which is fine: this test only inspects the PROMPT
      // that was actually sent, not the resulting verdict.
      return { provider: 'claude', ok: true, text: 'not used', raw: null, detail: 'OK' };
    },
  };
}

/** execute() that always throws — leaves a real, KNOWN testId at 'pending' status for the next retry-pass to target (same pattern as orchestrator.retry-pass.test.ts's makeCrashingFakeMode). */
function makeCrashingMode(): TestMode {
  return {
    id: 'playwright',
    async scaffold(): Promise<void> {},
    async generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
      return plan.items.map((item) => {
        ctx.onKbItemOutcome?.(item.id, 'generated');
        return {
          path: `/fake/${item.id}.spec.ts`,
          title: item.title,
          reqTag: item.reqTag,
          tier: item.tier,
          contents: `// spec for ${item.title}\ntest('logs in');\n`,
          planItemId: item.id,
        };
      });
    },
    async execute(): Promise<ExecOutcome> {
      throw new Error('simulated crash executing the suite');
    },
    async collectArtifacts(): Promise<{ dir: string; files: string[] }> {
      return { dir: 'artifacts', files: [] };
    },
    async export(): Promise<SuiteBundle> {
      return { dir: 'export', files: [] };
    },
  };
}

/** execute() that fails the given spec with an error mentioning the exploration route, so buildExplorationContext's best-effort match finds it. */
function makeFailingMode(): TestMode {
  return {
    id: 'playwright',
    async scaffold(): Promise<void> {},
    async generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
      return plan.items.map((item) => {
        ctx.onKbItemOutcome?.(item.id, 'generated');
        return {
          path: `/fake/${item.id}.spec.ts`,
          title: item.title,
          reqTag: item.reqTag,
          tier: item.tier,
          contents: `// spec for ${item.title}\ntest('logs in');\n`,
          planItemId: item.id,
        };
      });
    },
    async execute(_ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
      const results = specs.map((s) => ({
        title: s.title,
        status: 'failed' as const,
        durationMs: 5,
        error: "Timeout waiting for selector after navigating to '/login'",
      }));
      return { passed: 0, failed: results.length, blocked: 0, flaky: 0, results };
    },
    async collectArtifacts(): Promise<{ dir: string; files: string[] }> {
      return { dir: 'artifacts', files: [] };
    },
    async export(): Promise<SuiteBundle> {
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
  dataDir = mkdtempSync(join(tmpdir(), 'healix-orch-triage-kb-evidence-'));
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

describe("Retry-pass's fresh-triage step (§7a) reads TriageInput's KB evidence from the durable store", () => {
  it('sends a triage prompt containing all four KB evidence sections when every source has data for the failing test', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Triage KB Evidence Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    // ---- Run 1: crashes mid-EXECUTE, leaving one real, KNOWN 'pending' test row. ----
    const run1 = await createOrchestrator({
      provider: makeCapturingProvider([]),
      getMode: () => makeCrashingMode(),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('error');

    const pendingTests = store.listTests(run1.runId);
    expect(pendingTests).toHaveLength(1);
    const testId = pendingTests[0].id;
    expect(pendingTests[0].reqTag).toBe('REQ-LOGIN');
    // PLAN already seeds `requirements` for every reqTag'd item (existing
    // wiring, unrelated to this story) — description defaults to the plan
    // item's own intent, asserted below rather than re-seeded here.

    // ---- Seed the remaining KB sources this story's evidence builder reads ----
    // ---- from, keyed to the now-known testId (simulating the sibling ----
    // ---- "DB-foundation write points" story's output for these tables). ----
    const mockId = store.upsertMockResponse({
      runId: run1.runId,
      dependencyId: 'dep_auth',
      category: 'auth',
      method: 'POST',
      pathPattern: '/api/login',
      mockStrategy: 'route-intercept',
      mockStatus: 200,
      mockBodyJson: JSON.stringify({ token: 'abc123' }),
      mockHeadersJson: null,
    });
    store.recordMockUsage(testId, mockId, 2);
    store.insertExplorationSummary({
      runId: run1.runId,
      route: '/login',
      selectorsJson: JSON.stringify([{ selector: '#email' }, { selector: '#password' }]),
      formsJson: null,
      authPattern: 'password-form',
      stateProbeCount: null,
    });

    // ---- Retry-pass: re-executes the pending test (no regeneration needed), and it fails. ----
    const triagePrompts: string[] = [];
    const summary = await createOrchestrator({
      provider: makeCapturingProvider(triagePrompts),
      getMode: () => makeFailingMode(),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).retryPass(run1.runId);

    expect(summary.runId).toBe(run1.runId);
    expect(triagePrompts).toHaveLength(1);
    const prompt = triagePrompts[0];

    // Requirement context (from `requirements`, matched by reqTag; PLAN
    // already seeds this row with the item's own intent as description).
    expect(prompt).toContain('--- TRACED REQUIREMENT ---');
    expect(prompt).toContain('Tag: REQ-LOGIN');
    expect(prompt).toContain('Description: Login flow.');

    // Mock evidence (from `mock_responses` joined through `test_mock_usage`), full and untruncated.
    expect(prompt).toContain(
      '--- MOCK/OBSERVED RESPONSES (from mock_responses + test_mock_usage; untrusted) ---',
    );
    expect(prompt).toContain('auth POST /api/login');
    expect(prompt).toContain('mockStatus: 200');
    expect(prompt).toContain(JSON.stringify({ token: 'abc123' }));

    // Exploration context (from `exploration_summaries`, best-effort route match against the error text).
    expect(prompt).toContain('--- EXPLORATION CONTEXT (exploration_summaries; untrusted) ---');
    expect(prompt).toContain('route: /login');
    expect(prompt).toContain('authPattern: password-form');

    // Every newly-included app-derived block sits inside the SAME untrusted fence as the legacy error block.
    const OPEN = '<<<UNTRUSTED_TEST_OUTPUT';
    const CLOSE = 'UNTRUSTED_TEST_OUTPUT>>>';
    for (const needle of ['mockStatus: 200', 'route: /login']) {
      const idx = prompt.indexOf(needle);
      expect(idx).toBeGreaterThan(-1);
      const openIdx = prompt.lastIndexOf(OPEN, idx);
      const closeIdx = prompt.indexOf(CLOSE, openIdx);
      expect(openIdx).toBeGreaterThan(-1);
      expect(idx).toBeLessThan(closeIdx);
    }
  });

  it('omits all four KB evidence sections when none of their sources have data for the failing test', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({
      name: 'Triage KB Evidence Absent Demo',
      mode: 'playwright',
      baseUrl: 'https://app.example.test',
    });

    const run1 = await createOrchestrator({
      provider: makeCapturingProvider([], NO_REQTAG_ITEMS),
      getMode: () => makeCrashingMode(),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).run({ projectId: project.id, autoApprove: true });
    expect(run1.status).toBe('error');
    expect(store.listTests(run1.runId)).toHaveLength(1);
    // Confirms PLAN's own requirement-seeding genuinely didn't fire here (a
    // reqTag'd item would always get one — see NO_REQTAG_ITEMS' doc comment).
    expect(store.listRequirements(run1.runId)).toHaveLength(0);

    // No mock_responses/test_mock_usage/exploration_summaries seeded at all.
    const triagePrompts: string[] = [];
    await createOrchestrator({
      provider: makeCapturingProvider(triagePrompts, NO_REQTAG_ITEMS),
      getMode: () => makeFailingMode(),
      makeTarget: () => fakeTarget,
      makeBrowser: () => fakeBrowser,
    }).retryPass(run1.runId);

    expect(triagePrompts).toHaveLength(1);
    const prompt = triagePrompts[0];
    expect(prompt).not.toContain('--- TRACED REQUIREMENT ---');
    expect(prompt).not.toContain('MOCK/OBSERVED RESPONSES');
    expect(prompt).not.toContain('PERSISTED EXECUTION EVIDENCE');
    expect(prompt).not.toContain('EXPLORATION CONTEXT');
    // The legacy error block is still present — KB absence degrades gracefully, it never breaks the existing prompt.
    expect(prompt).toContain('--- ERROR / STACK (untrusted) ---');
  });
});
