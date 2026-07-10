import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

import { dbPath, deleteProjectAssets, getStore, projectsDir, resetStoreForTests } from '@healix/core';

/** Hermetic tests for project soft-archive and on-disk asset deletion. */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-archive-test-'));
  process.env.HEALIX_DATA_DIR = dataDir;
  resetStoreForTests();
});

afterEach(() => {
  resetStoreForTests();
  delete process.env.HEALIX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('project soft-archive', () => {
  it('archives and restores a project without touching its rows', async () => {
    const store = (await getStore())!;
    const p = store.createProject({ name: 'Archivable' });
    expect(p.archivedAt).toBeNull();

    store.setProjectArchived(p.id, true);
    const archived = store.getProject(p.id)!;
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.name).toBe('Archivable');

    store.setProjectArchived(p.id, false);
    expect(store.getProject(p.id)!.archivedAt).toBeNull();
  });

  it('migrates a pre-v3 database by adding the archived_at column', async () => {
    // Hand-build a v2-era DB: projects table WITHOUT archived_at.
    const db = new DatabaseSync(dbPath());
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'playwright',
        repo_path TEXT, base_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO projects (id, name) VALUES ('prj_old', 'Legacy');
      PRAGMA user_version = 2;
    `);
    db.close();

    const store = (await getStore())!;
    const legacy = store.getProject('prj_old')!;
    expect(legacy.name).toBe('Legacy');
    expect(legacy.archivedAt).toBeNull();

    store.setProjectArchived('prj_old', true);
    expect(store.getProject('prj_old')!.archivedAt).toBeTruthy();
  });
});

describe('deleteProjectAssets', () => {
  it('removes the project directory tree under projectsDir', async () => {
    const dir = join(projectsDir(), 'prj_gone', 'runs', 'run_1', 'suite', 'test-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'video.webm'), 'fake');

    await deleteProjectAssets('prj_gone');
    expect(existsSync(join(projectsDir(), 'prj_gone'))).toBe(false);
  });

  it('is a no-op for a project with no assets on disk', async () => {
    await expect(deleteProjectAssets('prj_never_existed')).resolves.toBeUndefined();
  });

  it('refuses ids that could escape the projects dir', async () => {
    await expect(deleteProjectAssets('../evil')).rejects.toThrow(/suspicious project id/);
    await expect(deleteProjectAssets('prj_okay/../..')).rejects.toThrow(/suspicious project id/);
    await expect(deleteProjectAssets('')).rejects.toThrow(/suspicious project id/);
  });
});
