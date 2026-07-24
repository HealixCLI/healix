import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeRepoSourceHash, indexSource } from './source-index.js';

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-source-index-'));
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

describe('computeRepoSourceHash', () => {
  it('is stable across repeated calls when nothing changed', () => {
    const dir = makeRepo();
    write(dir, 'src/App.tsx', 'export default function App() {}');
    expect(computeRepoSourceHash(dir)).toBe(computeRepoSourceHash(dir));
  });

  it('changes when a file is added', () => {
    const dir = makeRepo();
    write(dir, 'src/App.tsx', 'export default function App() {}');
    const before = computeRepoSourceHash(dir);
    write(dir, 'src/New.tsx', 'export const x = 1;');
    expect(computeRepoSourceHash(dir)).not.toBe(before);
  });

  it('changes when an existing file is modified (size and mtime change)', () => {
    const dir = makeRepo();
    write(dir, 'src/App.tsx', 'export default function App() {}');
    const before = computeRepoSourceHash(dir);

    const abs = path.join(dir, 'src', 'App.tsx');
    fs.writeFileSync(abs, 'export default function App() { return null; }', 'utf-8');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(abs, future, future);

    expect(computeRepoSourceHash(dir)).not.toBe(before);
  });

  // indexSource() treats spec files as AUTHORITATIVE (a spec-derived unit always overrides a
  // code-derived one on a key collision) — the hash must notice a spec-only edit even when no
  // regular source file changed, or a stale sourceContext would silently keep serving pre-edit
  // spec-derived units forever.
  it('changes when a Postman collection is added (spec files are authoritative, not just source)', () => {
    const dir = makeRepo();
    write(dir, 'src/App.tsx', 'export default function App() {}');
    const before = computeRepoSourceHash(dir);
    write(dir, 'API.postman_collection.json', '{"info":{"name":"API"},"item":[]}');
    expect(computeRepoSourceHash(dir)).not.toBe(before);
  });

  it('changes when an existing OpenAPI spec is modified, with no other file touched', () => {
    const dir = makeRepo();
    write(dir, 'src/App.tsx', 'export default function App() {}');
    write(dir, 'docs/openapi.yaml', 'openapi: 3.0.0\npaths: {}\n');
    const before = computeRepoSourceHash(dir);

    const abs = path.join(dir, 'docs', 'openapi.yaml');
    fs.writeFileSync(abs, 'openapi: 3.0.0\npaths:\n  /new:\n    get: {}\n', 'utf-8');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(abs, future, future);

    expect(computeRepoSourceHash(dir)).not.toBe(before);
  });
});

describe('indexSource', () => {
  it('composes AST-based mount-resolved endpoints, forms, auth patterns, and selector hints', () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { express: '^4.0.0', react: '^18.0.0' } }));
    write(
      dir,
      'app.js',
      `
        const express = require('express');
        const app = express();
        const userRoutes = require('./routes/userRoutes');
        app.use('/api/users', userRoutes);
      `,
    );
    write(
      dir,
      'routes/userRoutes.js',
      `
        const express = require('express');
        const jwt = require('jsonwebtoken');
        const router = express.Router();
        router.get('/:id', (req, res) => res.send('ok'));
        module.exports = router;
      `,
    );
    write(
      dir,
      'src/LoginForm.tsx',
      `
        export function LoginForm() {
          return (
            <ProtectedRoute>
              <form>
                <input name="email" type="email" required data-testid="login-email" />
                <button type="submit">Sign in</button>
              </form>
            </ProtectedRoute>
          );
        }
      `,
    );

    return indexSource(dir).then((ctx) => {
      expect(ctx.units.map((u) => u.key)).toContain('endpoint:GET /api/users/:id');

      expect(ctx.forms).toHaveLength(1);
      expect(ctx.forms[0].fields).toEqual([
        { name: 'email', type: 'email', required: true, testId: 'login-email' },
      ]);

      const authFiles = ctx.authPatterns.map((a) => a.file);
      expect(authFiles).toContain('routes/userRoutes.js');
      const routerAuth = ctx.authPatterns.find((a) => a.file === 'routes/userRoutes.js');
      expect(routerAuth?.libraries).toEqual(['jsonwebtoken']);
      const guardAuth = ctx.authPatterns.find((a) => a.routeGuards.includes('ProtectedRoute'));
      expect(guardAuth?.file).toBe('src/LoginForm.tsx');

      expect(ctx.selectorHints).toContainEqual({
        file: 'src/LoginForm.tsx',
        attribute: 'data-testid',
        value: 'login-email',
      });
    });
  });

  it('lets a spec-derived unit override a code-derived one sharing the same key (spec is authoritative)', () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }));
    write(
      dir,
      'app.js',
      `
        const express = require('express');
        const app = express();
        app.get('/api/orders', (req, res) => res.send('ok'));
      `,
    );
    write(
      dir,
      'docs/openapi.yaml',
      `
openapi: 3.0.0
paths:
  /api/orders:
    get:
      security:
        - bearerAuth: []
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
`,
    );

    return indexSource(dir).then((ctx) => {
      const unit = ctx.units.find((u) => u.key === 'endpoint:GET /api/orders');
      expect(unit?.provenance).toBe('spec');
      expect(unit?.authRequired).toBe(true);
      expect(ctx.specSources).toContain('docs/openapi.yaml');
    });
  });

  it('extracts non-JS endpoints via the multi-lang fallback alongside JS extraction', () => {
    const dir = makeRepo();
    write(dir, 'app.py', '@app.route("/health")\ndef health():\n    return "ok"\n');
    return indexSource(dir).then((ctx) => {
      expect(ctx.units.map((u) => u.key)).toContain('endpoint:GET /health');
    });
  });
});

// --- Isolated check against the real RBAC repo, combining backend + frontend + Postman (Item D1) --

const RBAC_ROOT = path.join(
  'C:',
  'Users',
  'AdroyFernandes',
  'Documents',
  'TestApps',
  'Role-Based-Access-Control-RBAC-',
);

describe.skipIf(!fs.existsSync(RBAC_ROOT))(
  'indexSource against the real Role-Based-Access-Control-RBAC- repo (isolated check)',
  () => {
    it('combines backend mount-resolved endpoints, frontend forms/auth-guards, and the Postman collection end-to-end', async () => {
      const ctx = await indexSource(RBAC_ROOT, { maxUnits: 500 });
      const keys = ctx.units.map((u) => u.key);

      // From the backend's app.js -> routes/*.js mount resolution (Item B2).
      expect(keys).toContain('endpoint:GET /api/users/:id');
      // From the root RBAC-API.postman_collection.json (Item C2), authoritative over the
      // backend's own code-derived unit sharing the same key.
      const login = ctx.units.find((u) => u.key === 'endpoint:POST /api/auth/login');
      expect(login?.provenance).toBe('spec');
      expect(ctx.specSources.some((s) => s.endsWith('.postman_collection.json'))).toBe(true);

      // From the frontend's routes.js ProtectedRoute usage (Item B4).
      expect(ctx.authPatterns.some((a) => a.routeGuards.includes('ProtectedRoute'))).toBe(true);
      // From the backend's jsonwebtoken middleware (Item B4).
      expect(ctx.authPatterns.some((a) => a.libraries.includes('jsonwebtoken'))).toBe(true);
    });
  },
);
