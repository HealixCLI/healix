import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enrichSourceContextForPlan } from './deep-dive.js';
import { indexSource } from './source-index.js';
import type { SourceContext } from './source-context.js';
import type { TestPlanItem } from '../modes/types.js';

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-deep-dive-'));
  tempDirs.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function baseCtx(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    units: [],
    forms: [],
    authPatterns: [],
    selectorHints: [],
    specSources: [],
    summary: '',
    truncated: false,
    ...overrides,
  };
}

function item(unitKey: string | undefined): TestPlanItem {
  return {
    id: 'pli_1',
    title: 'Item',
    tier: 'tierC-api',
    intent: 'Intent.',
    scenarios: [{ kind: 'positive', description: 'ok' }],
    unitKey,
  };
}

describe('enrichSourceContextForPlan', () => {
  it('enriches a plan-referenced unit with status codes and thrown-error messages from its file', async () => {
    const dir = makeRepo();
    write(
      dir,
      'routes/users.js',
      `
        app.get('/users/:id', (req, res) => {
          if (!user) return res.status(404).send('not found');
          res.status(200).json(user);
        });
      `,
    );
    const ctx = baseCtx({
      units: [
        {
          key: 'endpoint:GET /users/:id',
          kind: 'endpoint',
          label: 'GET /users/:id',
          file: 'routes/users.js',
        },
      ],
    });

    const enriched = await enrichSourceContextForPlan(dir, ctx, [item('endpoint:GET /users/:id')]);

    expect(enriched.units[0].observedStatusCodes).toEqual([200, 404]);
    expect(enriched.units[0].thrownErrorMessages).toBeUndefined();
  });

  it('does not touch a unit that no plan item references', async () => {
    const dir = makeRepo();
    write(dir, 'routes/users.js', `app.get('/users', (req, res) => { res.status(200).send(); });`);
    write(dir, 'routes/orders.js', `app.get('/orders', (req, res) => { res.status(200).send(); });`);
    const ctx = baseCtx({
      units: [
        { key: 'endpoint:GET /users', kind: 'endpoint', label: 'GET /users', file: 'routes/users.js' },
        { key: 'endpoint:GET /orders', kind: 'endpoint', label: 'GET /orders', file: 'routes/orders.js' },
      ],
    });

    const enriched = await enrichSourceContextForPlan(dir, ctx, [item('endpoint:GET /users')]);

    expect(enriched.units.find((u) => u.key === 'endpoint:GET /users')?.observedStatusCodes).toEqual([200]);
    expect(enriched.units.find((u) => u.key === 'endpoint:GET /orders')?.observedStatusCodes).toBeUndefined();
  });

  it('returns the same ctx reference when no plan item has a unitKey', async () => {
    const dir = makeRepo();
    const ctx = baseCtx({
      units: [{ key: 'endpoint:GET /users', kind: 'endpoint', label: 'GET /users', file: 'routes/users.js' }],
    });

    const enriched = await enrichSourceContextForPlan(dir, ctx, [item(undefined)]);

    expect(enriched).toBe(ctx);
  });

  it('returns the same ctx reference when no unit matches the referenced unitKey', async () => {
    const dir = makeRepo();
    const ctx = baseCtx({
      units: [{ key: 'endpoint:GET /users', kind: 'endpoint', label: 'GET /users', file: 'routes/users.js' }],
    });

    const enriched = await enrichSourceContextForPlan(dir, ctx, [item('endpoint:GET /nonexistent')]);

    expect(enriched).toBe(ctx);
  });

  it("scopes each of two units backed by the SAME file to its own handler, never leaking a sibling handler's signals (regression for the file-level conflation bug)", async () => {
    const dir = makeRepo();
    write(
      dir,
      'routes/users.js',
      `
        router.get('/users', (req, res) => {
          res.status(200).json([]);
        });
        router.delete('/users/:id', (req, res) => {
          if (!found) return res.status(404).send('not found');
          res.status(204).send();
        });
      `,
    );
    const ctx = baseCtx({
      units: [
        { key: 'endpoint:GET /users', kind: 'endpoint', label: 'GET /users', file: 'routes/users.js' },
        {
          key: 'endpoint:DELETE /users/:id',
          kind: 'endpoint',
          label: 'DELETE /users/:id',
          file: 'routes/users.js',
        },
      ],
    });

    const enriched = await enrichSourceContextForPlan(dir, ctx, [
      item('endpoint:GET /users'),
      item('endpoint:DELETE /users/:id'),
    ]);

    const getUnit = enriched.units.find((u) => u.key === 'endpoint:GET /users');
    const deleteUnit = enriched.units.find((u) => u.key === 'endpoint:DELETE /users/:id');
    // Before the fix, both units (sharing one file) would have received the UNION of every
    // handler's status codes in the file ([200, 204, 404] on both) — each must now see only its
    // own handler's signals instead.
    expect(getUnit?.observedStatusCodes).toEqual([200]);
    expect(deleteUnit?.observedStatusCodes).toEqual([204, 404]);
  });

  it('is best-effort: an unreadable/missing file does not throw and just leaves that unit unenriched', async () => {
    const dir = makeRepo();
    const ctx = baseCtx({
      units: [{ key: 'endpoint:GET /gone', kind: 'endpoint', label: 'GET /gone', file: 'routes/gone.js' }],
    });

    await expect(enrichSourceContextForPlan(dir, ctx, [item('endpoint:GET /gone')])).resolves.toBeDefined();
    const enriched = await enrichSourceContextForPlan(dir, ctx, [item('endpoint:GET /gone')]);
    expect(enriched.units[0].observedStatusCodes).toBeUndefined();
  });
});

// --- Isolated check against a real fixture repo, combining indexSource() + the deep-dive pass ---
// Same environment-conditional pattern as source-index.test.ts/context-store.test.ts's RBAC_ROOT
// checks — skips cleanly when the fixture isn't cloned locally, rather than failing CI on a path
// that only exists on one contributor's machine.

const RBAC_ROOT = path.join(
  'C:',
  'Users',
  'AdroyFernandes',
  'Documents',
  'TestApps',
  'Role-Based-Access-Control-RBAC-',
);

describe.skipIf(!fs.existsSync(RBAC_ROOT))(
  'enrichSourceContextForPlan against the real RBAC repo (isolated check)',
  () => {
    it('extracts real handler-level signals for a plan item targeting a real endpoint, without touching untargeted units', async () => {
      const ctx = await indexSource(RBAC_ROOT, { maxUnits: 500 });
      const targetKey = 'endpoint:GET /api/users/:id';
      expect(ctx.units.some((u) => u.key === targetKey)).toBe(true);

      const otherUnit = ctx.units.find((u) => u.key !== targetKey);
      const planItems: TestPlanItem[] = [
        {
          id: 'pli_1',
          title: 'Get user by id',
          tier: 'tierC-api',
          intent: 'Returns the user.',
          scenarios: [{ kind: 'positive', description: 'ok' }],
          unitKey: targetKey,
        },
      ];

      const enriched = await enrichSourceContextForPlan(RBAC_ROOT, ctx, planItems);
      const targetUnit = enriched.units.find((u) => u.key === targetKey);
      expect(targetUnit).toBeDefined();

      // Deep-dive is best-effort and the exact handler body isn't asserted byte-for-byte here —
      // but WHATEVER it found (if anything) must be real, plausible HTTP status codes, and a
      // unit this run never targeted must be completely untouched by the pass.
      if (targetUnit?.observedStatusCodes) {
        for (const code of targetUnit.observedStatusCodes) {
          expect(code).toBeGreaterThanOrEqual(100);
          expect(code).toBeLessThan(600);
        }
      }
      if (otherUnit) {
        const untouchedOther = enriched.units.find((u) => u.key === otherUnit.key);
        expect(untouchedOther?.observedStatusCodes).toBeUndefined();
        expect(untouchedOther?.thrownErrorMessages).toBeUndefined();
      }
    });
  },
);
