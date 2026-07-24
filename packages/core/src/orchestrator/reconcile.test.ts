/**
 * Unit tests for reconcileRuns() — the store-facing half of what used to be
 * only the desktop app's boot-time reconciliation (see apps/desktop/src/main
 * /index.ts's reconcileRunsOnBoot, now a thin wrapper over this). Verifies
 * the three cases it must distinguish: already-paused, in-flight-with-a-
 * checkpoint, and in-flight-with-none — plus that the age-buffered orphan
 * janitor still runs as a fallback net.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getStore, resetStoreForTests, type HealixStore } from '../storage/store.js';
import { projectsDir } from '../env/app-data.js';
import { writeCheckpoint, type ResumeCheckpoint } from './checkpoint.js';
import { reconcileRuns } from './reconcile.js';

let dataDir: string;
const prevDataDir = process.env.HEALIX_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-reconcile-'));
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

function minimalCheckpoint(runId: string, projectId: string): ResumeCheckpoint {
  return {
    runId,
    projectId,
    phase: 'generate',
    runOptions: {},
    plan: { summary: '', items: [] },
    generatedItemIds: [],
    generatedSpecs: [],
    executeComplete: false,
    updatedAt: new Date().toISOString(),
  };
}

async function seedCheckpoint(projectId: string, runId: string): Promise<void> {
  const runDir = join(projectsDir(), projectId, 'runs', runId);
  await mkdir(runDir, { recursive: true });
  await writeCheckpoint(runDir, minimalCheckpoint(runId, projectId));
}

describe('reconcileRuns', () => {
  it('includes already-paused (non-manual) runs in toResume, untouched', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({ name: 'P1', mode: 'playwright', baseUrl: 'https://a.test' });
    const run = store.createRun(project.id, {});
    store.updateRunStatus(run.id, 'paused', { pauseReason: 'network' });

    const result = await reconcileRuns(store);
    expect(result.toResume.map((r) => r.id)).toContain(run.id);
    expect(result.markedError).toBe(0);
    expect(store.getRun(run.id)?.pauseReason).toBe('network');
  });

  it('excludes a budget-exceeded pause from auto-resume, same as manual — both need a human decision', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({ name: 'P1b', mode: 'playwright', baseUrl: 'https://a.test' });
    const manualRun = store.createRun(project.id, {});
    store.updateRunStatus(manualRun.id, 'paused', { pauseReason: 'manual' });
    const budgetRun = store.createRun(project.id, {});
    store.updateRunStatus(budgetRun.id, 'paused', { pauseReason: 'budget-exceeded' });

    const result = await reconcileRuns(store);
    expect(result.toResume.map((r) => r.id)).not.toContain(manualRun.id);
    expect(result.toResume.map((r) => r.id)).not.toContain(budgetRun.id);
    // Untouched — reconcile must not silently reclassify either pause reason.
    expect(store.getRun(manualRun.id)?.pauseReason).toBe('manual');
    expect(store.getRun(budgetRun.id)?.pauseReason).toBe('budget-exceeded');
  });

  it('reclassifies an in-flight run WITH a checkpoint as paused/crashed and returns it for resume', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({ name: 'P2', mode: 'playwright', baseUrl: 'https://a.test' });
    const run = store.createRun(project.id, {});
    store.updateRunStatus(run.id, 'generating'); // in-flight (non-terminal, non-paused)
    await seedCheckpoint(project.id, run.id);

    const result = await reconcileRuns(store);
    expect(result.toResume.map((r) => r.id)).toContain(run.id);
    expect(result.markedError).toBe(0);
    const stored = store.getRun(run.id);
    expect(stored?.status).toBe('paused');
    expect(stored?.pauseReason).toBe('crashed');
  });

  it('marks an in-flight run WITHOUT a checkpoint as error — nothing to resume from', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({ name: 'P3', mode: 'playwright', baseUrl: 'https://a.test' });
    const run = store.createRun(project.id, {});
    store.updateRunStatus(run.id, 'planning'); // in-flight, no checkpoint ever written

    const result = await reconcileRuns(store);
    expect(result.toResume.map((r) => r.id)).not.toContain(run.id);
    expect(result.markedError).toBe(1);
    expect(store.getRun(run.id)?.status).toBe('error');
    const events = store.listEvents(run.id);
    expect(events.some((e) => e.level === 'error' && e.message.includes('nothing to resume from'))).toBe(
      true,
    );
  });

  it('runs the age-buffered orphan janitor as a fallback and reports how many it reaped', async () => {
    const store = (await getStore()) as HealixStore;
    const project = store.createProject({ name: 'P4', mode: 'playwright', baseUrl: 'https://a.test' });
    const run = store.createRun(project.id, {});
    store.updateRunStatus(run.id, 'generating');
    await seedCheckpoint(project.id, run.id); // reconciled via the checkpoint path, not the janitor

    const otherProject = store.createProject({ name: 'P5', mode: 'playwright', baseUrl: 'https://b.test' });
    const stale = store.createRun(otherProject.id, {});
    store.updateRunStatus(stale.id, 'executing');

    const result = await reconcileRuns(store);
    // The checkpointed run is claimed by the main pass, not the janitor —
    // olderThanMs defaults to 6h so `stale` (created just now) isn't reaped
    // either; this just asserts the janitor ran without throwing and its
    // count is well-formed, not a specific reap count (that's failOrphanedRuns'
    // own concern, already covered by its own tests).
    expect(result.orphansReaped).toBeGreaterThanOrEqual(0);
    expect(store.getRun(run.id)?.status).toBe('paused');
  });
});
