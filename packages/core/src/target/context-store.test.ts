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
  it('round-trips a context through .healix/source-context.json', () => {
    const dir = makeDir();
    const ctx = sampleContext();
    persistSourceContext(dir, ctx);

    expect(fs.existsSync(path.join(dir, '.healix', 'source-context.json'))).toBe(true);
    expect(loadSourceContext(dir)).toEqual(ctx);
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
    persistSourceContext(dir, ctx);
    const loaded = loadSourceContext(dir);
    expect(loaded?.forms.length).toBe(50);
    expect(loaded?.authPatterns.length).toBe(50);
    expect(loaded?.selectorHints.length).toBe(200);
  });

  it('swallows a write failure rather than throwing (best-effort persistence)', () => {
    const dir = makeDir();
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => persistSourceContext(dir, sampleContext())).not.toThrow();
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

      persistSourceContext(scratch, ctx);
      const loaded = loadSourceContext(scratch);

      expect(loaded).not.toBeNull();
      expect(loaded?.units.length).toBeGreaterThan(0);
      expect(loaded?.units.map((u) => u.key)).toContain('endpoint:GET /api/users/:id');
      expect(loaded?.authPatterns.some((a) => a.libraries.includes('jsonwebtoken'))).toBe(true);
    });
  },
);
