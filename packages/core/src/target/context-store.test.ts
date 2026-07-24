import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSourceContext, persistSourceContext } from './context-store.js';
import type { SourceContext } from './source-context.js';
import { indexSource } from './source-index.js';

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-context-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sampleContext(overrides?: Partial<SourceContext>): SourceContext {
  return {
    units: [{ key: 'route:/home', kind: 'route', label: 'route: /home', file: 'src/App.tsx' }],
    forms: [],
    authPatterns: [],
    selectorHints: [],
    specSources: [],
    summary: 'Detected functionality: 1 route(s), 0 endpoint(s).',
    truncated: false,
    ...overrides,
  };
}

describe('persistSourceContext / loadSourceContext', () => {
  it('round-trips a context (and its hash) through .healix/source-context.json', () => {
    const dir = makeDir();
    const ctx = sampleContext();
    persistSourceContext(dir, 'hash-abc123', ctx);

    expect(fs.existsSync(path.join(dir, '.healix', 'source-context.json'))).toBe(true);
    expect(loadSourceContext(dir)).toEqual({ hash: 'hash-abc123', context: ctx });
  });

  it('returns null when nothing has been persisted yet', () => {
    const dir = makeDir();
    expect(loadSourceContext(dir)).toBeNull();
  });

  it('returns null for a malformed/corrupted persisted file rather than throwing', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, '.healix'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.healix', 'source-context.json'), 'not valid json {{{', 'utf-8');
    expect(() => loadSourceContext(dir)).not.toThrow();
    expect(loadSourceContext(dir)).toBeNull();
  });

  it('returns null for a legacy pre-envelope file (bare SourceContext, no hash/context wrapper)', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, '.healix'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.healix', 'source-context.json'),
      JSON.stringify(sampleContext()),
      'utf-8',
    );
    expect(loadSourceContext(dir)).toBeNull();
  });

  it('caps forms/authPatterns/selectorHints at persistence time', () => {
    const dir = makeDir();
    const ctx = sampleContext({
      forms: Array.from({ length: 60 }, (_, i) => ({ file: `f${i}.tsx`, fields: [] })),
      authPatterns: Array.from({ length: 60 }, (_, i) => ({
        file: `a${i}.ts`,
        libraries: [],
        routeGuards: [],
      })),
      selectorHints: Array.from({ length: 250 }, (_, i) => ({
        file: `s${i}.tsx`,
        attribute: 'data-testid' as const,
        value: `hint-${i}`,
      })),
    });
    persistSourceContext(dir, 'hash-abc123', ctx);
    const loaded = loadSourceContext(dir);
    expect(loaded?.context.forms.length).toBe(50);
    expect(loaded?.context.authPatterns.length).toBe(50);
    expect(loaded?.context.selectorHints.length).toBe(200);
  });

  it('swallows a write failure rather than throwing (best-effort persistence)', () => {
    const dir = makeDir();
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => persistSourceContext(dir, 'hash-abc123', sampleContext())).not.toThrow();
  });

  describe('hash-based cache invalidation', () => {
    it('hash change forces recompute: different hash means cached context is not reused', () => {
      const dir = makeDir();
      const ctx1 = sampleContext({
        units: [{ key: 'route:/v1', kind: 'route', label: 'route: /v1', file: 'src/v1.tsx' }],
      });
      persistSourceContext(dir, 'hash-v1', ctx1);

      const loaded = loadSourceContext(dir);
      expect(loaded?.hash).toBe('hash-v1');
      expect(loaded?.context.units[0]?.key).toBe('route:/v1');

      // Simulate a hash change (e.g., file modified)
      const ctx2 = sampleContext({
        units: [{ key: 'route:/v2', kind: 'route', label: 'route: /v2', file: 'src/v2.tsx' }],
      });
      persistSourceContext(dir, 'hash-v2', ctx2);

      const reloaded = loadSourceContext(dir);
      expect(reloaded?.hash).toBe('hash-v2');
      expect(reloaded?.context.units[0]?.key).toBe('route:/v2');
    });

    it('unchanged hash skips recompute: same hash means cached context can be reused', () => {
      const dir = makeDir();
      const ctx = sampleContext();
      const hash = 'hash-stable';

      persistSourceContext(dir, hash, ctx);
      const firstLoad = loadSourceContext(dir);

      // Simulate a second load with the same hash - should return the same cached context
      const secondLoad = loadSourceContext(dir);

      expect(firstLoad?.hash).toBe(secondLoad?.hash);
      expect(firstLoad?.context.units).toEqual(secondLoad?.context.units);
    });
  });
});

// --- Isolated check against real fixture data (Item D2) --------------------
// Uses indexSource() against the real RBAC repo (read-only) to get rich, real content, then
// persists/reloads it into a scratch temp directory rather than the fixture repo itself, so this
// check never writes into TestApps.

const RBAC_ROOT = path.join(
  'C:',
  'Users',
  'AdroyFernandes',
  'Documents',
  'TestApps',
  'Role-Based-Access-Control-RBAC-',
);

describe.skipIf(!fs.existsSync(RBAC_ROOT))(
  'persistSourceContext/loadSourceContext against real RBAC-derived context (isolated check)',
  () => {
    it('round-trips a real, rich SourceContext with sane structure', async () => {
      const ctx = await indexSource(RBAC_ROOT, { maxUnits: 500 });
      const scratch = makeDir();

      persistSourceContext(scratch, 'hash-abc123', ctx);
      const loaded = loadSourceContext(scratch);

      expect(loaded).not.toBeNull();
      expect(loaded?.hash).toBe('hash-abc123');
      expect(loaded?.context.units.length).toBeGreaterThan(0);
      expect(loaded?.context.units.map((u) => u.key)).toContain('endpoint:GET /api/users/:id');
      expect(loaded?.context.authPatterns.some((a) => a.libraries.includes('jsonwebtoken'))).toBe(true);
    });
  },
);
