import { createRequire } from 'node:module';
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
