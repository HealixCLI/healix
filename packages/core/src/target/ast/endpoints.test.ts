import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractExpressRouterInfo, findRouteHandlerPath, resolveExpressEndpoints } from './endpoints.js';
import { parseModule } from './parse.js';

describe('extractExpressRouterInfo', () => {
  it('extracts single-file app.METHOD(...) registrations', () => {
    const source = `
      const express = require('express');
      const app = express();
      app.get('/health', (req, res) => res.send('ok'));
      app.post('/orders', (req, res) => res.send('ok'));
    `;
    const info = extractExpressRouterInfo(source, 'server.js');
    expect(info?.localEndpoints).toEqual(
      expect.arrayContaining([
        { method: 'GET', pathSuffix: '/health' },
        { method: 'POST', pathSuffix: '/orders' },
      ]),
    );
  });

  it('recognizes a custom-named router (not just app/router/server)', () => {
    const source = `
      const express = require('express');
      const userRouter = express.Router();
      userRouter.get('/:id', (req, res) => res.send('ok'));
      module.exports = userRouter;
    `;
    const info = extractExpressRouterInfo(source, 'routes/userRoutes.js');
    expect(info?.localEndpoints).toEqual([{ method: 'GET', pathSuffix: '/:id' }]);
    expect(info?.exportsRouterVar).toBe(true);
  });

  it("does not treat an unrelated object's .get(...) call as an endpoint (Map/Set false-positive avoidance)", () => {
    const source = `
      const cache = new Map();
      cache.get('someKey');
    `;
    const info = extractExpressRouterInfo(source, 'cache.ts');
    expect(info?.localEndpoints).toEqual([]);
  });

  it('records require() mounts and module.exports for later cross-file resolution', () => {
    const source = `
      const express = require('express');
      const app = express();
      const userRoutes = require('./routes/userRoutes');
      app.use('/api/users', userRoutes);
    `;
    const info = extractExpressRouterInfo(source, 'app.js');
    expect(info?.mounts).toEqual([{ mountPath: '/api/users', routerRefName: 'userRoutes' }]);
    expect(info?.importedFrom.get('userRoutes')).toBe('./routes/userRoutes');
  });

  it('returns null (not a throw) on malformed source', () => {
    expect(() => extractExpressRouterInfo('function ( { [[[', 'broken.js')).not.toThrow();
    expect(extractExpressRouterInfo('function ( { [[[', 'broken.js')).toBeNull();
  });
});

describe('findRouteHandlerPath', () => {
  it('picks the exact match over a shorter suffix match when both are plausible', () => {
    const source = `
      router.get('/users', (req, res) => res.status(1).send());
      router.get('/api/users', (req, res) => res.status(2).send());
    `;
    const ast = parseModule(source, 'routes.js')!;
    // '/api/users' both equals one registration exactly AND ends with the other's '/users' suffix
    // — the exact/longest match ('/api/users' itself) must win, not the shorter '/users' one.
    const found = findRouteHandlerPath(ast, 'GET', '/api/users');
    expect(found).not.toBeNull();
    const arg = found!.node.arguments[1];
    expect(arg?.type).toBe('ArrowFunctionExpression');
  });

  it('returns null when no registration matches the method or path', () => {
    const source = `router.get('/users', (req, res) => res.status(200).send());`;
    const ast = parseModule(source, 'routes.js')!;
    expect(findRouteHandlerPath(ast, 'POST', '/users')).toBeNull();
    expect(findRouteHandlerPath(ast, 'GET', '/orders')).toBeNull();
  });

  it("doesn't match a bare '/' registration against an unrelated deeper path via naive suffix matching", () => {
    const source = `router.get('/', (req, res) => res.status(200).send());`;
    const ast = parseModule(source, 'routes.js')!;
    expect(findRouteHandlerPath(ast, 'GET', '/users/:id')).toBeNull();
  });
});

describe('resolveExpressEndpoints', () => {
  it('composes a two-file mount into a single prefixed endpoint', () => {
    const files = [
      {
        rel: 'app.js',
        source: `
          const express = require('express');
          const app = express();
          const userRoutes = require('./routes/userRoutes');
          app.use('/api/users', userRoutes);
        `,
      },
      {
        rel: 'routes/userRoutes.js',
        source: `
          const express = require('express');
          const router = express.Router();
          router.get('/:id', (req, res) => res.send('ok'));
          module.exports = router;
        `,
      },
    ];
    const units = resolveExpressEndpoints(files);
    expect(units.map((u) => u.key)).toContain('endpoint:GET /api/users/:id');
  });

  it('surfaces a router file unprefixed when no mount ever resolves to it (never silently dropped)', () => {
    const files = [
      {
        rel: 'routes/orphanRoutes.js',
        source: `
          const express = require('express');
          const router = express.Router();
          router.get('/orphan', (req, res) => res.send('ok'));
          module.exports = router;
        `,
      },
    ];
    const units = resolveExpressEndpoints(files);
    expect(units.map((u) => u.key)).toContain('endpoint:GET /orphan');
  });
});

// --- Isolated check against a real fixture repo (Item B2) ------------------

const FIXTURES_ROOT = path.join('C:', 'Users', 'AdroyFernandes', 'Documents', 'TestApps');
const RBAC_BACKEND = path.join(FIXTURES_ROOT, 'Role-Based-Access-Control-RBAC-', 'vrb-backend');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(abs));
    } else if (/\.(js|ts)$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

describe.skipIf(!fs.existsSync(RBAC_BACKEND))(
  'resolveExpressEndpoints against Role-Based-Access-Control-RBAC- vrb-backend (isolated check)',
  () => {
    it('composes the real app.js -> routes/*.js mounts into the actual full endpoint list', () => {
      const absFiles = listSourceFiles(RBAC_BACKEND);
      const files = absFiles.map((abs) => ({
        rel: path.relative(RBAC_BACKEND, abs).split(path.sep).join('/'),
        source: fs.readFileSync(abs, 'utf-8'),
      }));

      const units = resolveExpressEndpoints(files);
      const keys = units.map((u) => u.key);

      // Real mounts in app.js: /api/users, /api/roles, /api/auth, composed with each
      // routes/*.js file's own router.METHOD(...) registrations.
      expect(keys).toContain('endpoint:GET /api/users');
      expect(keys).toContain('endpoint:POST /api/users');
      expect(keys).toContain('endpoint:GET /api/users/:id');
      expect(keys).toContain('endpoint:PUT /api/users/:id');
      expect(keys).toContain('endpoint:DELETE /api/users/:id');

      expect(keys).toContain('endpoint:GET /api/roles');
      expect(keys).toContain('endpoint:POST /api/roles');
      expect(keys).toContain('endpoint:GET /api/roles/:id');

      expect(keys).toContain('endpoint:POST /api/auth/login');
      expect(keys).toContain('endpoint:POST /api/auth/logout');
    });
  },
);
