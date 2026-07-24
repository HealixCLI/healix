import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearExplorationCache, loadExplorationCache, persistExplorationCache } from './exploration-cache.js';
import { projectsDir } from '../env/app-data.js';
import type { ExplorationArtifact } from '../modes/types.js';

let dataDir: string;
const prevDataDir = process.env.HEALIX_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-exploration-cache-'));
  process.env.HEALIX_DATA_DIR = dataDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevDataDir === undefined) {
    delete process.env.HEALIX_DATA_DIR;
  } else {
    process.env.HEALIX_DATA_DIR = prevDataDir;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function sampleArtifact(overrides: Partial<ExplorationArtifact> = {}): ExplorationArtifact {
  return {
    crawl: {
      routes: [],
      visitedCount: 0,
      budgetExhausted: false,
      redirectLoopsDetected: [],
      shellCollapsed: false,
      degenerateRedirectsSkipped: [],
      authAttempted: false,
      authVerified: false,
    },
    routing: { hashRouted: false },
    loginCandidates: [],
    useful: true,
    observedEndpoints: [],
    ...overrides,
  };
}

describe('persistExplorationCache / loadExplorationCache', () => {
  it('round-trips an artifact for the same project + baseUrl', () => {
    const artifact = sampleArtifact({ useful: false, uselessReason: 'zero routes' });
    persistExplorationCache('prj_test', 'https://app.example.test', artifact);
    expect(loadExplorationCache('prj_test', 'https://app.example.test')).toEqual(artifact);
  });

  it('returns null when nothing has been cached yet', () => {
    expect(loadExplorationCache('prj_test', 'https://app.example.test')).toBeNull();
  });

  it('returns null when the requested baseUrl differs from the cached one (app moved / URL changed)', () => {
    persistExplorationCache('prj_test', 'https://old.example.test', sampleArtifact());
    expect(loadExplorationCache('prj_test', 'https://new.example.test')).toBeNull();
  });

  it("scopes the cache per project — a different projectId never sees another project's cache", () => {
    persistExplorationCache('prj_a', 'https://app.example.test', sampleArtifact());
    expect(loadExplorationCache('prj_b', 'https://app.example.test')).toBeNull();
  });

  it('returns null once the cache is outside the staleness window', () => {
    const artifact = sampleArtifact();
    persistExplorationCache('prj_test', 'https://app.example.test', artifact);
    // A maxAgeMs of 0 makes anything already-persisted immediately stale.
    expect(loadExplorationCache('prj_test', 'https://app.example.test', 0)).toBeNull();
  });

  it('respects a custom staleness window when still within it', () => {
    const artifact = sampleArtifact();
    persistExplorationCache('prj_test', 'https://app.example.test', artifact);
    expect(loadExplorationCache('prj_test', 'https://app.example.test', 60_000)).toEqual(artifact);
  });

  it('returns null for a malformed/corrupted cache file rather than throwing', () => {
    persistExplorationCache('prj_test', 'https://app.example.test', sampleArtifact());
    // Overwrite with garbage after a valid persist to hit the same file path.
    const abs = path.join(projectsDir(), 'prj_test', 'exploration-cache.json');
    fs.writeFileSync(abs, 'not valid json {{{', 'utf-8');
    expect(() => loadExplorationCache('prj_test', 'https://app.example.test')).not.toThrow();
    expect(loadExplorationCache('prj_test', 'https://app.example.test')).toBeNull();
  });

  it('swallows a write failure rather than throwing (best-effort persistence)', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() =>
      persistExplorationCache('prj_test', 'https://app.example.test', sampleArtifact()),
    ).not.toThrow();
  });
});

describe('clearExplorationCache', () => {
  it('removes a previously persisted cache, so a subsequent load is a clean miss', () => {
    persistExplorationCache('prj_test', 'https://app.example.test', sampleArtifact());
    expect(loadExplorationCache('prj_test', 'https://app.example.test')).not.toBeNull();

    clearExplorationCache('prj_test');
    expect(loadExplorationCache('prj_test', 'https://app.example.test')).toBeNull();
  });

  it('is a no-op (never throws) when there is nothing to clear', () => {
    expect(() => clearExplorationCache('prj_never_cached')).not.toThrow();
  });
});
