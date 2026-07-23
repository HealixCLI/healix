import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dbInfo } from './db.js';
import { type HealixStore, getStore, resetStoreForTests } from './store.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-usage-store-test-'));
  process.env.HEALIX_DATA_DIR = dataDir;
  resetStoreForTests();
});

afterEach(() => {
  resetStoreForTests();
  delete process.env.HEALIX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

async function store(): Promise<HealixStore> {
  const s = await getStore();
  expect(s, 'getStore() returned null — node:sqlite unavailable in this runtime').not.toBeNull();
  return s as HealixStore;
}

describe('HealixStore usage tracking', () => {
  it('creates the usage table on first open', async () => {
    await store();
    const info = await dbInfo();
    expect(info.tables).toContain('usage');
  });

  it('records and lists usage rows for a run, in insertion order', async () => {
    const s = await store();
    const project = s.createProject({ name: 'usage-project', baseUrl: 'https://usage.test' });
    const run = s.createRun(project.id);

    s.recordUsage({
      runId: run.id,
      phase: 'plan',
      task: 'initial',
      provider: 'claude',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
    });
    s.recordUsage({
      runId: run.id,
      phase: 'generate',
      task: 'Widget list',
      provider: 'claude',
      inputTokens: 200,
      outputTokens: 40,
      costUsd: 0.02,
    });
    // A timed-out/aborted call with no usage should still be recordable, with null token/cost fields.
    s.recordUsage({ runId: run.id, phase: 'triage', task: 'flaky test', provider: 'openai' });

    const rows = s.listUsageForRun(run.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.phase)).toEqual(['plan', 'generate', 'triage']);
    expect(rows[0]).toMatchObject({
      task: 'initial',
      provider: 'claude',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
    });
    expect(rows[2]).toMatchObject({
      task: 'flaky test',
      provider: 'openai',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });

  it('listUsageForRun returns nothing for a run with no recorded usage', async () => {
    const s = await store();
    const project = s.createProject({ name: 'no-usage-project', baseUrl: 'https://no-usage.test' });
    const run = s.createRun(project.id);
    expect(s.listUsageForRun(run.id)).toEqual([]);
  });

  it('getUsageAggregate sums per-run totals and computes correct per-phase averages across runs', async () => {
    const s = await store();
    const project = s.createProject({ name: 'aggregate-project', baseUrl: 'https://aggregate.test' });
    const runA = s.createRun(project.id);
    const runB = s.createRun(project.id);

    s.recordUsage({
      runId: runA.id,
      phase: 'plan',
      provider: 'claude',
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.1,
    });
    s.recordUsage({
      runId: runA.id,
      phase: 'generate',
      provider: 'claude',
      inputTokens: 300,
      outputTokens: 30,
      costUsd: 0.3,
    });
    s.recordUsage({
      runId: runB.id,
      phase: 'plan',
      provider: 'claude',
      inputTokens: 200,
      outputTokens: 20,
      costUsd: 0.2,
    });

    const agg = s.getUsageAggregate({ projectId: project.id });

    // Per-run: runA totals 400/40/0.4, runB totals 200/20/0.2 — newest (runB) first.
    expect(agg.perRun).toHaveLength(2);
    const [first, second] = agg.perRun;
    expect(first.runId).toBe(runB.id);
    expect(first.inputTokens).toBe(200);
    expect(first.outputTokens).toBe(20);
    expect(first.costUsd).toBeCloseTo(0.2);
    expect(second.runId).toBe(runA.id);
    expect(second.inputTokens).toBe(400);
    expect(second.outputTokens).toBe(40);
    expect(second.costUsd).toBeCloseTo(0.4);

    // Per-phase: 'plan' has 2 calls (100+200=300 total, avg 150); 'generate' has 1 call (300 total, avg 300).
    const plan = agg.perPhase.find((p) => p.phase === 'plan');
    const generate = agg.perPhase.find((p) => p.phase === 'generate');
    expect(plan).toMatchObject({ callCount: 2, avgInputTokens: 150, totalInputTokens: 300 });
    expect(generate).toMatchObject({ callCount: 1, avgInputTokens: 300, totalInputTokens: 300 });
  });

  it('getUsageAggregate with no projectId scopes across every project', async () => {
    const s = await store();
    const p1 = s.createProject({ name: 'proj-1', baseUrl: 'https://proj1.test' });
    const p2 = s.createProject({ name: 'proj-2', baseUrl: 'https://proj2.test' });
    const run1 = s.createRun(p1.id);
    const run2 = s.createRun(p2.id);
    s.recordUsage({
      runId: run1.id,
      phase: 'plan',
      provider: 'claude',
      inputTokens: 10,
      outputTokens: 1,
      costUsd: 0.01,
    });
    s.recordUsage({
      runId: run2.id,
      phase: 'plan',
      provider: 'claude',
      inputTokens: 20,
      outputTokens: 2,
      costUsd: 0.02,
    });

    const agg = s.getUsageAggregate();
    expect(agg.perRun.map((r) => r.runId).sort()).toEqual([run1.id, run2.id].sort());
    const plan = agg.perPhase.find((p) => p.phase === 'plan');
    expect(plan?.callCount).toBe(2);
  });

  it('deleteRun cascades usage rows, leaving no orphans', async () => {
    const s = await store();
    const project = s.createProject({ name: 'delete-project', baseUrl: 'https://delete.test' });
    const run = s.createRun(project.id);
    s.recordUsage({
      runId: run.id,
      phase: 'plan',
      provider: 'claude',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.001,
    });

    s.deleteRun(run.id);

    expect(s.listUsageForRun(run.id)).toEqual([]);
  });
});
