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
  try {
    suppressSqliteExperimentalWarning();
    const mod = await import('node:sqlite');
    return mod.DatabaseSync;
  } catch (e) {
    logger.warn('node:sqlite unavailable in this runtime:', (e as { code?: string }).code ?? String(e));
    return null;
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

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

function migrate(db: DatabaseSync): void {
  if (readUserVersion(db) < SCHEMA_VERSION) {
    db.exec(SCHEMA_SQL);
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
    return { ...base, detail: 'node:sqlite unavailable (needs Node >=22.5 or a compatible Electron runtime).' };
  }
  const version = readUserVersion(db);
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  return { ...base, available: true, version, tables, detail: 'OK' };
}
