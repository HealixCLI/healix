import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Resolve the OS-specific Healix application-data directory (no side effects). */
export function appDataDir(): string {
  const override = process.env.HEALIX_DATA_DIR;
  if (override !== undefined && override !== '') {
    return resolve(override);
  }
  const home = homedir();
  const p = platform();
  let base: string;
  if (p === 'darwin') {
    base = join(home, 'Library', 'Application Support');
  } else if (p === 'win32') {
    base = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  } else {
    base = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  }
  return join(base, 'Healix');
}

/** Ensure the app-data directory exists and return its path. */
export function ensureAppDataDir(): string {
  const dir = appDataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectsDir(): string {
  return join(appDataDir(), 'projects');
}

export function dbPath(): string {
  return join(appDataDir(), 'healix.db');
}
