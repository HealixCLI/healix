import { homedir, platform } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';

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

/** Root for repos cloned from a git URL passed into a project's "Repo path" field. */
export function reposDir(): string {
  return join(appDataDir(), 'repos');
}

export function dbPath(): string {
  return join(appDataDir(), 'healix.db');
}

/**
 * Irreversibly remove a project's on-disk assets (runs, suites, reports, media).
 * The id must look like a Healix project id and resolve strictly inside the
 * projects dir — a malformed id must never turn into an `rm -rf` elsewhere.
 */
export async function deleteProjectAssets(projectId: string): Promise<void> {
  if (!/^prj_[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error(`Refusing to delete assets for suspicious project id: ${JSON.stringify(projectId)}`);
  }
  const root = resolve(projectsDir());
  const target = resolve(join(root, projectId));
  if (!target.startsWith(root + sep)) {
    throw new Error(`Refusing to delete assets outside the projects dir: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}
