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
 * Frozen snapshot of the pre-v11 schema (every table/index that existed before this
 * PR added `usage`), hand-copied rather than derived from the live SCHEMA_SQL — the
 * whole point is to simulate an on-disk DB from BEFORE the usage table was added, so
 * deriving it from the current schema.ts would make the regression test tautological
 * (it would silently keep passing even if a future change reintroduces this bug).
 */
const PRE_V11_SCHEMA_SQL = `
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

CREATE INDEX IF NOT EXISTS idx_credentials_project ON project_credentials(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_tests_run ON tests(run_id);
CREATE INDEX IF NOT EXISTS idx_results_test ON results(test_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id);
`;

/**
 * Frozen snapshot of the v11 schema (usage table present, but WITHOUT the
 * cache_creation_input_tokens/cache_read_input_tokens columns this PR adds) —
 * simulates a real on-disk DB from between the usage-tracking feature and
 * this cache-token follow-up, same rationale as PRE_V11_SCHEMA_SQL above.
 */
const PRE_V12_SCHEMA_SQL = `
${PRE_V11_SCHEMA_SQL}

CREATE TABLE IF NOT EXISTS usage (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  phase         TEXT NOT NULL,
  task          TEXT,
  provider      TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);
`;

/**
 * Frozen snapshot of the v12 schema (cache-token columns present, but WITHOUT
 * the `model` column this PR adds) — simulates a real on-disk DB from between
 * the cache-token follow-up and this model-tracking follow-up, same rationale
 * as the snapshots above.
 */
const PRE_V13_SCHEMA_SQL = `
${PRE_V11_SCHEMA_SQL}

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
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);
`;

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
      cacheCreationInputTokens: 500,
      cacheReadInputTokens: 1500,
      model: 'claude-sonnet-5',
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
      cacheCreationInputTokens: 500,
      cacheReadInputTokens: 1500,
      model: 'claude-sonnet-5',
    });
    // A call with no cache activity/model reported (2nd recordUsage call above omitted the fields).
    expect(rows[1]).toMatchObject({
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      model: null,
    });
    expect(rows[2]).toMatchObject({
      task: 'flaky test',
      provider: 'openai',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      model: null,
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
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 2000,
      model: 'claude-sonnet-5',
    });
    s.recordUsage({
      runId: runA.id,
      phase: 'generate',
      provider: 'claude',
      inputTokens: 300,
      outputTokens: 30,
      costUsd: 0.3,
      model: 'claude-haiku-4-5-20251001',
    });
    s.recordUsage({
      runId: runB.id,
      phase: 'plan',
      provider: 'claude',
      inputTokens: 200,
      outputTokens: 20,
      costUsd: 0.2,
      cacheCreationInputTokens: 500,
      cacheReadInputTokens: 4000,
      model: 'claude-sonnet-5',
    });

    const agg = s.getUsageAggregate({ projectId: project.id });

    // Per-run: runA totals 400/40/0.4, runB totals 200/20/0.2 — newest (runB) first.
    expect(agg.perRun).toHaveLength(2);
    const [first, second] = agg.perRun;
    expect(first.runId).toBe(runB.id);
    expect(first.inputTokens).toBe(200);
    expect(first.outputTokens).toBe(20);
    expect(first.costUsd).toBeCloseTo(0.2);
    expect(first.cacheCreationInputTokens).toBe(500);
    expect(first.cacheReadInputTokens).toBe(4000);
    expect(second.runId).toBe(runA.id);
    expect(second.inputTokens).toBe(400);
    expect(second.outputTokens).toBe(40);
    expect(second.costUsd).toBeCloseTo(0.4);
    expect(second.cacheCreationInputTokens).toBe(1000);
    expect(second.cacheReadInputTokens).toBe(2000);

    // Per-phase: 'plan' has 2 calls (100+200=300 total, avg 150); 'generate' has 1 call (300 total, avg 300).
    const plan = agg.perPhase.find((p) => p.phase === 'plan');
    const generate = agg.perPhase.find((p) => p.phase === 'generate');
    expect(plan).toMatchObject({
      callCount: 2,
      avgInputTokens: 150,
      totalInputTokens: 300,
      avgCacheCreationInputTokens: 750,
      totalCacheCreationInputTokens: 1500,
      avgCacheReadInputTokens: 3000,
      totalCacheReadInputTokens: 6000,
    });
    expect(generate).toMatchObject({
      callCount: 1,
      avgInputTokens: 300,
      totalInputTokens: 300,
      avgCacheCreationInputTokens: null,
      totalCacheCreationInputTokens: null,
    });

    // Per-model: 'claude-sonnet-5' has 2 calls (100+200=300 total input); 'claude-haiku-4-5-20251001' has 1.
    const sonnet = agg.perModel.find((m) => m.model === 'claude-sonnet-5');
    const haiku = agg.perModel.find((m) => m.model === 'claude-haiku-4-5-20251001');
    expect(sonnet).toMatchObject({
      callCount: 2,
      totalInputTokens: 300,
      totalCacheCreationInputTokens: 1500,
      totalCacheReadInputTokens: 6000,
    });
    expect(haiku).toMatchObject({ callCount: 1, totalInputTokens: 300 });
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

  it('retrofits the usage table onto a pre-existing v10 database missing it', async () => {
    // Simulate a real pre-fix installation: a DB file already at user_version = 10
    // (the version already shipped on `dev` before this feature) with every table
    // that existed before this PR, but no `usage` table — built directly with a raw
    // connection, NOT via openDb()/getStore(), so the current SCHEMA_SQL (which
    // already includes `usage`) never runs against it first.
    const raw = new DatabaseSync(dbPath());
    try {
      raw.exec(PRE_V11_SCHEMA_SQL);
      raw.exec('PRAGMA user_version = 10;');
    } finally {
      raw.close(); // must close before the store opens its own handle on the same file
    }

    const s = await store();

    const info = await dbInfo();
    expect(info.version).toBe(21);
    expect(info.tables).toContain('usage');

    // Prove it's actually usable, not just present.
    const project = s.createProject({ name: 'retrofit-project', baseUrl: 'https://retrofit.test' });
    const run = s.createRun(project.id);
    expect(() =>
      s.recordUsage({
        runId: run.id,
        phase: 'plan',
        provider: 'claude',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
      }),
    ).not.toThrow();
    expect(s.listUsageForRun(run.id)).toHaveLength(1);
  });

  it('retrofits cache-token columns onto a pre-existing v11 database missing them', async () => {
    // Simulate a real pre-fix installation: a DB file already at user_version = 11
    // (usage table present, shipped by the token-usage-tracking feature) but WITHOUT
    // the cache_creation_input_tokens/cache_read_input_tokens columns this PR adds.
    const raw = new DatabaseSync(dbPath());
    try {
      raw.exec(PRE_V12_SCHEMA_SQL);
      raw.exec('PRAGMA user_version = 11;');
    } finally {
      raw.close();
    }

    const s = await store();

    const info = await dbInfo();
    expect(info.version).toBe(21);

    // Prove the retrofitted columns are actually usable, not just present.
    const project = s.createProject({ name: 'retrofit-v12-project', baseUrl: 'https://retrofit-v12.test' });
    const run = s.createRun(project.id);
    expect(() =>
      s.recordUsage({
        runId: run.id,
        phase: 'plan',
        provider: 'claude',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
        cacheCreationInputTokens: 50,
        cacheReadInputTokens: 150,
      }),
    ).not.toThrow();
    const rows = s.listUsageForRun(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cacheCreationInputTokens: 50, cacheReadInputTokens: 150 });
  });

  it('retrofits the model column onto a pre-existing v12 database missing it', async () => {
    // Simulate a real pre-fix installation: a DB file already at user_version = 12
    // (cache-token columns present) but WITHOUT the `model` column this PR adds.
    const raw = new DatabaseSync(dbPath());
    try {
      raw.exec(PRE_V13_SCHEMA_SQL);
      raw.exec('PRAGMA user_version = 12;');
    } finally {
      raw.close();
    }

    const s = await store();

    const info = await dbInfo();
    expect(info.version).toBe(21);

    // Prove the retrofitted column is actually usable, not just present.
    const project = s.createProject({ name: 'retrofit-v13-project', baseUrl: 'https://retrofit-v13.test' });
    const run = s.createRun(project.id);
    expect(() =>
      s.recordUsage({
        runId: run.id,
        phase: 'plan',
        provider: 'claude',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
        model: 'claude-sonnet-5',
      }),
    ).not.toThrow();
    const rows = s.listUsageForRun(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'claude-sonnet-5' });
  });
});
