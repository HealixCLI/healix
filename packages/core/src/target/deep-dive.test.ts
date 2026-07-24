import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enrichSourceContextForPlan } from './deep-dive.js';
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
      units: [{ key: 'endpoint:GET /users/:id', kind: 'endpoint', label: 'GET /users/:id', file: 'routes/users.js' }],
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
