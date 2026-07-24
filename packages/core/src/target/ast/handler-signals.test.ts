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
    expect(signals).toEqual({
      file: 'math.ts',
      observedStatusCodes: [],
      thrownErrorMessages: [],
      scoped: false,
    });
  });

  it('returns null (not a throw) on malformed source', () => {
    expect(() => extractHandlerSignals('broken.ts', 'function ( { [[[')).not.toThrow();
    expect(extractHandlerSignals('broken.ts', 'function ( { [[[')).toBeNull();
  });

  it('marks a whole-file (no method/path given) scan as not scoped', () => {
    const signals = extractHandlerSignals(
      'routes/users.js',
      "app.get('/users', (req, res) => res.status(200));",
    );
    expect(signals?.scoped).toBe(false);
  });

  describe('method/fullPath-scoped extraction (regression for the file-level status/error leak)', () => {
    const source = `
      router.get('/users', (req, res) => {
        res.status(200).json([]);
      });
      router.delete('/users/:id', (req, res) => {
        if (!found) return res.status(404).send('not found');
        res.status(204).send();
      });
    `;

    it("scopes GET /users to only its own handler's signals, not DELETE's", () => {
      const signals = extractHandlerSignals('routes/users.js', source, 'GET', '/users');
      expect(signals?.scoped).toBe(true);
      expect(signals?.observedStatusCodes).toEqual([200]);
      expect(signals?.thrownErrorMessages).toEqual([]);
    });

    it("scopes DELETE /users/:id to only its own handler's signals, not GET's", () => {
      const signals = extractHandlerSignals('routes/users.js', source, 'DELETE', '/users/:id');
      expect(signals?.scoped).toBe(true);
      expect(signals?.observedStatusCodes).toEqual([204, 404]);
    });

    it('resolves a mount-prefixed fullPath by matching the local pathSuffix at the end', () => {
      // This file only ever registers '/users' locally; the unit's fullPath carries a mount
      // prefix (e.g. from app.use('/api', usersRouter) in a different file) this file never sees.
      const signals = extractHandlerSignals('routes/users.js', source, 'GET', '/api/users');
      expect(signals?.scoped).toBe(true);
      expect(signals?.observedStatusCodes).toEqual([200]);
    });

    it('resolves a same-file named handler function reference, not just an inline arrow', () => {
      const named = `
        function getUser(req, res) {
          if (!user) throw new NotFoundError('no such user');
          res.status(200).json(user);
        }
        function deleteUser(req, res) {
          res.status(410).send();
        }
        router.get('/users/:id', getUser);
        router.delete('/users/:id', deleteUser);
      `;
      const signals = extractHandlerSignals('routes/named.js', named, 'GET', '/users/:id');
      expect(signals?.scoped).toBe(true);
      expect(signals?.observedStatusCodes).toEqual([200]);
      expect(signals?.thrownErrorMessages).toEqual(['no such user']);
    });

    it('falls back to a whole-file scan (scoped: false) when no registration matches method/fullPath', () => {
      const signals = extractHandlerSignals('routes/users.js', source, 'POST', '/users');
      expect(signals?.scoped).toBe(false);
      // Whole-file fallback still finds every status code in the file, from both handlers.
      expect(signals?.observedStatusCodes).toEqual([200, 204, 404]);
    });

    it('falls back to a whole-file scan when the handler reference cannot be resolved in this file (e.g. imported)', () => {
      const imported = `
        const { getUser } = require('./handlers');
        router.get('/users/:id', getUser);
        function unrelated() { res.status(500).send(); }
      `;
      const signals = extractHandlerSignals('routes/imported.js', imported, 'GET', '/users/:id');
      expect(signals?.scoped).toBe(false);
    });
  });
});
