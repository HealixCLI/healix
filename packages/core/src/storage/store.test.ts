import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    const project = s.createProject({ name: 'cascade-project', baseUrl: 'https://cascade.test' });
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

    const target = s.createProject({ name: 'to-delete', baseUrl: 'https://to-delete.test' });
    const keep = s.createProject({ name: 'to-keep', baseUrl: 'https://to-keep.test' });

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

describe('updateProject', () => {
  it('persists edited fields and returns the updated project', async () => {
    const s = await store();
    const project = s.createProject({ name: 'Original', baseUrl: 'https://original.test' });

    const updated = s.updateProject(project.id, {
      name: 'Renamed',
      mode: 'playwright',
      repoPath: '/Users/me/code/renamed',
      baseUrl: null,
    });

    expect(updated).toMatchObject({
      id: project.id,
      name: 'Renamed',
      repoPath: '/Users/me/code/renamed',
      baseUrl: null,
    });
    // createdAt is preserved across the edit — only editable fields change.
    expect(updated.createdAt).toBe(project.createdAt);
    expect(s.getProject(project.id)).toMatchObject({ name: 'Renamed', repoPath: '/Users/me/code/renamed' });
  });

  it('persists and round-trips test credentials through create, get, and update', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'Auth Project',
      baseUrl: 'https://auth.test',
      testUsername: 'tester@auth.test',
      testPassword: 'hunter2',
    });
    expect(project.testUsername).toBe('tester@auth.test');
    expect(project.testPassword).toBe('hunter2');
    expect(s.getProject(project.id)).toMatchObject({
      testUsername: 'tester@auth.test',
      testPassword: 'hunter2',
    });

    const cleared = s.updateProject(project.id, {
      name: 'Auth Project',
      baseUrl: 'https://auth.test',
      testUsername: null,
      testPassword: null,
    });
    expect(cleared.testUsername).toBeNull();
    expect(cleared.testPassword).toBeNull();
    expect(s.getProject(project.id)).toMatchObject({ testUsername: null, testPassword: null });
  });

  it('throws and persists nothing when the edit would violate the invariant', async () => {
    const s = await store();
    const project = s.createProject({ name: 'Original', baseUrl: 'https://original.test' });

    expect(() => s.updateProject(project.id, { name: 'Original' })).toThrow(/repo path or a base URL/i);
    // Rejected edit must not have touched the stored row.
    expect(s.getProject(project.id)).toMatchObject({ name: 'Original', baseUrl: 'https://original.test' });
  });

  it('throws for an unknown project id', async () => {
    const s = await store();
    expect(() => s.updateProject('prj_does_not_exist', { name: 'X', baseUrl: 'https://x.test' })).toThrow(
      /not found/i,
    );
  });
});

describe('duplicate project names', () => {
  it('blocks creating a second active project with the same name', async () => {
    const s = await store();
    s.createProject({ name: 'Acme', baseUrl: 'https://acme.test' });

    expect(() => s.createProject({ name: 'Acme', baseUrl: 'https://acme2.test' })).toThrow(/already exists/i);
    // Rejected create must not have persisted a second row.
    expect(s.listProjects()).toHaveLength(1);
  });

  it('matches names case-insensitively', async () => {
    const s = await store();
    s.createProject({ name: 'Acme', baseUrl: 'https://acme.test' });

    expect(() => s.createProject({ name: 'ACME', baseUrl: 'https://acme2.test' })).toThrow(/already exists/i);
    expect(() => s.createProject({ name: '  acme  ', baseUrl: 'https://acme3.test' })).toThrow(
      /already exists/i,
    );
  });

  it('allows reusing the name of an archived project', async () => {
    const s = await store();
    const original = s.createProject({ name: 'Acme', baseUrl: 'https://acme.test' });
    s.setProjectArchived(original.id, true);

    const recreated = s.createProject({ name: 'Acme', baseUrl: 'https://acme2.test' });
    expect(recreated.id).not.toBe(original.id);
    expect(s.listProjects().filter((p) => !p.archivedAt)).toHaveLength(1);
  });

  it('blocks renaming a project to collide with another active project', async () => {
    const s = await store();
    s.createProject({ name: 'Acme', baseUrl: 'https://acme.test' });
    const other = s.createProject({ name: 'Beta', baseUrl: 'https://beta.test' });

    expect(() => s.updateProject(other.id, { name: 'Acme', baseUrl: 'https://beta.test' })).toThrow(
      /already exists/i,
    );
    // Rejected rename must not have touched the row.
    expect(s.getProject(other.id)).toMatchObject({ name: 'Beta' });
  });

  it('allows updating a project without changing its own name (no self-collision)', async () => {
    const s = await store();
    const project = s.createProject({ name: 'Acme', baseUrl: 'https://acme.test' });

    const updated = s.updateProject(project.id, { name: 'Acme', baseUrl: 'https://acme-v2.test' });
    expect(updated.name).toBe('Acme');
    expect(updated.baseUrl).toBe('https://acme-v2.test');
  });
});

describe('deleteRun cascade', () => {
  it('removes the run and its descendants without a FOREIGN KEY error and leaves no orphans', async () => {
    const s = await store();

    const project = s.createProject({ name: 'run-cascade', baseUrl: 'https://run-cascade.test' });
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

describe('top-up suite lineage', () => {
  it('round-trips suiteMode/baseRunId on runs and specPath on tests', async () => {
    const s = await store();
    const project = s.createProject({ name: 'lineage-project', baseUrl: 'https://lineage.test' });

    const baseRun = s.createRun(project.id, { provider: null, mode: 'playwright' });
    expect(baseRun.suiteMode).toBeNull();
    expect(baseRun.baseRunId).toBeNull();

    const topupRun = s.createRun(project.id, { suiteMode: 'topup', baseRunId: baseRun.id });
    expect(topupRun.suiteMode).toBe('topup');
    expect(topupRun.baseRunId).toBe(baseRun.id);
    expect(s.getRun(topupRun.id)).toMatchObject({ suiteMode: 'topup', baseRunId: baseRun.id });

    const test = s.insertTest({
      runId: topupRun.id,
      title: 'Login with valid credentials',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      status: 'passed',
      specPath: 'tests/tierA-public/login.spec.ts',
    });
    expect(test.specPath).toBe('tests/tierA-public/login.spec.ts');
    expect(s.listTests(topupRun.id)).toMatchObject([{ specPath: 'tests/tierA-public/login.spec.ts' }]);
  });

  it('defaults specPath to null when omitted (legacy-row shape)', async () => {
    const s = await store();
    const project = s.createProject({ name: 'legacy-project', baseUrl: 'https://legacy.test' });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: 'legacy test',
      reqTag: null,
      tier: null,
      status: 'pending',
    });
    expect(test.specPath).toBeNull();
    expect(s.listTests(run.id)).toMatchObject([{ specPath: null }]);
  });
});

describe('getLastSuccessfulRun', () => {
  it('returns null when the project has no runs at all', async () => {
    const s = await store();
    const project = s.createProject({ name: 'no-runs', baseUrl: 'https://no-runs.test' });
    expect(s.getLastSuccessfulRun(project.id)).toBeNull();
  });

  it('returns null when every run is error or cancelled (never produced a real verdict)', async () => {
    const s = await store();
    const project = s.createProject({ name: 'never-completed', baseUrl: 'https://never-completed.test' });
    const errored = s.createRun(project.id);
    s.updateRunStatus(errored.id, 'error', { finishedAt: new Date().toISOString() });
    const cancelled = s.createRun(project.id);
    s.updateRunStatus(cancelled.id, 'cancelled', { finishedAt: new Date().toISOString() });
    expect(s.getLastSuccessfulRun(project.id)).toBeNull();
  });

  it('counts a failed or blocked run as eligible — not just a fully-passed one', async () => {
    const s = await store();
    const project = s.createProject({ name: 'partial-failures', baseUrl: 'https://partial-failures.test' });
    const run = s.createRun(project.id);
    s.updateRunStatus(run.id, 'failed', { finishedAt: new Date().toISOString() });
    const last = s.getLastSuccessfulRun(project.id);
    expect(last?.id).toBe(run.id);
    expect(last?.status).toBe('failed');
  });

  it('picks the most recent eligible run, ignoring later error/cancelled runs and other projects', async () => {
    const s = await store();
    const project = s.createProject({ name: 'mixed-history', baseUrl: 'https://mixed-history.test' });
    const other = s.createProject({ name: 'other-project', baseUrl: 'https://other-project.test' });

    const firstPassed = s.createRun(project.id);
    s.updateRunStatus(firstPassed.id, 'passed', { finishedAt: new Date().toISOString() });

    const secondFailed = s.createRun(project.id);
    s.updateRunStatus(secondFailed.id, 'failed', { finishedAt: new Date().toISOString() });

    const laterCancelled = s.createRun(project.id);
    s.updateRunStatus(laterCancelled.id, 'cancelled', { finishedAt: new Date().toISOString() });

    const otherProjectPassed = s.createRun(other.id);
    s.updateRunStatus(otherProjectPassed.id, 'passed', { finishedAt: new Date().toISOString() });

    const last = s.getLastSuccessfulRun(project.id);
    expect(last?.id).toBe(secondFailed.id);
    expect(last?.status).toBe('failed');
  });
});

describe('agent event ordering', () => {
  it('returns same-millisecond events in insertion order (stable rowid tiebreaker)', async () => {
    const s = await store();
    const project = s.createProject({ name: 'event-order', baseUrl: 'https://event-order.test' });
    const run = s.createRun(project.id);

    // Freeze the clock so every event shares an identical created_at; only the
    // rowid tiebreaker can then keep listEvents() in insertion order.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
    try {
      const N = 25;
      for (let i = 0; i < N; i++) {
        s.appendEvent(run.id, 'executing', `event ${i}`);
      }
      const events = s.listEvents(run.id);
      expect(events).toHaveLength(N);
      // All share one timestamp...
      expect(new Set(events.map((e) => e.createdAt)).size).toBe(1);
      // ...yet come back in the exact order they were appended.
      expect(events.map((e) => e.message)).toEqual(Array.from({ length: N }, (_, i) => `event ${i}`));
    } finally {
      vi.useRealTimers();
    }
  });
});
