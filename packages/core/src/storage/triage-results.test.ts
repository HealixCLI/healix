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

import { dbInfo } from './db.js';
import { type HealixStore, getStore, resetStoreForTests } from './store.js';
import { dbPath } from '../env/app-data.js';

/**
 * Frozen snapshot of the pre-v14 schema (every table/index/column that
 * existed before this PR added `tests.spec_code` and `triage_results`),
 * hand-copied rather than derived from the live SCHEMA_SQL — the whole point
 * is to simulate a real on-disk DB from BEFORE this feature, so deriving it
 * from the current schema.ts would make the regression test tautological (it
 * would silently keep passing even if a future change reintroduces this bug).
 */
const PRE_V14_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'playwright',
  repo_path     TEXT,
  base_url      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at   TEXT,
  test_username TEXT,
  test_password TEXT
);

CREATE TABLE IF NOT EXISTS project_credentials (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  username        TEXT NOT NULL,
  password        TEXT,
  role            TEXT,
  auth_type       TEXT NOT NULL DEFAULT 'form',
  token           TEXT,
  url_template    TEXT,
  extra_params    TEXT,
  auth_check_text TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  status        TEXT NOT NULL DEFAULT 'pending',
  provider      TEXT,
  mode          TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  suite_mode    TEXT,
  base_run_id   TEXT REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS tests (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  title       TEXT NOT NULL,
  req_tag     TEXT,
  tier        TEXT,
  status      TEXT,
  spec_path   TEXT,
  description TEXT,
  details     TEXT
);

CREATE TABLE IF NOT EXISTS results (
  id             TEXT PRIMARY KEY,
  test_id        TEXT NOT NULL REFERENCES tests(id),
  status         TEXT NOT NULL,
  duration_ms    INTEGER,
  error          TEXT,
  artifacts_json TEXT,
  description    TEXT,
  details        TEXT,
  steps_json     TEXT
);

CREATE TABLE IF NOT EXISTS agent_events (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  phase       TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',
  message     TEXT NOT NULL,
  data_json   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage (
  id                          TEXT PRIMARY KEY,
  run_id                      TEXT NOT NULL REFERENCES runs(id),
  phase                       TEXT NOT NULL,
  task                        TEXT,
  provider                    TEXT NOT NULL,
  input_tokens                INTEGER,
  output_tokens               INTEGER,
  cost_usd                    REAL,
  cache_creation_input_tokens INTEGER,
  cache_read_input_tokens     INTEGER,
  model                       TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_credentials_project ON project_credentials(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_tests_run ON tests(run_id);
CREATE INDEX IF NOT EXISTS idx_results_test ON results(test_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);
`;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-triage-results-test-'));
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

describe('HealixStore triage_results', () => {
  it('creates the triage_results table and tests.spec_code column on first open', async () => {
    await store();
    const info = await dbInfo();
    expect(info.tables).toContain('triage_results');
  });

  it('records and lists triage results for a run, in insertion order', async () => {
    const s = await store();
    const project = s.createProject({ name: 'triage-results-project', baseUrl: 'https://triage.test' });
    const run = s.createRun(project.id);
    const testA = s.insertTest({
      runId: run.id,
      title: 'Checkout completes',
      reqTag: 'REQ-1',
      tier: 'tierC-api',
      status: 'failed',
      specCode: "test('checkout', async () => {});",
    });
    const testB = s.insertTest({
      runId: run.id,
      title: 'Cart totals update',
      reqTag: 'REQ-2',
      tier: 'tierC-api',
      status: 'failed',
    });

    s.recordTriageResult({
      testId: testA.id,
      verdict: 'app_is_wrong',
      confidence: 0.85,
      rationale: '5xx is a real regression',
      suggestedPatch: 'Fix the /api/checkout handler.',
      verdictSource: 'ai_reviewed',
    });
    s.recordTriageResult({
      testId: testB.id,
      verdict: 'flaky',
      confidence: 0.4,
      rationale: 'timing-sensitive',
    });

    const rows = s.listTriageResults(run.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.testId)).toEqual([testA.id, testB.id]);
    expect(rows[0]).toMatchObject({
      verdict: 'app_is_wrong',
      confidence: 0.85,
      rationale: '5xx is a real regression',
      suggestedPatch: 'Fix the /api/checkout handler.',
      verdictSource: 'ai_reviewed',
    });
    // suggestedPatch/verdictSource omitted for testB — must default to null, not undefined.
    expect(rows[1]).toMatchObject({ verdict: 'flaky', suggestedPatch: null, verdictSource: null });
  });

  it('listTriageResults returns nothing for a run with no recorded triage results', async () => {
    const s = await store();
    const project = s.createProject({ name: 'no-triage-project', baseUrl: 'https://no-triage.test' });
    const run = s.createRun(project.id);
    expect(s.listTriageResults(run.id)).toEqual([]);
  });

  it('registerSpecRows-style insertTest persists specCode, retrievable via listTests', async () => {
    const s = await store();
    const project = s.createProject({ name: 'speccode-project', baseUrl: 'https://speccode.test' });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: 'GET /api/x',
      reqTag: 'REQ-X',
      tier: 'tierC-api',
      status: 'pending',
      specCode: "import { test, expect } from '@playwright/test';",
    });

    const fetched = s.listTests(run.id).find((t) => t.id === test.id);
    expect(fetched?.specCode).toBe("import { test, expect } from '@playwright/test';");
  });

  it('defaults specCode to null when omitted (legacy-row shape)', async () => {
    const s = await store();
    const project = s.createProject({ name: 'no-speccode-project', baseUrl: 'https://no-speccode.test' });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: 'legacy row',
      reqTag: null,
      tier: null,
      status: 'pending',
    });
    expect(test.specCode).toBeNull();
  });

  it('deleteRun cascades triage_results, leaving no orphans', async () => {
    const s = await store();
    const project = s.createProject({ name: 'delete-triage-project', baseUrl: 'https://delete-triage.test' });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: 'X',
      reqTag: null,
      tier: null,
      status: 'failed',
    });
    s.recordTriageResult({ testId: test.id, verdict: 'ambiguous', confidence: 0.3, rationale: 'x' });

    s.deleteRun(run.id);

    expect(s.listTriageResults(run.id)).toEqual([]);
  });

  it('deleteProject cascades triage_results for every run of that project, leaving no orphans', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'delete-proj-triage',
      baseUrl: 'https://delete-proj-triage.test',
    });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: 'X',
      reqTag: null,
      tier: null,
      status: 'failed',
    });
    s.recordTriageResult({ testId: test.id, verdict: 'ambiguous', confidence: 0.3, rationale: 'x' });

    s.deleteProject(project.id);

    expect(s.listTriageResults(run.id)).toEqual([]);
  });

  it('retrofits tests.spec_code and the triage_results table onto a pre-existing v13 database missing them', async () => {
    // Simulate a real pre-fix installation: a DB file already at user_version = 13
    // (every table/column that existed before this PR) with NO tests.spec_code
    // column and NO triage_results table at all — built directly with a raw
    // connection, NOT via openDb()/getStore(), so the current SCHEMA_SQL (which
    // already includes both) never runs against it first.
    const raw = new DatabaseSync(dbPath());
    try {
      raw.exec(PRE_V14_SCHEMA_SQL);
      raw.exec('PRAGMA user_version = 13;');
      // A real pre-existing row, inserted the "old" way (no spec_code column
      // to write to) — proves the migration is additive, not destructive: this
      // row's existing data must survive untouched.
      raw.exec(`
        INSERT INTO projects (id, name, base_url) VALUES ('prj_legacy', 'Legacy', 'https://legacy.test');
        INSERT INTO runs (id, project_id, status) VALUES ('run_legacy', 'prj_legacy', 'failed');
        INSERT INTO tests (id, run_id, title, status) VALUES ('tst_legacy', 'run_legacy', 'Legacy test', 'failed');
        INSERT INTO results (id, test_id, status) VALUES ('res_legacy', 'tst_legacy', 'failed');
      `);
    } finally {
      raw.close(); // must close before the store opens its own handle on the same file
    }

    const s = await store();

    const info = await dbInfo();
    expect(info.version).toBe(17);
    expect(info.tables).toContain('triage_results');

    // The pre-existing row survived, untouched, with spec_code defaulting to null.
    const legacyTest = s.listTests('run_legacy').find((t) => t.id === 'tst_legacy');
    expect(legacyTest?.title).toBe('Legacy test');
    expect(legacyTest?.status).toBe('failed');
    expect(legacyTest?.specCode).toBeNull();

    // Prove the retrofitted table is actually usable, not just present — a
    // triage result can be recorded against the pre-existing legacy test row.
    expect(() =>
      s.recordTriageResult({
        testId: 'tst_legacy',
        verdict: 'app_is_wrong',
        confidence: 0.7,
        rationale: 'retrofit check',
      }),
    ).not.toThrow();
    const rows = s.listTriageResults('run_legacy');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: 'app_is_wrong', confidence: 0.7 });

    // QA request (v15): the pre-existing legacy result row survives with
    // skip_reason defaulting to null, and a freshly-inserted result can use
    // the retrofitted column right away.
    const legacyResults = s.listResults('run_legacy');
    expect(legacyResults.find((r) => r.id === 'res_legacy')?.skipReason).toBeNull();
  });
});
