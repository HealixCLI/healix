import { describe, expect, it } from 'vitest';
import { extractHandlerSignals } from './handler-signals.js';

describe('extractHandlerSignals', () => {
  it('extracts res.status(N) calls (Express)', () => {
    const source = `
      app.get('/users/:id', (req, res) => {
        if (!user) return res.status(404).send('not found');
        res.status(200).json(user);
      });
    `;
    const signals = extractHandlerSignals('routes/users.js', source);
    expect(signals?.observedStatusCodes).toEqual([200, 404]);
  });

  it('extracts reply.code(N) calls (Fastify)', () => {
    const source = `
      fastify.get('/health', async (req, reply) => {
        reply.code(503).send({ ok: false });
      });
    `;
    const signals = extractHandlerSignals('routes/health.js', source);
    expect(signals?.observedStatusCodes).toEqual([503]);
  });

  it('extracts ctx.status assignment (Koa)', () => {
    const source = `
      router.get('/secure', async (ctx) => {
        ctx.status = 401;
      });
    `;
    const signals = extractHandlerSignals('routes/secure.js', source);
    expect(signals?.observedStatusCodes).toEqual([401]);
  });

  it("does not treat an unrelated object's .status(N) call as a response signal", () => {
    const source = `
      const badge = new Badge();
      badge.status(1);
    `;
    const signals = extractHandlerSignals('unrelated.js', source);
    expect(signals?.observedStatusCodes).toEqual([]);
  });

  it('extracts thrown Error and custom *Error subclass messages', () => {
    const source = `
      function validate(input) {
        if (!input) throw new Error('input is required');
        if (input.length > 100) throw new ValidationError('input too long');
      }
    `;
    const signals = extractHandlerSignals('lib/validate.js', source);
    expect(signals?.thrownErrorMessages).toEqual(['input is required', 'input too long']);
  });

  it('dedupes repeated status codes and error messages', () => {
    const source = `
      app.get('/a', (req, res) => { res.status(400).send(); });
      app.get('/b', (req, res) => {
        res.status(400).send();
        throw new Error('bad');
      });
      function again() { throw new Error('bad'); }
    `;
    const signals = extractHandlerSignals('routes/dupe.js', source);
    expect(signals?.observedStatusCodes).toEqual([400]);
    expect(signals?.thrownErrorMessages).toEqual(['bad']);
  });

  it('reports empty arrays for a file with neither signal', () => {
    const source = `export function add(a, b) { return a + b; }`;
    const signals = extractHandlerSignals('math.ts', source);
    expect(signals).toEqual({ file: 'math.ts', observedStatusCodes: [], thrownErrorMessages: [] });
  });

  it('returns null (not a throw) on malformed source', () => {
    expect(() => extractHandlerSignals('broken.ts', 'function ( { [[[')).not.toThrow();
    expect(extractHandlerSignals('broken.ts', 'function ( { [[[')).toBeNull();
  });
});
