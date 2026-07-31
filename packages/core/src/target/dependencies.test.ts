import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectExternalDependencies } from './dependencies.js';

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-dependencies-'));
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

describe('detectExternalDependencies', () => {
  it('detects a known SMS provider used server-side with an override env var', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { twilio: '^4.0.0' } }));
    write(
      dir,
      'server/otp.ts',
      "import twilio from 'twilio';\nconst client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN, { edge: process.env.TWILIO_API_URL });\n",
    );

    const deps = await detectExternalDependencies(dir);
    const twilioDep = deps.find((d) => d.packageName === 'twilio');
    expect(twilioDep).toBeDefined();
    expect(twilioDep?.category).toBe('sms');
    expect(twilioDep?.mockStrategy).toBe('env-override');
    expect(twilioDep?.envVar).toBe('TWILIO_API_URL');
  });

  it('detects a known payment SDK used in frontend code as route-intercept', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { stripe: '^14.0.0', react: '^18.0.0' } }));
    write(
      dir,
      'src/components/Checkout.tsx',
      "import Stripe from 'stripe';\nconst s = new Stripe('sk_test');\n",
    );

    const deps = await detectExternalDependencies(dir);
    const stripeDep = deps.find((d) => d.packageName === 'stripe');
    expect(stripeDep).toBeDefined();
    expect(stripeDep?.mockStrategy).toBe('route-intercept');
    expect(stripeDep?.hostnames).toContain('api.stripe.com');
  });

  it('flags SMTP-based nodemailer as detected but undeterminable', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { nodemailer: '^6.0.0' } }));

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.packageName === 'nodemailer');
    expect(dep).toBeDefined();
    expect(dep?.mockStrategy).toBe('undeterminable');
  });

  it('detects a hardcoded third-party URL literal passed to a network call', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({}));
    write(dir, 'src/weather.ts', "fetch('https://api.weatherstack.example/v1/current');\n");

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.hostnames?.includes('api.weatherstack.example'));
    expect(dep).toBeDefined();
    expect(dep?.category).toBe('other');
    expect(dep?.mockStrategy).toBe('route-intercept');
  });

  it('does NOT flag a plain string-literal URL that is never used in a network call (a link/asset, not a dependency)', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({}));
    write(
      dir,
      'src/i18n/regions.ts',
      "export const links = { shop: 'https://www.example-retailer.test/shop', home: 'https://www.example.test' };\n",
    );

    const deps = await detectExternalDependencies(dir);
    expect(deps.find((d) => d.hostnames?.includes('www.example-retailer.test'))).toBeUndefined();
  });

  it('does NOT flag an SVG/XML namespace attribute as a dependency', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({}));
    write(dir, 'src/components/Icon.tsx', '<svg xmlns="http://www.w3.org/2000/svg"><path /></svg>;\n');

    const deps = await detectExternalDependencies(dir);
    expect(deps.find((d) => d.hostnames?.includes('www.w3.org'))).toBeUndefined();
  });

  it('flags the frontend backend-base-URL env var as a backend dependency when unreachable', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    write(dir, 'src/api.ts', "const base = process.env.NEXT_PUBLIC_API_URL;\nfetch(base + '/orders');\n");
    write(dir, '.env', 'NEXT_PUBLIC_API_URL=http://localhost:59999\n');

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.category === 'backend');
    expect(dep).toBeDefined();
    expect(dep?.envVar).toBe('NEXT_PUBLIC_API_URL');
    expect(dep?.mockStrategy).toBe('both');
    expect(dep?.reachable).toBe(false);
    expect(dep?.hostnames).toEqual(['localhost:59999']);
  });

  it('records a LOCAL backend that is actually up right now as a distinct local-backend dependency (F-04)', async () => {
    const dir = makeRepo();
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    write(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    write(dir, 'src/api.ts', "const base = process.env.NEXT_PUBLIC_API_URL;\nfetch(base + '/orders');\n");
    write(dir, '.env', `NEXT_PUBLIC_API_URL=http://localhost:${port}\n`);

    try {
      const deps = await detectExternalDependencies(dir);
      // Must NOT be suppressed, and must be distinct from a real third-party/backend dependency.
      expect(deps.find((d) => d.category === 'backend')).toBeUndefined();
      const dep = deps.find((d) => d.category === 'local-backend');
      expect(dep).toBeDefined();
      expect(dep?.envVar).toBe('NEXT_PUBLIC_API_URL');
      expect(dep?.reachable).toBe(true);
      expect(dep?.hostnames).toEqual([`localhost:${port}`]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('records a hardcoded LOCAL URL literal in a network call as a local-backend dependency, reachable or not (F-04)', async () => {
    const dir = makeRepo();
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    write(dir, 'package.json', JSON.stringify({}));
    write(dir, 'src/api.ts', `fetch('http://localhost:${port}/orders');\n`);

    try {
      const deps = await detectExternalDependencies(dir);
      const dep = deps.find((d) => d.category === 'local-backend');
      expect(dep).toBeDefined();
      expect(dep?.source).toBe('url-literal');
      expect(dep?.reachable).toBe(true);
      expect(dep?.hostnames).toEqual([`localhost:${port}`]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('records an UNREACHABLE hardcoded local URL literal as local-backend too (no reachability check existed before)', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({}));
    write(dir, 'src/api.ts', "fetch('http://localhost:59999/orders');\n");

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.category === 'local-backend');
    expect(dep).toBeDefined();
    expect(dep?.source).toBe('url-literal');
    expect(dep?.reachable).toBe(false);
  });

  it('does NOT flag a hardcoded local URL literal that is just a string constant, not a network call', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({}));
    write(dir, 'src/config.ts', "export const devDocsLink = 'http://localhost:59999/docs';\n");

    const deps = await detectExternalDependencies(dir);
    expect(deps.find((d) => d.category === 'local-backend')).toBeUndefined();
  });

  it('detects an env-configured external endpoint under an arbitrary (non "API_URL") name — Vite convention (non-local host, flagged regardless of its — here unreachable — status)', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0', vite: '^5.0.0' } }));
    write(
      dir,
      'src/config/env.ts',
      "export const config = { neoBaseUrl: import.meta.env.VITE_NEO_BASE_URL || '' };\n",
    );
    write(dir, '.env', 'VITE_NEO_BASE_URL=https://eu.api.example-partner.test/neo/\n');

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.envVar === 'VITE_NEO_BASE_URL');
    expect(dep).toBeDefined();
    expect(dep?.category).toBe('backend');
    expect(dep?.mockStrategy).toBe('both');
    expect(dep?.hostnames).toEqual(['eu.api.example-partner.test']);
  });

  it('classifies an auth/identity-provider-named env var as category "auth"', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    write(dir, 'src/services/cognitoAuthService.ts', 'const domain = import.meta.env.VITE_COGNITO_DOMAIN;\n');
    write(dir, '.env', 'VITE_COGNITO_DOMAIN=https://my-app.auth.eu-central-1.amazoncognito.com\n');

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.envVar === 'VITE_COGNITO_DOMAIN');
    expect(dep).toBeDefined();
    expect(dep?.category).toBe('auth');
  });

  it("does not flag an OAuth redirect/callback URL (the app's own endpoint, not a dependency it calls out to)", async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    write(dir, 'src/services/auth.ts', 'const redirectUri = import.meta.env.VITE_COGNITO_REDIRECT_URI;\n');
    write(dir, '.env', 'VITE_COGNITO_REDIRECT_URI=http://localhost:4202/callback\n');

    const deps = await detectExternalDependencies(dir);
    expect(deps.find((d) => d.envVar === 'VITE_COGNITO_REDIRECT_URI')).toBeUndefined();
  });

  it('does not flag a non-URL env var value (not every VITE_* var is an endpoint)', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    write(dir, 'src/config/env.ts', 'const brand = import.meta.env.VITE_BRAND;\n');
    write(dir, '.env', 'VITE_BRAND=DEMO\n');

    const deps = await detectExternalDependencies(dir);
    expect(deps.find((d) => d.envVar === 'VITE_BRAND')).toBeUndefined();
  });

  it('returns an empty array for a repo with no external dependencies', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    write(dir, 'src/App.tsx', 'export default function App() { return null; }\n');

    const deps = await detectExternalDependencies(dir);
    expect(deps).toEqual([]);
  });

  it('attaches an auth-shaped call-site endpoint across multiple mockable dependencies, scoped to the auth-looking one (Fix 1 repro)', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    write(
      dir,
      'src/api.ts',
      'const backend = import.meta.env.VITE_API_URL;\nconst authBase = import.meta.env.VITE_AUTH_URL;\n' +
        "apiClient.get('/customer/get');\nauthClient.post('/auth/token/generate');\n",
    );
    write(
      dir,
      '.env',
      'VITE_API_URL=https://eu.api.example-partner.test\nVITE_AUTH_URL=https://auth.example-idp.test\n',
    );

    const deps = await detectExternalDependencies(dir);
    const backendDep = deps.find((d) => d.envVar === 'VITE_API_URL');
    const authDep = deps.find((d) => d.envVar === 'VITE_AUTH_URL');
    expect(backendDep).toBeDefined();
    expect(authDep).toBeDefined();
    expect(authDep?.category).toBe('auth');

    expect(
      authDep?.endpoints?.some((e) => e.method === 'POST' && e.pathPattern === '/auth/token/generate'),
    ).toBe(true);
    // The gate is relaxed for AUTH endpoints only — an ordinary endpoint must not get
    // per-endpoint attribution on ANY dependency just because an auth endpoint elsewhere did.
    expect(backendDep?.endpoints?.some((e) => e.pathPattern === '/customer/get')).toBeFalsy();
    expect(backendDep?.endpoints?.some((e) => e.pathPattern.includes('auth'))).toBeFalsy();
  });

  it('tags an auth-shaped endpoint distinctly from an ordinary one on a single mockable dependency', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    write(dir, 'src/env.ts', 'const base = import.meta.env.VITE_API_URL;\n');
    write(dir, 'src/api.ts', "apiClient.post('/auth/login');\napiClient.get('/orders');\n");
    write(dir, '.env', 'VITE_API_URL=https://eu.api.example-partner.test\n');

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.envVar === 'VITE_API_URL');
    expect(dep).toBeDefined();
    const auth = dep?.endpoints?.find((e) => e.pathPattern === '/auth/login');
    const orders = dep?.endpoints?.find((e) => e.pathPattern === '/orders');
    expect(auth?.category).toBe('auth');
    expect(orders?.category).toBeUndefined();
  });

  it('still attaches an auth endpoint when a hardcoded host is seen twice — once as a bare base literal, once with the auth path (repeat-literal regression)', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({}));
    write(
      dir,
      'src/api.ts',
      "fetch('https://eu.api.example-partner.test/health');\nfetch('https://eu.api.example-partner.test/auth/token/generate');\n",
    );

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.hostnames?.includes('eu.api.example-partner.test'));
    expect(dep).toBeDefined();
    expect(dep?.endpoints?.some((e) => e.pathPattern === '/auth/token/generate')).toBe(true);
  });

  it('detects a relative-path (no leading slash) auth call site on an axios instance with its own baseURL (GAP-064)', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({}));
    write(dir, 'src/authService.ts', "authApi.post('v1/web/token/generate', body);\n");
    write(dir, '.env', 'AUTH_API_URL=https://eu.api.example-partner.test\n');
    write(dir, 'src/env.ts', 'const base = process.env.AUTH_API_URL;\n');

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.envVar === 'AUTH_API_URL');
    expect(dep).toBeDefined();
    expect(
      dep?.endpoints?.some((e) => e.method === 'POST' && e.pathPattern === 'v1/web/token/generate'),
    ).toBe(true);
  });

  it('detects a relative-path auth call site written with an explicit TypeScript generic argument (real axios idiom, GAP-064 follow-up)', async () => {
    // Mirrors the ACTUAL real call site in psv-ui-c-and-a-react-latest-development's
    // authService.ts:32 verbatim: `authApi.post<TokenGenerateResponse>('v1/web/token/generate', body)`.
    // Found via real-app verification — the synthetic test above (no generic) passed while this
    // exact real shape was still silently invisible to CALL_SITE_RE.
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({}));
    write(
      dir,
      'src/authService.ts',
      "const { data } = await authApi.post<TokenGenerateResponse>('v1/web/token/generate', body);\n",
    );
    write(dir, '.env', 'AUTH_API_URL=https://eu.api.example-partner.test\n');
    write(dir, 'src/env.ts', 'const base = process.env.AUTH_API_URL;\n');

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.envVar === 'AUTH_API_URL');
    expect(dep).toBeDefined();
    expect(
      dep?.endpoints?.some((e) => e.method === 'POST' && e.pathPattern === 'v1/web/token/generate'),
    ).toBe(true);
  });

  it('does NOT capture a bare relative-path .get() call (still gated — likely a Map/Storage getter, not an HTTP call)', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({}));
    write(dir, 'src/cache.ts', "cache.get('token');\n");
    write(dir, '.env', 'AUTH_API_URL=https://eu.api.example-partner.test\n');
    write(dir, 'src/env.ts', 'const base = process.env.AUTH_API_URL;\n');

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.envVar === 'AUTH_API_URL');
    expect(dep?.endpoints?.some((e) => e.pathPattern === 'token')).toBeFalsy();
  });

  it('detects an auth path expressed as a template-literal interpolation the call-site regexes miss (fetch(`${base}/auth/token/generate`))', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({}));
    write(
      dir,
      'src/api.ts',
      'const base = process.env.API_BASE_URL;\nfetch(`${base}/auth/token/generate`);\n',
    );
    write(dir, '.env', 'API_BASE_URL=https://eu.api.example-partner.test\n');

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.envVar === 'API_BASE_URL');
    expect(dep).toBeDefined();
    expect(dep?.endpoints?.some((e) => e.pathPattern === '/auth/token/generate')).toBe(true);
  });

  it('does not attribute an auth path to a non-network-call plain string constant', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({}));
    write(
      dir,
      'src/docs.ts',
      "export const authDocsLink = 'https://docs.example.test/auth/token/generate';\n",
    );

    const deps = await detectExternalDependencies(dir);
    expect(deps.find((d) => d.hostnames?.includes('docs.example.test'))).toBeUndefined();
  });

  it('still detects an auth endpoint even when scanned after 40+ other call sites hit the ordinary endpoint cap (cap-immunity)', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    write(dir, '.env', 'VITE_API_URL=https://eu.api.example-partner.test\n');
    write(dir, 'src/env.ts', 'const base = import.meta.env.VITE_API_URL;\n');

    let bulk = '';
    for (let i = 0; i < 45; i++) {
      bulk += `apiClient.get('/bulk-endpoint-${i}');\n`;
    }
    write(dir, 'src/calls/aaa-bulk.ts', bulk);
    write(dir, 'src/calls/zzz-auth.ts', "apiClient.post('/auth/token/generate');\n");

    const deps = await detectExternalDependencies(dir);
    const dep = deps.find((d) => d.envVar === 'VITE_API_URL');
    expect(dep).toBeDefined();
    expect(dep?.endpoints?.length ?? 0).toBeGreaterThanOrEqual(40);
    expect(dep?.endpoints?.some((e) => e.pathPattern === '/auth/token/generate')).toBe(true);
  });
});
