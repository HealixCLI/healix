import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOrchestrator } from './index.js';
import type { OrchestratorEvent } from './types.js';
import type { RunReport } from './report.js';
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
 * Exercises the coverage feedback loop's real dropped-item recovery
 * iteration end-to-end (offline DI seam, same pattern as
 * orchestrator.paths.test.ts) — a real tmp repo with two Express endpoints,
 * so `indexSource` genuinely detects two functionality units
 * (`endpoint:GET /api/x`, `endpoint:GET /api/y`), a plan that includes BOTH
 * items up front, and a fake generate() that deliberately drops ITEM_B on
 * its first attempt (simulating a real generation failure) but succeeds on
 * any later attempt — real, not stubbed, evidence of whether the loop
 * recovers a dropped item via regeneration WITHOUT re-planning (the
 * pre-KB-redesign loop used to discover ITEM_B via a second AI plan call;
 * the redesigned loop can only recover items the initial plan already
 * included, never plan brand-new ones — see
 * docs/design/retry-pass-coverage-kb-redesign.md §4).
 */

function fencedPlan(plan: { summary: string; items: unknown[] }): string {
  return ['```json', JSON.stringify(plan), '```'].join('\n');
}

const ITEM_A = {
  title: 'GET /api/x',
  reqTag: 'REQ-X',
  tier: 'tierC-api',
  intent: 'Endpoint x responds.',
  unitKey: 'endpoint:GET /api/x',
};
const ITEM_B = {
  title: 'GET /api/y',
  reqTag: 'REQ-Y',
  tier: 'tierC-api',
  intent: 'Endpoint y responds.',
  unitKey: 'endpoint:GET /api/y',
};

/** Always returns BOTH items on every plan-mode call — the redesigned loop never issues a second one, so `planCallCount` staying at 1 is itself proof no re-planning happened. */
function makeFakeProvider(planCallCount: { n: number }): ProviderAdapter {
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
      const text = fencedPlan({ summary: 'fake', items: [ITEM_A, ITEM_B] });
      return { provider: 'claude', ok: true, plan: text, raw: {}, detail: 'OK' };
    },
    async complete(_prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
      if (opts?.mode === 'plan') {
        planCallCount.n += 1;
        return {
          provider: 'claude',
          ok: true,
          text: fencedPlan({ summary: 'fake', items: [ITEM_A, ITEM_B] }),
          raw: {},
          detail: 'OK',
        };
      }
      return { provider: 'claude', ok: true, text: 'not used', raw: {}, detail: 'OK' };
    },
  };
}

/**
 * generate() drops ITEM_B (REQ-Y) on its very first invocation across the
 * whole run — simulating a real generation failure — and accepts it on any
 * later call (the coverage-loop's recovery iteration, or Retry-pass). Calls
 * ctx.onKbItemOutcome itself for both the accepted and dropped items, since
 * this fake bypasses real generate.ts's recordGenOutcome entirely — the
 * orchestrator's KB status tracking depends on that callback firing.
 */
function makeFakeMode(genAttempts: { n: number }): TestMode {
  return {
    id: 'playwright',
    async scaffold(_ctx: TestModeContext): Promise<void> {},
    async generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
      genAttempts.n += 1;
      const specs: GeneratedSpec[] = [];
      for (const item of plan.items) {
        if (item.reqTag === 'REQ-Y' && genAttempts.n === 1) {
          ctx.onKbItemOutcome?.(item.id, 'dropped');
          continue;
        }
        specs.push({
          path: `/fake/${item.reqTag}.spec.ts`,
          title: item.title,
          reqTag: item.reqTag,
          tier: item.tier,
          contents: '// fake spec',
        });
        ctx.onKbItemOutcome?.(item.id, 'generated');
      }
      return specs;
    },
    async execute(_ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
      const results = specs.map((s) => ({
        title: `[REQ:${s.reqTag}] scenario passes`,
        status: 'passed' as const,
        durationMs: 1,
      }));
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

function makeFakeTarget(): TargetAdapter {
  return {
    async detect(_repoPath: string): Promise<DetectedProject> {
      return {
        kind: 'backend',
        framework: 'express',
        packageManager: 'npm',
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
}

const fakeBrowser: BrowserSurface = {
  async start(_opts: BrowserSurfaceOptions): Promise<void> {},
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
let repoPath: string;
const prevDataDir = process.env.HEALIX_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-coverage-loop-'));
  process.env.HEALIX_DATA_DIR = dataDir;
  resetStoreForTests();

  repoPath = mkdtempSync(join(tmpdir(), 'healix-coverage-loop-repo-'));
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
  writeFileSync(
    join(repoPath, 'routes.js'),
    `
      const express = require('express');
      const app = express();
      app.get('/api/x', (req, res) => res.send('ok'));
      app.get('/api/y', (req, res) => res.send('ok'));
    `,
  );
});

afterEach(() => {
  resetStoreForTests();
  if (prevDataDir === undefined) {
    delete process.env.HEALIX_DATA_DIR;
  } else {
    process.env.HEALIX_DATA_DIR = prevDataDir;
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

describe('coverage feedback loop opt-in (offline DI seam, real functionality detection)', () => {
  it('LOOP OFF (default): coverage is measured once but the loop never retries', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({ name: 'Coverage Loop Off', mode: 'playwright', repoPath });

    const planCallCount = { n: 0 };
    const genAttempts = { n: 0 };
    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      provider: makeFakeProvider(planCallCount),
      getMode: () => makeFakeMode(genAttempts),
      makeTarget: () => makeFakeTarget(),
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: true }, // coverageLoopEnabled omitted — defaults to off
      { onEvent: (e) => events.push(e) },
    );

    // One plan call (both items planned up front) and one generate call
    // (ITEM_B dropped on it, never retried since the loop is off).
    expect(planCallCount.n).toBe(1);
    expect(genAttempts.n).toBe(1);
    expect(events.some((e) => e.message.includes('Coverage loop is off'))).toBe(true);
    expect(events.some((e) => e.message.toLowerCase().includes('recovering dropped'))).toBe(false);

    const report = JSON.parse(await readFile(summary.reportPath as string, 'utf8')) as RunReport;
    // Coverage was still measured (not skipped) — only unit A is covered.
    expect(report.coverage).not.toBeNull();
    expect(report.coverage?.totalCount).toBe(2);
    expect(report.coverage?.coveredCount).toBe(1);
    expect(report.coverage?.ratio).toBeCloseTo(0.5);
  });

  it('LOOP ON: recovers the dropped item via regeneration, with zero re-planning', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({ name: 'Coverage Loop On', mode: 'playwright', repoPath });

    const planCallCount = { n: 0 };
    const genAttempts = { n: 0 };
    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      provider: makeFakeProvider(planCallCount),
      getMode: () => makeFakeMode(genAttempts),
      makeTarget: () => makeFakeTarget(),
      makeBrowser: () => fakeBrowser,
    });

    const summary = await orchestrator.run(
      { projectId: project.id, autoApprove: true, coverageLoopEnabled: true },
      { onEvent: (e) => events.push(e) },
    );

    // Exactly one plan call, ever — the redesigned loop never calls
    // provider.complete(mode: 'plan') again, unlike the old gap-fill
    // mechanism. Two generate() calls: the initial pass (drops ITEM_B) and
    // the loop's one recovery iteration (regenerates it successfully).
    expect(planCallCount.n).toBe(1);
    expect(genAttempts.n).toBe(2);
    expect(events.some((e) => e.message.toLowerCase().includes('recovering dropped'))).toBe(true);
    expect(
      events.some((e) => e.message.toLowerCase().includes('regenerating') && e.message.includes('dropped')),
    ).toBe(true);
    expect(events.some((e) => e.message.toLowerCase().includes('gap-fill'))).toBe(false);

    const report = JSON.parse(await readFile(summary.reportPath as string, 'utf8')) as RunReport;
    expect(report.coverage).not.toBeNull();
    expect(report.coverage?.totalCount).toBe(2);
    expect(report.coverage?.coveredCount).toBe(2);
    expect(report.coverage?.ratio).toBeCloseTo(1);
  });

  it('coverageLoopEnabled/coverageTarget survive a pause/resume round-trip via the checkpoint', async () => {
    // Direct plumbing check on the new checkpoint fields — the actual pause/
    // resume mechanics (network/credits classification, etc.) are already
    // covered by orchestrator.resume.test.ts; this only proves the two new
    // RunOptions fields round-trip through ResumeCheckpoint.runOptions.
    const { writeCheckpoint, readCheckpoint } = await import('./checkpoint.js');
    const runDir = mkdtempSync(join(tmpdir(), 'healix-coverage-loop-checkpoint-'));
    try {
      await writeCheckpoint(runDir, {
        runId: 'run_test',
        projectId: 'prj_test',
        phase: 'generate',
        runOptions: { coverageLoopEnabled: true, coverageTarget: 0.9 },
        plan: { summary: 'x', items: [] },
        generatedItemIds: [],
        generatedSpecs: [],
        executeComplete: false,
        updatedAt: new Date().toISOString(),
      });
      const checkpoint = await readCheckpoint(runDir);
      expect(checkpoint?.runOptions.coverageLoopEnabled).toBe(true);
      expect(checkpoint?.runOptions.coverageTarget).toBe(0.9);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
