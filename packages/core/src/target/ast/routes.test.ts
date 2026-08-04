import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractReactRouterRoutesAst } from './routes.js';

describe('extractReactRouterRoutesAst', () => {
  it('extracts a basic <Route path="...">', () => {
    const source = `
      function App() {
        return <Routes><Route path="/settings" element={<Settings />} /></Routes>;
      }
    `;
    const units = extractReactRouterRoutesAst('src/App.tsx', source);
    expect(units?.map((u) => u.key)).toContain('route:/settings');
  });

  it('composes a nested multi-line <Route> JSX path with its ancestor, not in isolation', () => {
    const source = `
      function Routes() {
        return (
          <Routes>
            <Route path="login">
              <Route index element={<LoginPage />} />
              <Route path="resetpassword" element={<ResetPasswordPage />} />
            </Route>
          </Routes>
        );
      }
    `;
    const units = extractReactRouterRoutesAst('src/routes/AppRoutes.tsx', source);
    const keys = units?.map((u) => u.key) ?? [];
    // The wrapper's own path, AND the index child resolving to that same real URL.
    expect(keys).toContain('route:/login');
    // The nested child's path composed with its ancestor — NOT the bare 'route:resetpassword'
    // a per-Route-in-isolation extraction would wrongly produce.
    expect(keys).toContain('route:/login/resetpassword');
    expect(keys).not.toContain('route:resetpassword');
  });

  it('extracts a path given as a JSXExpressionContainer string literal (regex cannot see this form)', () => {
    const source = `<Route path={'/checkout'} element={<Checkout />} />;`;
    const units = extractReactRouterRoutesAst('src/App.tsx', source);
    expect(units?.map((u) => u.key)).toContain('route:/checkout');
  });

  it('extracts createBrowserRouter object-literal routes, including nested children', () => {
    const source = `
      import { createBrowserRouter } from 'react-router-dom';
      export const router = createBrowserRouter([
        { path: '/', element: <Home /> },
        {
          path: '/dashboard',
          element: <Dashboard />,
          children: [
            { path: 'settings', element: <Settings /> },
            { path: 'billing', element: <Billing /> },
          ],
        },
      ]);
    `;
    const units = extractReactRouterRoutesAst('src/routes.tsx', source);
    const keys = units?.map((u) => u.key) ?? [];
    expect(keys).toContain('route:/');
    expect(keys).toContain('route:/dashboard');
    // Composed with the parent '/dashboard', not the bare relative fragment.
    expect(keys).toContain('route:/dashboard/settings');
    expect(keys).toContain('route:/dashboard/billing');
    expect(keys).not.toContain('route:settings');
    expect(keys).not.toContain('route:billing');
  });

  it('does NOT extract a `path` property from an unrelated object literal (false-positive avoidance)', () => {
    const source = `
      const uploadConfig = { path: '/tmp/uploads', maxSize: 10 };
      function App() {
        return <div>{uploadConfig.path}</div>;
      }
    `;
    const units = extractReactRouterRoutesAst('src/App.tsx', source);
    expect(units?.map((u) => u.key)).not.toContain('route:/tmp/uploads');
  });

  it('returns null (not a throw) on malformed source, so callers can fall back to regex', () => {
    expect(() => extractReactRouterRoutesAst('broken.tsx', 'function ( { [[[')).not.toThrow();
    expect(extractReactRouterRoutesAst('broken.tsx', 'function ( { [[[')).toBeNull();
  });
});

// --- Isolated check against real fixture repos (Item B1) -------------------

const FIXTURES_ROOT = path.join('C:', 'Users', 'AdroyFernandes', 'Documents', 'TestApps');
const RBAC_ROUTES_FILE = path.join(
  FIXTURES_ROOT,
  'Role-Based-Access-Control-RBAC-',
  'vrb-frontend',
  'src',
  'routes.js',
);
const PSV_ROUTES_FILE = path.join(
  FIXTURES_ROOT,
  'psv-ui-c-and-a-react-latest-development',
  'src',
  'routes',
  'AppRoutes.tsx',
);

describe.skipIf(!fs.existsSync(RBAC_ROUTES_FILE))(
  'extractReactRouterRoutesAst against Role-Based-Access-Control-RBAC- routes.js (isolated check)',
  () => {
    it('extracts every real createBrowserRouter path in the fixture', () => {
      const source = fs.readFileSync(RBAC_ROUTES_FILE, 'utf-8');
      const units = extractReactRouterRoutesAst('src/routes.js', source);
      const keys = units?.map((u) => u.key) ?? [];
      // Real config in the fixture: '/', '/userdashboard', '/admindashboard', '*' — the catch-all
      // is a top-level entry too, so it's now consistently composed with a leading slash like
      // every other top-level route (previously emitted as the bare, un-prefixed '*').
      expect(keys).toContain('route:/');
      expect(keys).toContain('route:/userdashboard');
      expect(keys).toContain('route:/admindashboard');
      expect(keys).toContain('route:/*');
    });
  },
);

describe.skipIf(!fs.existsSync(PSV_ROUTES_FILE))(
  'extractReactRouterRoutesAst against psv-ui-c-and-a AppRoutes.tsx (isolated check)',
  () => {
    it('extracts every real <Route> path in the region-prefixed, deeply nested fixture, composed with its ancestors', () => {
      const source = fs.readFileSync(PSV_ROUTES_FILE, 'utf-8');
      const units = extractReactRouterRoutesAst('src/routes/AppRoutes.tsx', source);
      const keys = units?.map((u) => u.key) ?? [];
      // Real routes in the fixture, several nested 2-3 levels deep — composed to their real,
      // full URL rather than the bare relative fragment a per-Route-in-isolation walk produces.
      expect(keys).toContain('route:/:region/*');
      expect(keys).toContain('route:/home');
      expect(keys).toContain('route:/login');
      expect(keys).toContain('route:/login/resetpassword');
      expect(keys).toContain('route:/login/passwordupdate');
      expect(keys).toContain('route:/login/errorpage');
      expect(keys).toContain('route:/register');
      expect(keys).toContain('route:/dashboard');
      expect(keys).toContain('route:/dashboard/points');
      expect(keys).toContain('route:/dashboard/vouchers');
      expect(keys).toContain('route:/dashboard/unsubscribepage');
      // None of the nested routes should still be reported as bare, uncomposed fragments.
      expect(keys).not.toContain('route:resetpassword');
      expect(keys).not.toContain('route:passwordupdate');
      expect(keys).not.toContain('route:points');
      expect(keys).not.toContain('route:vouchers');

      // The real regression this fixture exists to catch (Cluster C): `dashboard` is wrapped by
      // <ProtectedRoute>, and that guard must be inherited by every pathless descendant, not just
      // the node that literally carries the wrapper.
      const byKey = new Map(units?.map((u) => [u.key, u]));
      for (const guarded of [
        'route:/dashboard',
        'route:/dashboard/points',
        'route:/dashboard/vouchers',
        'route:/dashboard/unsubscribepage',
      ]) {
        expect(byKey.get(guarded)?.authGuardName).toBe('ProtectedRoute');
      }
      for (const unguarded of [
        'route:/login',
        'route:/login/resetpassword',
        'route:/home',
        'route:/register',
      ]) {
        expect(byKey.get(unguarded)?.authGuardName).toBeUndefined();
      }
    });
  },
);

describe('route-guard inheritance (Cluster C)', () => {
  it('flags a <Route> whose own element is wrapped by a recognized guard component', () => {
    const source = `<Route path="/account" element={<ProtectedRoute><Account /></ProtectedRoute>} />;`;
    const units = extractReactRouterRoutesAst('src/App.tsx', source);
    expect(units?.find((u) => u.key === 'route:/account')?.authGuardName).toBe('ProtectedRoute');
  });

  it('inherits a guard on a parent layout route down to every pathless child', () => {
    const source = `
      <Routes>
        <Route path="dashboard" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
          <Route index element={<Overview />} />
          <Route path="points" element={<Points />} />
          <Route path="vouchers" element={<Vouchers />} />
        </Route>
      </Routes>
    `;
    const units = extractReactRouterRoutesAst('src/App.tsx', source);
    const byKey = new Map(units?.map((u) => [u.key, u]));
    expect(byKey.get('route:/dashboard')?.authGuardName).toBe('ProtectedRoute');
    expect(byKey.get('route:/dashboard/points')?.authGuardName).toBe('ProtectedRoute');
    expect(byKey.get('route:/dashboard/vouchers')?.authGuardName).toBe('ProtectedRoute');
  });

  it('leaves a sibling route with no guard ancestor unset', () => {
    const source = `
      <Routes>
        <Route path="dashboard" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
          <Route path="points" element={<Points />} />
        </Route>
        <Route path="login" element={<LoginPage />} />
      </Routes>
    `;
    const units = extractReactRouterRoutesAst('src/App.tsx', source);
    expect(units?.find((u) => u.key === 'route:/login')?.authGuardName).toBeUndefined();
  });

  it('detects a guard in a createBrowserRouter object-config element, inherited into nested children', () => {
    const source = `
      import { createBrowserRouter } from 'react-router-dom';
      export const router = createBrowserRouter([
        {
          path: '/dashboard',
          element: <ProtectedRoute><Layout /></ProtectedRoute>,
          children: [
            { path: 'settings', element: <Settings /> },
          ],
        },
        { path: '/login', element: <LoginPage /> },
      ]);
    `;
    const units = extractReactRouterRoutesAst('src/routes.tsx', source);
    const byKey = new Map(units?.map((u) => [u.key, u]));
    expect(byKey.get('route:/dashboard')?.authGuardName).toBe('ProtectedRoute');
    expect(byKey.get('route:/dashboard/settings')?.authGuardName).toBe('ProtectedRoute');
    expect(byKey.get('route:/login')?.authGuardName).toBeUndefined();
  });
});
