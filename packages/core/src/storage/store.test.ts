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

  it('migrates a pre-v9 database to add description/details columns without touching existing rows', async () => {
    // Open + migrate a fresh DB to v9+, insert a row the "old" way, then verify
    // an independent connection sees the new nullable columns and the row's
    // pre-existing data is untouched.
    const s = await store();
    const project = s.createProject({ name: 'migration-project', baseUrl: 'https://migration.test' });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: 'legacy row',
      reqTag: null,
      tier: null,
      status: 'pending',
    });

    const info = await dbInfo();
    expect(info.version).toBeGreaterThanOrEqual(9);

    const db = new DatabaseSync(dbPath());
    try {
      const cols = (db.prepare('PRAGMA table_info(tests)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).toContain('description');
      expect(cols).toContain('details');
      const resultCols = (db.prepare('PRAGMA table_info(results)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(resultCols).toContain('description');
      expect(resultCols).toContain('details');

      const row = db.prepare('SELECT * FROM tests WHERE id = ?').get(test.id) as Record<string, unknown>;
      expect(row.title).toBe('legacy row');
      expect(row.description).toBeNull();
      expect(row.details).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('TestCase/TestResult description and details', () => {
  it('round-trips description/details through insertTest/insertResult and the row mappers', async () => {
    const s = await store();
    const project = s.createProject({ name: 'desc-project', baseUrl: 'https://desc.test' });
    const run = s.createRun(project.id);

    const test = s.insertTest({
      runId: run.id,
      title: 'Login — positive: user submits valid credentials',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      status: 'pending',
      description: 'user submits valid credentials',
      details: 'Verify the login flow authenticates a user and redirects to the dashboard.',
    });
    expect(test.description).toBe('user submits valid credentials');
    expect(test.details).toBe('Verify the login flow authenticates a user and redirects to the dashboard.');

    const result = s.insertResult({
      testId: test.id,
      status: 'passed',
      durationMs: 120,
      error: null,
      artifactsJson: null,
      description: test.description,
      details: test.details,
    });
    expect(result.description).toBe(test.description);
    expect(result.details).toBe(test.details);

    // Round-trip via listTests/getTest/listResults (which run rows through rowToTest/rowToResult).
    const [listed] = s.listTests(run.id);
    expect(listed?.description).toBe('user submits valid credentials');
    expect(listed?.details).toBe(
      'Verify the login flow authenticates a user and redirects to the dashboard.',
    );

    const fetched = s.getTest(test.id);
    expect(fetched?.description).toBe('user submits valid credentials');
    expect(fetched?.details).toBe(
      'Verify the login flow authenticates a user and redirects to the dashboard.',
    );

    const [listedResult] = s.listResults(run.id);
    expect(listedResult?.description).toBe(test.description);
    expect(listedResult?.details).toBe(test.details);
  });

  it('defaults description/details to null when omitted', async () => {
    const s = await store();
    const project = s.createProject({ name: 'desc-null-project', baseUrl: 'https://desc-null.test' });
    const run = s.createRun(project.id);

    const test = s.insertTest({
      runId: run.id,
      title: 'no scenario data',
      reqTag: null,
      tier: null,
      status: 'pending',
    });
    expect(test.description).toBeNull();
    expect(test.details).toBeNull();

    const result = s.insertResult({
      testId: test.id,
      status: 'passed',
      durationMs: null,
      error: null,
      artifactsJson: null,
    });
    expect(result.description).toBeNull();
    expect(result.details).toBeNull();

    expect(s.getTest(test.id)?.description).toBeNull();
    expect(s.getTest(test.id)?.details).toBeNull();
  });

  it('getTest returns undefined for an unknown id', async () => {
    const s = await store();
    expect(s.getTest('tst_does-not-exist')).toBeUndefined();
  });
});

describe('updateTestSpec — directed re-exploration overwrites a regenerated spec onto an existing row', () => {
  it('updates title/specPath/specCode in place, leaves status/reqTag/tier untouched, and does not change the row count', async () => {
    const s = await store();
    const project = s.createProject({ name: 'reexplore-project', baseUrl: 'https://reexplore.test' });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: '[REQ:REQ-1] positive: resets password',
      reqTag: 'REQ-1',
      tier: 'tierB-auth',
      status: 'pending',
      specPath: 'tests/tierB-auth/req-1.spec.ts',
      specCode: 'test.fixme(...)',
    });

    s.updateTestSpec(test.id, {
      title: '[REQ:REQ-1] positive: resets password (regenerated)',
      specPath: 'tests/tierB-auth/req-1.spec.ts',
      specCode: 'test(...) // real selector found after directed re-exploration',
    });

    const updated = s.getTest(test.id);
    expect(updated?.title).toBe('[REQ:REQ-1] positive: resets password (regenerated)');
    expect(updated?.specCode).toBe('test(...) // real selector found after directed re-exploration');
    // Untouched fields.
    expect(updated?.status).toBe('pending');
    expect(updated?.reqTag).toBe('REQ-1');
    expect(updated?.tier).toBe('tierB-auth');
    // No duplicate row was created.
    expect(s.listTests(run.id)).toHaveLength(1);
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
      credentials: [{ username: 'tester@auth.test', password: 'hunter2' }],
    });
    const expected = [
      {
        id: expect.any(String),
        authType: 'form',
        username: 'tester@auth.test',
        password: 'hunter2',
        role: null,
        token: null,
        urlTemplate: null,
        extraParams: null,
        authCheckText: null,
      },
    ];
    expect(project.credentials).toEqual(expected);
    expect(s.getProject(project.id)?.credentials).toEqual(expected);

    const cleared = s.updateProject(project.id, {
      name: 'Auth Project',
      baseUrl: 'https://auth.test',
      credentials: [],
    });
    expect(cleared.credentials).toEqual([]);
    expect(s.getProject(project.id)?.credentials).toEqual([]);
  });

  it('supports multiple credentials with optional roles, preserving save order', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'Multi-Role Project',
      baseUrl: 'https://auth.test',
      credentials: [
        { username: 'admin@auth.test', password: 'adminpw', role: 'admin' },
        { username: 'user@auth.test', password: 'userpw' },
      ],
    });
    expect(project.credentials.map((c) => ({ username: c.username, role: c.role }))).toEqual([
      { username: 'admin@auth.test', role: 'admin' },
      { username: 'user@auth.test', role: null },
    ]);

    // Replace-all: updating drops any credential not in the new list.
    const updated = s.updateProject(project.id, {
      name: 'Multi-Role Project',
      baseUrl: 'https://auth.test',
      credentials: [{ username: 'user@auth.test', password: 'userpw' }],
    });
    expect(updated.credentials).toHaveLength(1);
    expect(updated.credentials[0]?.role).toBeNull();
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

describe('insertResult', () => {
  it('DUPLICATE-RESULT GUARD: re-persisting a result for the same testId replaces the prior row instead of adding a second one', async () => {
    // Simulates a tier re-executed after a resume that raced the checkpoint
    // write (see insertResult's doc comment) — the orchestrator calls
    // insertResult again for a test that already has a result row from the
    // earlier, unacknowledged attempt.
    const s = await store();
    const project = s.createProject({ name: 'result-upsert', baseUrl: 'https://result-upsert.test' });
    const run = s.createRun(project.id);
    const t = s.insertTest({ runId: run.id, title: 't0', reqTag: null, tier: null, status: 'pending' });

    s.insertResult({ testId: t.id, status: 'failed', durationMs: 10, error: 'boom', artifactsJson: null });
    s.insertResult({ testId: t.id, status: 'passed', durationMs: 12, error: null, artifactsJson: null });

    const results = s.listResults(run.id);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ testId: t.id, status: 'passed', durationMs: 12 });
    expect(await countRows('results')).toBe(1);
  });

  it('QA request: round-trips skipReason through insertResult/listResults', async () => {
    const s = await store();
    const project = s.createProject({ name: 'skip-reason-project', baseUrl: 'https://skip-reason.test' });
    const run = s.createRun(project.id);
    const t = s.insertTest({
      runId: run.id,
      title: 'staging-only check',
      reqTag: null,
      tier: null,
      status: 'pending',
    });

    s.insertResult({
      testId: t.id,
      status: 'skipped',
      durationMs: 0,
      error: null,
      artifactsJson: null,
      skipReason: 'staging-only feature not enabled here',
    });

    const [result] = s.listResults(run.id);
    expect(result?.skipReason).toBe('staging-only feature not enabled here');
  });

  it('defaults skipReason to null when omitted (a non-skipped result, or an older call site)', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'no-skip-reason-project',
      baseUrl: 'https://no-skip-reason.test',
    });
    const run = s.createRun(project.id);
    const t = s.insertTest({ runId: run.id, title: 't0', reqTag: null, tier: null, status: 'pending' });

    s.insertResult({ testId: t.id, status: 'passed', durationMs: 5, error: null, artifactsJson: null });

    const [result] = s.listResults(run.id);
    expect(result?.skipReason).toBeNull();
  });

  it('round-trips videoUnavailableReason through insertResult/listResults', async () => {
    const s = await store();
    const project = s.createProject({ name: 'video-reason-project', baseUrl: 'https://video-reason.test' });
    const run = s.createRun(project.id);
    const t = s.insertTest({
      runId: run.id,
      title: 'api-only check',
      reqTag: null,
      tier: null,
      status: 'pending',
    });

    s.insertResult({
      testId: t.id,
      status: 'passed',
      durationMs: 100,
      error: null,
      artifactsJson: null,
      videoUnavailableReason:
        'This test only used the API request context — no browser page was opened, so no video could be recorded.',
    });

    const [result] = s.listResults(run.id);
    expect(result?.videoUnavailableReason).toBe(
      'This test only used the API request context — no browser page was opened, so no video could be recorded.',
    );
  });

  it('defaults videoUnavailableReason to null when omitted (a video IS present, or an older call site)', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'no-video-reason-project',
      baseUrl: 'https://no-video-reason.test',
    });
    const run = s.createRun(project.id);
    const t = s.insertTest({ runId: run.id, title: 't1', reqTag: null, tier: null, status: 'pending' });

    s.insertResult({ testId: t.id, status: 'passed', durationMs: 5, error: null, artifactsJson: null });

    const [result] = s.listResults(run.id);
    expect(result?.videoUnavailableReason).toBeNull();
  });
});

describe('kb_test_scripts (Knowledge Base source-file grounding)', () => {
  it('records and lists the source file path for a KB item', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-source-project', baseUrl: 'https://kb-source.test' });
    const run = s.createRun(project.id);
    const kbItemId = s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_1',
      title: 'Login',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      scenarios: [{ index: 0, kind: 'positive', description: 'logs in' }],
    });

    s.recordKbTestScript({ kbItemId, runId: run.id, filePath: 'src/components/LoginForm.tsx' });

    const rows = s.listKbTestScripts(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kbItemId,
      runId: run.id,
      filePath: 'src/components/LoginForm.tsx',
    });
  });

  it('getKbTestScript returns the row for one item, and null when there is none', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-source-lookup-project', baseUrl: 'https://kb-lookup.test' });
    const run = s.createRun(project.id);
    const groundedId = s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_grounded',
      title: 'Checkout',
      reqTag: null,
      tier: 'tierA-public',
      scenarios: [{ index: 0, kind: 'positive', description: 'completes checkout' }],
    });
    const ungroundedId = s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_ungrounded',
      title: 'Black-box smoke check',
      reqTag: null,
      tier: 'tierA-public',
      scenarios: [{ index: 0, kind: 'positive', description: 'page loads' }],
    });
    s.recordKbTestScript({ kbItemId: groundedId, runId: run.id, filePath: 'src/pages/Checkout.tsx' });

    expect(s.getKbTestScript(groundedId)).toMatchObject({ filePath: 'src/pages/Checkout.tsx' });
    expect(s.getKbTestScript(ungroundedId)).toBeNull();
  });

  it('is idempotent — recording the same KB item twice does not duplicate the row', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'kb-source-idempotent-project',
      baseUrl: 'https://kb-idem.test',
    });
    const run = s.createRun(project.id);
    const kbItemId = s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_resumed',
      title: 'Resumed item',
      reqTag: null,
      tier: 'tierA-public',
      scenarios: [{ index: 0, kind: 'positive', description: 'works' }],
    });

    s.recordKbTestScript({ kbItemId, runId: run.id, filePath: 'src/pages/Resumed.tsx' });
    s.recordKbTestScript({ kbItemId, runId: run.id, filePath: 'src/pages/Resumed.tsx' });

    expect(await countRows('kb_test_scripts')).toBe(1);
  });

  it('a plan item with no source grounding simply has no row (not a row with a null/empty file path)', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-no-source-project', baseUrl: 'https://kb-no-source.test' });
    const run = s.createRun(project.id);
    s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_no_source',
      title: 'Black-box item',
      reqTag: null,
      tier: 'tierA-public',
      scenarios: [{ index: 0, kind: 'positive', description: 'works' }],
    });

    expect(s.listKbTestScripts(run.id)).toEqual([]);
  });
});

describe('kb_execution_artifacts (Knowledge Base error/trace/steps/network-log grounding)', () => {
  it('seedPlanKbItem seeds exactly one (empty) kb_execution_artifacts row per scenario', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-exec-seed-project', baseUrl: 'https://kb-exec-seed.test' });
    const run = s.createRun(project.id);

    s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_1',
      title: 'Login',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      scenarios: [
        { index: 0, kind: 'positive', description: 'logs in' },
        { index: 1, kind: 'negative', description: 'rejects bad password' },
      ],
    });

    const kbScenarios = s.listPlanKbScenarios(run.id);
    expect(kbScenarios).toHaveLength(2);
    const rows = s.listKbExecutionArtifacts(run.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.errorMessage).toBeNull();
      expect(row.tracePath).toBeNull();
      expect(row.executionSteps).toBeNull();
      expect(row.networkLogs).toBeNull();
    }
    expect(rows.map((r) => r.kbScenarioId).sort()).toEqual(kbScenarios.map((s) => s.id).sort());
  });

  it('updateKbExecutionArtifacts fills in error/trace/steps once a linked test result lands', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'kb-exec-update-project',
      baseUrl: 'https://kb-exec-update.test',
    });
    const run = s.createRun(project.id);
    s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_1',
      title: 'Login',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      scenarios: [{ index: 0, kind: 'negative', description: 'rejects bad password' }],
    });
    const test = s.insertTest({
      runId: run.id,
      title: 'rejects bad password',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      status: 'pending',
    });
    s.linkPlanKbScenarioTest(run.id, 'pli_1', 0, test.id);

    s.updateKbExecutionArtifacts(test.id, {
      errorMessage: 'expect(locator).toBeVisible() failed',
      tracePath: 'test-results/foo/trace.zip',
      executionSteps: JSON.stringify([{ title: 'fill password', durationMs: 5 }]),
    });

    const [kbScenario] = s.listPlanKbScenarios(run.id);
    const row = s.getKbExecutionArtifact(kbScenario.id);
    expect(row?.errorMessage).toBe('expect(locator).toBeVisible() failed');
    expect(row?.tracePath).toBe('test-results/foo/trace.zip');
    expect(row?.executionSteps).toBe(JSON.stringify([{ title: 'fill password', durationMs: 5 }]));
    expect(row?.networkLogs).toBeNull();
  });

  it('is a no-op for a test with no KB link (predates the KB, or a fallback row)', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'kb-exec-nolink-project',
      baseUrl: 'https://kb-exec-nolink.test',
    });
    const run = s.createRun(project.id);

    expect(() =>
      s.updateKbExecutionArtifacts('tst_unlinked', {
        errorMessage: 'boom',
        tracePath: null,
        executionSteps: null,
      }),
    ).not.toThrow();
    expect(s.listKbExecutionArtifacts(run.id)).toEqual([]);
  });

  it('re-seeding the same scenario on a resumed run does not duplicate its kb_execution_artifacts row', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'kb-exec-resume-project',
      baseUrl: 'https://kb-exec-resume.test',
    });
    const run = s.createRun(project.id);
    const seed = () =>
      s.seedPlanKbItem({
        runId: run.id,
        planItemId: 'pli_1',
        title: 'Login',
        reqTag: 'REQ-1',
        tier: 'tierA-public',
        scenarios: [{ index: 0, kind: 'positive', description: 'logs in' }],
      });

    seed();
    seed();

    expect(await countRows('kb_execution_artifacts')).toBe(1);
  });
});

describe('KB foundation: requirements/mock_responses/exploration_summaries/escape_hatch_gaps', () => {
  it('seedRequirement dedupes multiple items sharing the same reqTag within one run, and links plan_kb_items to it', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-req-project', baseUrl: 'https://kb-req.test' });
    const run = s.createRun(project.id);

    const kbItem1 = s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_1',
      title: 'Login UI flow',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      scenarios: [{ index: 0, kind: 'positive', description: 'logs in' }],
    });
    const kbItem2 = s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_2',
      title: 'POST /api/login contract',
      reqTag: 'REQ-1',
      tier: 'tierC-api',
      scenarios: [{ index: 0, kind: 'positive', description: 'returns 200' }],
    });

    const reqId1 = s.seedRequirement(run.id, 'REQ-1', 'Login UI flow');
    const reqId2 = s.seedRequirement(run.id, 'REQ-1', 'a different description — must still dedupe');
    expect(reqId2).toBe(reqId1);

    s.setPlanKbItemRequirement(kbItem1, reqId1);
    s.setPlanKbItemRequirement(kbItem2, reqId2);

    const requirements = s.listRequirements(run.id);
    expect(requirements).toHaveLength(1);
    expect(requirements[0]).toMatchObject({ tag: 'REQ-1', description: 'Login UI flow', source: 'plan' });

    const items = s.listPlanKbItems(run.id);
    expect(items.every((it) => it.requirementId === reqId1)).toBe(true);
  });

  it('a reqTag-less item has no requirement row and requirementId stays null', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-req-none-project', baseUrl: 'https://kb-req-none.test' });
    const run = s.createRun(project.id);
    s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_1',
      title: 'Untagged item',
      reqTag: null,
      tier: 'tierA-public',
      scenarios: [{ index: 0, kind: 'positive', description: 'works' }],
    });

    expect(s.listRequirements(run.id)).toEqual([]);
    expect(s.listPlanKbItems(run.id)[0]?.requirementId).toBeNull();
  });

  it('getTraceabilityMatrix joins requirement -> kb item -> scenario -> test into flat rows', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-matrix-project', baseUrl: 'https://kb-matrix.test' });
    const run = s.createRun(project.id);
    const kbItemId = s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_1',
      title: 'Login',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      scenarios: [{ index: 0, kind: 'positive', description: 'logs in' }],
    });
    const reqId = s.seedRequirement(run.id, 'REQ-1', 'Login');
    s.setPlanKbItemRequirement(kbItemId, reqId);
    const test = s.insertTest({
      runId: run.id,
      title: 'logs in',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      status: 'pending',
    });
    s.linkPlanKbScenarioTest(run.id, 'pli_1', 0, test.id);
    s.updatePlanKbScenarioStatusByTestId(test.id, 'passed');

    const matrix = s.getTraceabilityMatrix(run.id);
    expect(matrix).toHaveLength(1);
    expect(matrix[0]).toMatchObject({
      requirementTag: 'REQ-1',
      kbItemTitle: 'Login',
      scenarioDescription: 'logs in',
      scenarioStatus: 'passed',
      testId: test.id,
    });
  });

  it('getTraceabilityMatrix omits a kb item with no requirement link (reqTag-less item)', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'kb-matrix-none-project',
      baseUrl: 'https://kb-matrix-none.test',
    });
    const run = s.createRun(project.id);
    s.seedPlanKbItem({
      runId: run.id,
      planItemId: 'pli_1',
      title: 'Untagged',
      reqTag: null,
      tier: 'tierA-public',
      scenarios: [{ index: 0, kind: 'positive', description: 'works' }],
    });

    expect(s.getTraceabilityMatrix(run.id)).toEqual([]);
  });

  it('upsertMockResponse inserts mock_* fields and leaves observed_* fields null', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-mock-project', baseUrl: 'https://kb-mock.test' });
    const run = s.createRun(project.id);

    const id = s.upsertMockResponse({
      runId: run.id,
      dependencyId: 'dep_1',
      category: 'auth',
      method: 'POST',
      pathPattern: '/api/login',
      mockStrategy: 'route-intercept',
      mockStatus: 200,
      mockBodyJson: JSON.stringify({ message: 'Login successful' }),
      mockHeadersJson: null,
    });

    const rows = s.listMockResponses(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      dependencyId: 'dep_1',
      category: 'auth',
      method: 'POST',
      pathPattern: '/api/login',
      mockStatus: 200,
      mockBodyJson: JSON.stringify({ message: 'Login successful' }),
      observedStatus: null,
      observedBodyJson: null,
      observedHeadersJson: null,
    });
  });

  it('recordObservedMockResponse grounds observed_* fields onto an existing row without touching its mock_* fields', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-observed-project', baseUrl: 'https://kb-observed.test' });
    const run = s.createRun(project.id);

    const id = s.upsertMockResponse({
      runId: run.id,
      dependencyId: 'dep_1',
      category: 'auth',
      method: 'POST',
      pathPattern: '/api/login',
      mockStrategy: 'route-intercept',
      mockStatus: 200,
      mockBodyJson: JSON.stringify({ message: 'Login successful' }),
      mockHeadersJson: null,
    });

    s.recordObservedMockResponse(id, {
      status: 200,
      bodyJson: JSON.stringify({ message: 'Login successful' }),
      headersJson: JSON.stringify({ 'content-type': 'application/json' }),
    });

    const row = s.listMockResponses(run.id)[0];
    expect(row).toMatchObject({
      id,
      // mock_* fields (the pre-execution plan) untouched by the observed_* write.
      mockStatus: 200,
      mockBodyJson: JSON.stringify({ message: 'Login successful' }),
      observedStatus: 200,
      observedBodyJson: JSON.stringify({ message: 'Login successful' }),
      observedHeadersJson: JSON.stringify({ 'content-type': 'application/json' }),
    });
  });

  it('upsertMockResponse refreshes mock_* fields on a resumed run instead of duplicating the row', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'kb-mock-resume-project',
      baseUrl: 'https://kb-mock-resume.test',
    });
    const run = s.createRun(project.id);
    const input = {
      runId: run.id,
      dependencyId: 'dep_1',
      category: 'auth',
      method: 'POST',
      pathPattern: '/api/login',
      mockStrategy: 'route-intercept',
      mockStatus: 200,
      mockBodyJson: JSON.stringify({ message: 'first' }),
      mockHeadersJson: null,
    };

    const id1 = s.upsertMockResponse(input);
    const id2 = s.upsertMockResponse({ ...input, mockBodyJson: JSON.stringify({ message: 'second' }) });

    expect(id2).toBe(id1);
    expect(await countRows('mock_responses')).toBe(1);
    expect(s.listMockResponses(run.id)[0]?.mockBodyJson).toBe(JSON.stringify({ message: 'second' }));
  });

  it('upsertMockResponse refreshes (not duplicates) a row with null method/pathPattern on a resumed run', async () => {
    // Regression test: SQLite's UNIQUE index treats every NULL as distinct
    // from every other NULL, so ON CONFLICT(run_id, dependency_id, method,
    // path_pattern) would never fire for two calls with method/pathPattern
    // both null (the real-world path for a dependency with no endpoints,
    // see orchestrator/index.ts) unless nulls are normalized before the
    // insert/select.
    const s = await store();
    const project = s.createProject({
      name: 'kb-mock-null-resume-project',
      baseUrl: 'https://kb-mock-null-resume.test',
    });
    const run = s.createRun(project.id);
    const input = {
      runId: run.id,
      dependencyId: 'dep_1',
      category: 'payments',
      method: null,
      pathPattern: null,
      mockStrategy: 'static',
      mockStatus: 200,
      mockBodyJson: JSON.stringify({ status: 'first' }),
      mockHeadersJson: null,
    };

    const id1 = s.upsertMockResponse(input);
    const id2 = s.upsertMockResponse({ ...input, mockBodyJson: JSON.stringify({ status: 'second' }) });

    expect(id2).toBe(id1);
    expect(await countRows('mock_responses')).toBe(1);
    const row = s.listMockResponses(run.id)[0];
    expect(row?.mockBodyJson).toBe(JSON.stringify({ status: 'second' }));
    expect(row?.method).toBeNull();
    expect(row?.pathPattern).toBeNull();
  });

  it('recordMockUsage/listMockUsageForTest round-trip a per-test usage row', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-mock-usage-project', baseUrl: 'https://kb-mock-usage.test' });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: 'logs in',
      reqTag: null,
      tier: 'tierA-public',
      status: 'pending',
    });
    const mockId = s.upsertMockResponse({
      runId: run.id,
      dependencyId: 'dep_1',
      category: 'auth',
      method: null,
      pathPattern: null,
      mockStrategy: 'route-intercept',
      mockStatus: 200,
      mockBodyJson: null,
      mockHeadersJson: null,
    });

    s.recordMockUsage(test.id, mockId, 3);

    const usage = s.listMockUsageForTest(test.id);
    expect(usage).toEqual([{ testId: test.id, mockResponseId: mockId, requestCount: 3 }]);
  });

  it('insertExplorationSummary seeds one row per route, idempotently', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-explore-project', baseUrl: 'https://kb-explore.test' });
    const run = s.createRun(project.id);

    s.insertExplorationSummary({
      runId: run.id,
      route: '/login',
      selectorsJson: JSON.stringify([{ selector: '#email' }]),
      formsJson: null,
      authPattern: 'password-form',
      stateProbeCount: null,
    });
    s.insertExplorationSummary({
      runId: run.id,
      route: '/login',
      selectorsJson: JSON.stringify([{ selector: '#email' }]),
      formsJson: null,
      authPattern: 'password-form',
      stateProbeCount: null,
    });
    s.insertExplorationSummary({
      runId: run.id,
      route: '/dashboard',
      selectorsJson: null,
      formsJson: null,
      authPattern: null,
      stateProbeCount: null,
    });

    const rows = s.listExplorationSummaries(run.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.route === '/login')).toMatchObject({
      authPattern: 'password-form',
      selectorsJson: JSON.stringify([{ selector: '#email' }]),
    });
    expect(await countRows('exploration_summaries')).toBe(2);
  });

  it('insertEscapeHatchGap/updateEscapeHatchGapStatus/listEscapeHatchGaps round-trip a gap', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-escape-project', baseUrl: 'https://kb-escape.test' });
    const run = s.createRun(project.id);

    const id = s.insertEscapeHatchGap({
      runId: run.id,
      planItemId: 'pli_1',
      unitKey: 'route:/checkout',
      reasonsJson: JSON.stringify(['no selector observed for the confirmation banner']),
    });

    let [gap] = s.listEscapeHatchGaps(run.id);
    expect(gap).toMatchObject({ id, status: 'open', iteration: 0 });

    s.updateEscapeHatchGapStatus(id, 'resolved');
    [gap] = s.listEscapeHatchGaps(run.id);
    expect(gap?.status).toBe('resolved');
  });

  it('insertResult round-trips evidenceJson, defaulting to null when omitted', async () => {
    const s = await store();
    const project = s.createProject({ name: 'kb-evidence-project', baseUrl: 'https://kb-evidence.test' });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: 'logs in',
      reqTag: null,
      tier: 'tierA-public',
      status: 'pending',
    });

    const evidence = JSON.stringify({
      tracePath: 'test-results/foo/trace.zip',
      apiEvidence: 'GET /x -> 200',
    });
    s.insertResult({
      testId: test.id,
      status: 'passed',
      durationMs: 10,
      error: null,
      artifactsJson: null,
      evidenceJson: evidence,
    });
    expect(s.listResults(run.id)[0]?.evidenceJson).toBe(evidence);

    const test2 = s.insertTest({
      runId: run.id,
      title: 'no evidence',
      reqTag: null,
      tier: 'tierA-public',
      status: 'pending',
    });
    s.insertResult({ testId: test2.id, status: 'passed', durationMs: 5, error: null, artifactsJson: null });
    expect(s.listResults(run.id).find((r) => r.testId === test2.id)?.evidenceJson).toBeNull();
  });
});

describe('deleteUnexecutedTests', () => {
  it('removes only test rows with zero result rows, leaving executed ones (including a genuine "pending"/skipped result) untouched', async () => {
    const s = await store();
    const project = s.createProject({ name: 'reconcile-project', baseUrl: 'https://reconcile.test' });
    const run = s.createRun(project.id);

    const executed = s.insertTest({
      runId: run.id,
      title: 'passed one',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      status: 'pending',
    });
    s.insertResult({
      testId: executed.id,
      status: 'passed',
      durationMs: 5,
      error: null,
      artifactsJson: null,
    });

    const skipped = s.insertTest({
      runId: run.id,
      title: 'skipped one',
      reqTag: 'REQ-2',
      tier: 'tierA-public',
      status: 'pending',
    });
    // A genuinely executed-but-skipped scenario still gets a result row, whose
    // status can itself be 'pending' (see execute.ts's normalizeStatus) — this
    // must NOT be mistaken for an unexecuted row.
    s.insertResult({
      testId: skipped.id,
      status: 'pending',
      durationMs: null,
      error: null,
      artifactsJson: null,
    });

    const neverRan = s.insertTest({
      runId: run.id,
      title: 'planned but never generated/executed',
      reqTag: 'REQ-3',
      tier: 'tierA-public',
      status: 'pending',
    });

    expect(s.listTests(run.id)).toHaveLength(3);

    const removed = s.deleteUnexecutedTests(run.id);
    expect(removed).toBe(1);

    const remaining = s.listTests(run.id);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((t) => t.id).sort()).toEqual([executed.id, skipped.id].sort());
    expect(remaining.some((t) => t.id === neverRan.id)).toBe(false);
  });

  it('is a no-op when every test row has a matching result', async () => {
    const s = await store();
    const project = s.createProject({ name: 'reconcile-clean', baseUrl: 'https://reconcile-clean.test' });
    const run = s.createRun(project.id);
    const t = s.insertTest({
      runId: run.id,
      title: 'ok',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      status: 'pending',
    });
    s.insertResult({ testId: t.id, status: 'passed', durationMs: 1, error: null, artifactsJson: null });

    expect(s.deleteUnexecutedTests(run.id)).toBe(0);
    expect(s.listTests(run.id)).toHaveLength(1);
  });

  it("only reconciles the given run, leaving another run's unexecuted rows alone", async () => {
    const s = await store();
    const project = s.createProject({ name: 'reconcile-scoped', baseUrl: 'https://reconcile-scoped.test' });
    const runA = s.createRun(project.id);
    const runB = s.createRun(project.id);

    s.insertTest({ runId: runA.id, title: 'unran in A', reqTag: 'REQ-1', tier: null, status: 'pending' });
    s.insertTest({ runId: runB.id, title: 'unran in B', reqTag: 'REQ-1', tier: null, status: 'pending' });

    expect(s.deleteUnexecutedTests(runA.id)).toBe(1);
    expect(s.listTests(runA.id)).toHaveLength(0);
    // Run B was never passed to deleteUnexecutedTests — its row must survive.
    expect(s.listTests(runB.id)).toHaveLength(1);
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
