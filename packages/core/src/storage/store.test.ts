import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Load node:sqlite via createRequire so this also works under bundled test runtimes
// (vite-node) that don't recognise node:sqlite as a builtin via dynamic import.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

import { type HealixStore, dbInfo, dbPath, getStore, resetStoreForTests } from '@healix/core';

/**
 * Hermetic store tests. Each test runs against a throwaway SQLite database under a
 * fresh os.tmpdir() subdir (via HEALIX_DATA_DIR), with the cached store reset before
 * and after so no state leaks between tests. Fully deterministic and offline.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-store-test-'));
  process.env.HEALIX_DATA_DIR = dataDir;
  // Drop any cached store + close any open DB so getStore() re-derives from dataDir.
  resetStoreForTests();
});

afterEach(() => {
  // Reset first so the underlying DB handle is closed before we delete the file.
  resetStoreForTests();
  delete process.env.HEALIX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Acquire the store or fail loudly — every supported runtime (Node >= 22.5) has node:sqlite. */
async function store(): Promise<HealixStore> {
  const s = await getStore();
  expect(s, 'getStore() returned null — node:sqlite unavailable in this runtime').not.toBeNull();
  return s as HealixStore;
}

/**
 * Count rows directly via an independent read-only connection on the same DB file.
 * Lets us assert on tables the store does not surface through its typed API (e.g. results),
 * and confirm there are zero orphan rows after a cascade delete.
 */
async function countRows(table: string): Promise<number> {
  // Ensure the primary store/DB exists (and is migrated) before opening a second handle.
  await store();
  const db = new DatabaseSync(dbPath());
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

describe('HealixStore schema', () => {
  it('creates the expected tables on first open', async () => {
    // Touch the store so the DB is opened + migrated.
    await store();
    const info = await dbInfo();

    expect(info.available).toBe(true);
    expect(info.version).toBeGreaterThanOrEqual(2);
    for (const table of ['projects', 'runs', 'tests', 'results', 'agent_events']) {
      expect(info.tables).toContain(table);
    }
  });
});

describe('deleteProject cascade', () => {
  it('removes all descendant rows without a FOREIGN KEY error and leaves no orphans', async () => {
    const s = await store();

    const project = s.createProject({ name: 'cascade-project' });
    const run = s.createRun(project.id, { provider: null, mode: 'playwright' });

    const N = 3;
    const tests = Array.from({ length: N }, (_, i) =>
      s.insertTest({
        runId: run.id,
        title: `test ${i}`,
        reqTag: `REQ-${i}`,
        tier: 'tierA-public',
        status: 'pending',
      }),
    );
    for (const t of tests) {
      s.insertResult({
        testId: t.id,
        status: 'passed',
        durationMs: 10 + tests.indexOf(t),
        error: null,
        artifactsJson: null,
      });
    }
    for (let i = 0; i < N; i++) {
      s.appendEvent(run.id, 'executing', `event ${i}`, { level: 'info', data: { i } });
    }

    // Sanity: everything we inserted is actually persisted.
    expect(s.listRuns(project.id)).toHaveLength(1);
    expect(s.listTests(run.id)).toHaveLength(N);
    expect(s.listEvents(run.id)).toHaveLength(N);
    expect(await countRows('results')).toBe(N);

    // The regression: deleting the project must not throw (no FK violation / no leftover txn).
    expect(() => s.deleteProject(project.id)).not.toThrow();

    // Project itself is gone.
    expect(s.getProject(project.id)).toBeNull();
    expect(s.getRun(run.id)).toBeNull();

    // Zero orphan rows across every descendant table.
    expect(await countRows('runs')).toBe(0);
    expect(await countRows('tests')).toBe(0);
    expect(await countRows('results')).toBe(0);
    expect(await countRows('agent_events')).toBe(0);
    expect(await countRows('projects')).toBe(0);
  });

  it('leaves a second unrelated project and its children untouched', async () => {
    const s = await store();

    const target = s.createProject({ name: 'to-delete' });
    const keep = s.createProject({ name: 'to-keep' });

    const targetRun = s.createRun(target.id);
    const keepRun = s.createRun(keep.id);

    const N = 2;
    for (let i = 0; i < N; i++) {
      const tt = s.insertTest({
        runId: targetRun.id,
        title: `t${i}`,
        reqTag: null,
        tier: null,
        status: 'pending',
      });
      s.insertResult({ testId: tt.id, status: 'passed', durationMs: null, error: null, artifactsJson: null });
      s.appendEvent(targetRun.id, 'executing', `te${i}`);

      const kt = s.insertTest({
        runId: keepRun.id,
        title: `k${i}`,
        reqTag: null,
        tier: null,
        status: 'pending',
      });
      s.insertResult({ testId: kt.id, status: 'failed', durationMs: 5, error: 'boom', artifactsJson: null });
      s.appendEvent(keepRun.id, 'executing', `ke${i}`);
    }

    expect(() => s.deleteProject(target.id)).not.toThrow();

    // Target is fully gone.
    expect(s.getProject(target.id)).toBeNull();
    expect(s.getRun(targetRun.id)).toBeNull();

    // The unrelated project is fully intact.
    expect(s.getProject(keep.id)).not.toBeNull();
    expect(s.listRuns(keep.id)).toHaveLength(1);
    expect(s.listTests(keepRun.id)).toHaveLength(N);
    expect(s.listEvents(keepRun.id)).toHaveLength(N);

    // Only the kept project's rows remain.
    expect(await countRows('projects')).toBe(1);
    expect(await countRows('runs')).toBe(1);
    expect(await countRows('tests')).toBe(N);
    expect(await countRows('results')).toBe(N);
    expect(await countRows('agent_events')).toBe(N);
  });
});

describe('deleteRun cascade', () => {
  it('removes the run and its descendants without a FOREIGN KEY error and leaves no orphans', async () => {
    const s = await store();

    const project = s.createProject({ name: 'run-cascade' });
    const run = s.createRun(project.id);
    const otherRun = s.createRun(project.id);

    const N = 3;
    for (let i = 0; i < N; i++) {
      const t = s.insertTest({ runId: run.id, title: `t${i}`, reqTag: null, tier: null, status: 'pending' });
      s.insertResult({ testId: t.id, status: 'passed', durationMs: i, error: null, artifactsJson: null });
      s.appendEvent(run.id, 'executing', `e${i}`);

      const ot = s.insertTest({
        runId: otherRun.id,
        title: `o${i}`,
        reqTag: null,
        tier: null,
        status: 'pending',
      });
      s.insertResult({ testId: ot.id, status: 'passed', durationMs: i, error: null, artifactsJson: null });
      s.appendEvent(otherRun.id, 'executing', `oe${i}`);
    }

    expect(() => s.deleteRun(run.id)).not.toThrow();

    // The deleted run is gone; the project and the sibling run survive.
    expect(s.getRun(run.id)).toBeNull();
    expect(s.getProject(project.id)).not.toBeNull();
    expect(s.getRun(otherRun.id)).not.toBeNull();
    expect(s.listTests(otherRun.id)).toHaveLength(N);
    expect(s.listEvents(otherRun.id)).toHaveLength(N);

    // No orphan rows from the deleted run; the sibling run's rows remain.
    expect(await countRows('projects')).toBe(1);
    expect(await countRows('runs')).toBe(1);
    expect(await countRows('tests')).toBe(N);
    expect(await countRows('results')).toBe(N);
    expect(await countRows('agent_events')).toBe(N);
  });
});
