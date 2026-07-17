import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractAuthPatternsAst } from './auth-patterns.js';

describe('extractAuthPatternsAst', () => {
  it('detects jsonwebtoken via require()', () => {
    const source = `
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, secret);
    `;
    const info = extractAuthPatternsAst('middleware/auth.js', source);
    expect(info?.libraries).toEqual(['jsonwebtoken']);
    expect(info?.routeGuards).toEqual([]);
  });

  it('detects next-auth, clerk, and auth0 via ES import specifiers', () => {
    const source = `
      import { getServerSession } from 'next-auth';
      import { auth } from '@clerk/nextjs';
      import { Auth0Provider } from '@auth0/auth0-react';
    `;
    const info = extractAuthPatternsAst('auth.ts', source);
    expect(info?.libraries).toEqual(expect.arrayContaining(['next-auth', 'clerk', 'auth0']));
  });

  it('detects a route-guard component used as a JSX wrapper', () => {
    const source = `
      function Routes() {
        return (
          <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        );
      }
    `;
    const info = extractAuthPatternsAst('routes.tsx', source);
    expect(info?.routeGuards).toEqual(['ProtectedRoute']);
  });

  it('reports no libraries/guards for a file with neither', () => {
    const source = `export function add(a, b) { return a + b; }`;
    const info = extractAuthPatternsAst('math.ts', source);
    expect(info).toEqual({ file: 'math.ts', libraries: [], routeGuards: [] });
  });

  it('returns null (not a throw) on malformed source', () => {
    expect(() => extractAuthPatternsAst('broken.ts', 'function ( { [[[')).not.toThrow();
    expect(extractAuthPatternsAst('broken.ts', 'function ( { [[[')).toBeNull();
  });
});

// --- Isolated check against real fixture repos (Item B4) -------------------

const FIXTURES_ROOT = path.join('C:', 'Users', 'AdroyFernandes', 'Documents', 'TestApps');
const RBAC_AUTH_MIDDLEWARE = path.join(
  FIXTURES_ROOT,
  'Role-Based-Access-Control-RBAC-',
  'vrb-backend',
  'middleware',
  'authMiddleware.js',
);
const RBAC_FRONTEND_ROUTES = path.join(
  FIXTURES_ROOT,
  'Role-Based-Access-Control-RBAC-',
  'vrb-frontend',
  'src',
  'routes.js',
);

describe.skipIf(!fs.existsSync(RBAC_AUTH_MIDDLEWARE))(
  'extractAuthPatternsAst against RBAC vrb-backend authMiddleware.js (isolated check)',
  () => {
    it('detects the real jsonwebtoken usage', () => {
      const source = fs.readFileSync(RBAC_AUTH_MIDDLEWARE, 'utf-8');
      const info = extractAuthPatternsAst('middleware/authMiddleware.js', source);
      expect(info?.libraries).toEqual(['jsonwebtoken']);
    });
  },
);

describe.skipIf(!fs.existsSync(RBAC_FRONTEND_ROUTES))(
  'extractAuthPatternsAst against RBAC vrb-frontend routes.js (isolated check)',
  () => {
    it('detects the real ProtectedRoute usage wrapping the user/admin dashboards', () => {
      const source = fs.readFileSync(RBAC_FRONTEND_ROUTES, 'utf-8');
      const info = extractAuthPatternsAst('src/routes.js', source);
      expect(info?.routeGuards).toEqual(['ProtectedRoute']);
    });
  },
);
