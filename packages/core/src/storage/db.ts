import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { dbPath, ensureAppDataDir } from '../env/app-data.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { logger } from '../logger.js';

export interface DbInfo {
  available: boolean;
  path: string;
  version: number;
  tables: string[];
  driver: string;
  detail: string;
}

let instance: DatabaseSync | null = null;
let warningSuppressed = false;

/** Silence only the "SQLite is an experimental feature" notice; leave all other warnings intact. */
function suppressSqliteExperimentalWarning(): void {
  if (warningSuppressed) return;
  warningSuppressed = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === 'string' ? warning : (warning?.message ?? '');
    if (msg.includes('SQLite is an experimental feature')) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

async function loadDriver(): Promise<typeof DatabaseSync | null> {
  suppressSqliteExperimentalWarning();
  // Prefer a native dynamic import (works under plain Node / Electron). Some bundled
  // test runtimes (e.g. vite-node) don't recognise node:sqlite as a builtin and fail
  // to resolve it, so fall back to createRequire which bypasses the module graph and
  // loads the real native module directly.
  try {
    const mod = await import('node:sqlite');
    return mod.DatabaseSync;
  } catch {
    try {
      const require = createRequire(import.meta.url);
      const mod = require('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
      return mod.DatabaseSync;
    } catch (e) {
      logger.warn('node:sqlite unavailable in this runtime:', (e as { code?: string }).code ?? String(e));
      return null;
    }
  }
}

/** Open (and lazily migrate) the local SQLite database. Returns null if the runtime lacks node:sqlite. */
export async function openDb(): Promise<DatabaseSync | null> {
  if (instance) return instance;
  const Driver = await loadDriver();
  if (!Driver) return null;
  ensureAppDataDir();
  const db = new Driver(dbPath());
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  instance = db;
  return db;
}

/**
 * Test-only seam: close the open database (if any) and clear the cached singleton
 * so a subsequent openDb() re-derives its path from the current HEALIX_DATA_DIR.
 */
export function resetDbForTests(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/** Add a column if the table doesn't have it yet (CREATE IF NOT EXISTS can't retrofit). */
function ensureColumn(db: DatabaseSync, table: string, column: string, ddlType: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType};`);
}

function migrate(db: DatabaseSync): void {
  if (readUserVersion(db) < SCHEMA_VERSION) {
    db.exec(SCHEMA_SQL);
    // v3: soft-archive flag on projects (pre-v3 DBs already have the table,
    // so the CREATE above won't add the column).
    ensureColumn(db, 'projects', 'archived_at', 'TEXT');
    // v4: optional test credentials (login identifier + password) for
    // authenticated (tierB) flows.
    ensureColumn(db, 'projects', 'test_username', 'TEXT');
    ensureColumn(db, 'projects', 'test_password', 'TEXT');
    // v5: top-up/reuse suite generation — which mode a run used, which prior
    // run it built on, and which spec file backs each test (so a later run
    // can copy a test's file forward instead of regenerating it).
    ensureColumn(db, 'runs', 'suite_mode', 'TEXT');
    ensureColumn(db, 'runs', 'base_run_id', 'TEXT');
    ensureColumn(db, 'tests', 'spec_path', 'TEXT');
    // v6: pause/resume — why a 'paused' run stopped (manual | network |
    // credits-exhausted | crashed). Drives whether boot-time reconciliation
    // is allowed to auto-resume it (never for 'manual').
    ensureColumn(db, 'runs', 'pause_reason', 'TEXT');
    // v8: url/token-based credentials (no login form — the app authenticates
    // a visit whose URL already carries a token/params) alongside the
    // existing form-login credentials. Existing rows default to 'form' via
    // the column default, unchanged behavior. Runs BEFORE the v7 legacy-copy
    // step below, since that step's INSERT names this column explicitly.
    ensureColumn(db, 'project_credentials', 'auth_type', "TEXT NOT NULL DEFAULT 'form'");
    ensureColumn(db, 'project_credentials', 'token', 'TEXT');
    ensureColumn(db, 'project_credentials', 'url_template', 'TEXT');
    ensureColumn(db, 'project_credentials', 'extra_params', 'TEXT');
    ensureColumn(db, 'project_credentials', 'auth_check_text', 'TEXT');
    // v9: description/details — plan-time scenario description and feature intent,
    // persisted onto the test case (and mirrored onto its result) so a reviewer
    // can see what a test verifies without cross-referencing the original plan.
    ensureColumn(db, 'tests', 'description', 'TEXT');
    ensureColumn(db, 'tests', 'details', 'TEXT');
    ensureColumn(db, 'results', 'description', 'TEXT');
    ensureColumn(db, 'results', 'details', 'TEXT');
    // v10: steps_json — per-test action/assertion breakdown (click, fill,
    // navigate, assert...) captured by the custom Playwright reporter (see
    // templates.ts's stepsReporterContents()), present for both passed and
    // failed tests, not just failures.
    ensureColumn(db, 'results', 'steps_json', 'TEXT');
    // v11: usage table (per-call token/cost tracking) — no ensureColumn needed
    // here; it's a brand-new table, so the CREATE TABLE IF NOT EXISTS already
    // inside SCHEMA_SQL (executed unconditionally above, within this same
    // version-gated block) is sufficient to retrofit it onto an existing DB.
    // v12: cache-read/cache-creation token counts on the usage table, added to
    // an existing usage table via ensureColumn (the CREATE above only helps
    // fresh installs).
    ensureColumn(db, 'usage', 'cache_creation_input_tokens', 'INTEGER');
    ensureColumn(db, 'usage', 'cache_read_input_tokens', 'INTEGER');
    // v13: model — the dominant modelUsage entry that served each call, added
    // to an existing usage table via ensureColumn (the CREATE above only
    // helps fresh installs).
    ensureColumn(db, 'usage', 'model', 'TEXT');
    // v14: spec_code on tests (the generated spec's full source, added via
    // ensureColumn for existing DBs) + the new triage_results table — no
    // ensureColumn needed for the table itself, same reasoning as v11's usage
    // table: CREATE TABLE IF NOT EXISTS already retrofits it.
    ensureColumn(db, 'tests', 'spec_code', 'TEXT');
    // v15: skip_reason on results — QA-requested visibility into WHY a
    // skipped test was skipped (Playwright's own test.skip(cond,
    // 'reason')/test.fixme(...) annotation description, when given), added
    // via ensureColumn for existing DBs.
    ensureColumn(db, 'results', 'skip_reason', 'TEXT');
    // v16: verdict_source on triage_results — 'ai_reviewed' vs 'rule_fallback',
    // added via ensureColumn for existing DBs. Lets a resumed run reconstruct
    // a persisted verdict's provenance instead of guessing, and surfaces to
    // users whether a verdict was genuinely AI-reviewed or fell back to the
    // deterministic rule baseline (AI call errored/timed out/unparseable).
    ensureColumn(db, 'triage_results', 'verdict_source', 'TEXT');
    // v17: video_unavailable_reason on results — explicit, human-readable
    // explanation for WHY a video isn't present for an executed test
    // (tierC-api tests never open a browser page; a blank/near-empty
    // recording was discarded as unusable; or, genuinely anomalously, no
    // video attachment at all for a browser-based test), added via
    // ensureColumn for existing DBs so a missing video is never a silent gap.
    ensureColumn(db, 'results', 'video_unavailable_reason', 'TEXT');
    // v18: plan_kb_items/plan_kb_scenarios (Retry-pass/coverage-loop
    // Knowledge Base) — brand-new tables, no ensureColumn needed; same
    // reasoning as v11's usage table: CREATE TABLE IF NOT EXISTS already
    // retrofits them onto an existing DB.
    // v19: kb_test_scripts (per-KB-item source file path) — brand-new table,
    // no ensureColumn needed; same reasoning as v11/v18.
    // v20: kb_execution_artifacts (per-KB-scenario error/trace/steps/network
    // logs) — brand-new table, no ensureColumn needed; same reasoning as
    // v11/v18/v19.
    // v21: KB foundation (requirements/mock_responses/test_mock_usage/
    // exploration_summaries/escape_hatch_gaps) — all brand-new tables, no
    // ensureColumn needed for them; same reasoning as v11/v18/v19/v20. Two
    // columns on EXISTING tables do need ensureColumn, since CREATE TABLE IF
    // NOT EXISTS can't retrofit a column onto a table that already exists:
    ensureColumn(db, 'plan_kb_items', 'requirement_id', 'TEXT');
    ensureColumn(db, 'results', 'evidence_json', 'TEXT');
    // v7: multiple named test credentials per project (project_credentials
    // table, created above via SCHEMA_SQL) replacing the single
    // test_username/test_password pair. Copy any existing single credential
    // forward as a roleless row so it isn't lost; the value is copied as-is
    // (already encrypted, or legacy plaintext) since project_credentials.password
    // is read back through the exact same decryptSecret() convention.
    // test_username/test_password are never cleared after copying, so this
    // guards against re-inserting a duplicate on every later migration pass
    // by skipping any project that already has at least one credential row.
    const legacyProjects = db
      .prepare(
        `SELECT id, test_username, test_password FROM projects
         WHERE (test_username IS NOT NULL OR test_password IS NOT NULL)
           AND id NOT IN (SELECT project_id FROM project_credentials)`,
      )
      .all() as Array<{ id: string; test_username: string | null; test_password: string | null }>;
    for (const p of legacyProjects) {
      db.prepare(
        "INSERT INTO project_credentials (id, project_id, username, password, role, auth_type, sort_order, created_at) VALUES (?, ?, ?, ?, NULL, 'form', 0, datetime('now'))",
      ).run(`cred_${randomUUID()}`, p.id, p.test_username ?? '', p.test_password ?? '');
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    logger.info(`Database migrated to schema v${SCHEMA_VERSION}`);
  }
}

/** Report storage status (used by `healix doctor`). */
export async function dbInfo(): Promise<DbInfo> {
  const base: DbInfo = {
    available: false,
    path: dbPath(),
    version: 0,
    tables: [],
    driver: 'node:sqlite',
    detail: '',
  };
  const db = await openDb();
  if (!db) {
    return {
      ...base,
      detail: 'node:sqlite unavailable (needs Node >=22.5 or a compatible Electron runtime).',
    };
  }
  const version = readUserVersion(db);
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  return { ...base, available: true, version, tables, detail: 'OK' };
}
