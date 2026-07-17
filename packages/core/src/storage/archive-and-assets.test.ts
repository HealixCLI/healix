import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

import {
  dbPath,
  deleteProjectAssets,
  deleteRunAssets,
  getStore,
  projectsDir,
  resetStoreForTests,
} from '@healix/core';

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
    const p = store.createProject({ name: 'Archivable', baseUrl: 'https://archivable.test' });
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

describe('deleteRunAssets', () => {
  it("removes only the given run's directory, leaving a sibling run untouched", async () => {
    const targetDir = join(projectsDir(), 'prj_keep', 'runs', 'run_gone', 'suite', 'test-results');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'video.webm'), 'fake');
    const siblingDir = join(projectsDir(), 'prj_keep', 'runs', 'run_keep');
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(siblingDir, 'marker.txt'), 'fake');

    await deleteRunAssets('prj_keep', 'run_gone');
    expect(existsSync(join(projectsDir(), 'prj_keep', 'runs', 'run_gone'))).toBe(false);
    expect(existsSync(join(siblingDir, 'marker.txt'))).toBe(true);
  });

  it('is a no-op for a run with no assets on disk', async () => {
    await expect(deleteRunAssets('prj_never_existed', 'run_never_existed')).resolves.toBeUndefined();
  });

  it("refuses ids that could escape the run's own directory", async () => {
    await expect(deleteRunAssets('../evil', 'run_1')).rejects.toThrow(/suspicious project id/);
    await expect(deleteRunAssets('prj_okay', '../evil')).rejects.toThrow(/suspicious run id/);
    await expect(deleteRunAssets('prj_okay', 'run_okay/../..')).rejects.toThrow(/suspicious run id/);
    await expect(deleteRunAssets('prj_okay', '')).rejects.toThrow(/suspicious run id/);
  });
});
