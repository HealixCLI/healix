import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TestModeContext } from '../types.js';
import type { ExternalDependency, MockResponse } from '../../target/types.js';
import { scaffold } from './scaffold.js';

describe('scaffold — mock fixture generation', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'healix-scaffold-test-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<TestModeContext> = {}): TestModeContext {
    return {
      projectDir,
      baseUrl: 'http://localhost:3000',
      provider: {} as TestModeContext['provider'],
      target: {} as TestModeContext['target'],
      browser: {} as TestModeContext['browser'],
      ...overrides,
    };
  }

  async function fixtureExists(): Promise<boolean> {
    try {
      await stat(join(projectDir, 'fixtures', 'mock.fixture.ts'));
      return true;
    } catch {
      return false;
    }
  }

  it('does not write a mock fixture when mocking is disabled', async () => {
    await scaffold(makeCtx());
    expect(await fixtureExists()).toBe(false);
  });

  describe('F-18 — auth-setup registration follows ctx.hasTierBAuthPlanItems', () => {
    async function readConfig(): Promise<string> {
      return readFile(join(projectDir, 'playwright.config.ts'), 'utf-8');
    }

    it("registers auth-setup by default when hasTierBAuthPlanItems is unset (today's behavior, unchanged)", async () => {
      await scaffold(makeCtx());
      expect(await readConfig()).toContain("name: 'auth-setup'");
    });

    it('registers auth-setup when the plan has at least one tierB-auth item', async () => {
      await scaffold(makeCtx({ hasTierBAuthPlanItems: true }));
      expect(await readConfig()).toContain("name: 'auth-setup'");
    });

    it('omits auth-setup when the plan has NO tierB-auth items at all (Flask-CRUD-style no-auth app)', async () => {
      await scaffold(makeCtx({ hasTierBAuthPlanItems: false }));
      const cfg = await readConfig();
      expect(cfg).not.toContain("name: 'auth-setup'");
      expect(cfg).not.toContain("dependencies: ['auth-setup']");
    });
  });

  it('writes an empty-routes mock fixture when mocking is enabled but nothing is route-interceptable', async () => {
    await scaffold(makeCtx({ mockExternalDependencies: true }));
    expect(await fixtureExists()).toBe(true);
    const contents = await readFile(join(projectDir, 'fixtures', 'mock.fixture.ts'), 'utf-8');
    expect(contents).toContain('const MOCKED_ROUTES = []');
  });

  it('embeds route-intercept/both dependencies with resolved responses', async () => {
    const deps: ExternalDependency[] = [
      {
        id: 'pkg:stripe',
        category: 'payment',
        label: 'Stripe (payments)',
        source: 'package',
        mockStrategy: 'route-intercept',
        hostnames: ['api.stripe.com'],
      },
      {
        id: 'pkg:nodemailer',
        category: 'email',
        label: 'Nodemailer (SMTP email)',
        source: 'package',
        mockStrategy: 'undeterminable',
      },
    ];
    const mockResponses: Record<string, MockResponse> = {
      'pkg:stripe': { status: 200, body: { status: 'succeeded' } },
    };

    await scaffold(makeCtx({ mockExternalDependencies: true, externalDependencies: deps, mockResponses }));
    const contents = await readFile(join(projectDir, 'fixtures', 'mock.fixture.ts'), 'utf-8');
    expect(contents).toContain('"id": "pkg:stripe"');
    expect(contents).toContain('"api.stripe.com"');
    // The undeterminable dependency (no route-intercept strategy) must not appear.
    expect(contents).not.toContain('pkg:nodemailer');
  });

  it('emits an auth-tagged endpoint\'s own (token-bearing) response, not the flat dependency-level body, for a "backend"-category host (Fix 1 end-to-end)', async () => {
    const deps: ExternalDependency[] = [
      {
        id: 'env:VITE_API_URL',
        category: 'backend',
        label: 'Backend API (VITE_API_URL)',
        source: 'env-var',
        mockStrategy: 'both',
        hostnames: ['eu.api.example-partner.test'],
        endpoints: [
          {
            method: 'POST',
            pathPattern: '/auth/token/generate',
            category: 'auth',
            response: {
              status: 200,
              body: { token: 'healix-mock-jwt-token', access_token: 'healix-mock-jwt-token' },
            },
          },
        ],
      },
    ];
    const mockResponses: Record<string, MockResponse> = {
      'env:VITE_API_URL': { status: 200, body: {} },
    };

    await scaffold(makeCtx({ mockExternalDependencies: true, externalDependencies: deps, mockResponses }));
    const contents = await readFile(join(projectDir, 'fixtures', 'mock.fixture.ts'), 'utf-8');
    expect(contents).toContain('/auth/token/generate');
    expect(contents).toContain('healix-mock-jwt-token');
  });

  it('attributes real EXPLORE-observed endpoints to the dependency whose hostname they were seen on, even with no static endpoint detection (GAP-046 + multi-dependency case)', async () => {
    const deps: ExternalDependency[] = [
      {
        id: 'env:VITE_API_BASE_URL',
        category: 'backend',
        label: 'Backend API (VITE_API_BASE_URL)',
        source: 'env-var',
        mockStrategy: 'both',
        hostnames: ['eu.api.example.com'],
      },
      {
        id: 'env:VITE_MOBILE_WRAPPER_URL',
        category: 'backend',
        label: 'Backend API (VITE_MOBILE_WRAPPER_URL)',
        source: 'env-var',
        mockStrategy: 'both',
        hostnames: ['eu-api-gateway.example.com'],
      },
    ];
    const mockResponses: Record<string, MockResponse> = {
      'env:VITE_API_BASE_URL': { status: 200, body: { profile: true } },
      'env:VITE_MOBILE_WRAPPER_URL': { status: 200, body: { wrapper: true } },
    };
    const ctx = makeCtx({
      mockExternalDependencies: true,
      externalDependencies: deps,
      mockResponses,
      exploration: {
        crawl: {
          routes: [],
          visitedCount: 0,
          budgetExhausted: false,
          redirectLoopsDetected: [],
          shellCollapsed: false,
          degenerateRedirectsSkipped: [],
          authAttempted: false,
          authVerified: false,
        },
        routing: { hashRouted: false },
        loginCandidates: [],
        useful: true,
        observedEndpoints: [
          {
            method: 'GET',
            pathPattern: '/mobile/v2/api/customer/coupons',
            status: 200,
            sampleResponseBody: '{"entity":{"customers":[{"coupons":[]}]}}',
            host: 'eu-api-gateway.example.com',
          },
          {
            method: 'GET',
            pathPattern: '/auth/profile',
            status: 200,
            sampleResponseBody: '{"userId":"abc"}',
            host: 'eu.api.example.com',
          },
        ],
      },
    } as unknown as Partial<TestModeContext>);

    await scaffold(ctx);
    const contents = await readFile(join(projectDir, 'fixtures', 'mock.fixture.ts'), 'utf-8');
    expect(contents).toContain('/mobile/v2/api/customer/coupons');
    expect(contents).toContain('/auth/profile');

    const routesMatch = /const MOCKED_ROUTES = (\[[\s\S]*?\n\]);/.exec(contents);
    expect(routesMatch).not.toBeNull();
    const routes = JSON.parse(routesMatch![1]);
    const wrapperRoute = routes.find((r: { id: string }) => r.id === 'env:VITE_MOBILE_WRAPPER_URL');
    const backendRoute = routes.find((r: { id: string }) => r.id === 'env:VITE_API_BASE_URL');

    // The coupons endpoint's per-path mock lives on the wrapper dependency, not the profile one.
    expect(wrapperRoute.endpoints).toEqual([
      expect.objectContaining({
        method: 'GET',
        pathPattern: '/mobile/v2/api/customer/coupons',
        response: { status: 200, body: { entity: { customers: [{ coupons: [] }] } } },
      }),
    ]);
    expect(backendRoute.endpoints).toEqual([
      expect.objectContaining({
        method: 'GET',
        pathPattern: '/auth/profile',
        response: { status: 200, body: { userId: 'abc' } },
      }),
    ]);
  });

  it('falls back to {} (not the raw string) for an observed body that is not valid JSON, e.g. a truncated capture (GAP-063)', async () => {
    const deps: ExternalDependency[] = [
      {
        id: 'env:VITE_API_BASE_URL',
        category: 'backend',
        label: 'Backend API (VITE_API_BASE_URL)',
        source: 'env-var',
        mockStrategy: 'both',
        hostnames: ['eu.api.example.com'],
      },
    ];
    const ctx = makeCtx({
      mockExternalDependencies: true,
      externalDependencies: deps,
      mockResponses: { 'env:VITE_API_BASE_URL': { status: 200, body: { profile: true } } },
      exploration: {
        crawl: {
          routes: [],
          visitedCount: 0,
          budgetExhausted: false,
          redirectLoopsDetected: [],
          shellCollapsed: false,
          degenerateRedirectsSkipped: [],
          authAttempted: false,
          authVerified: false,
        },
        routing: { hashRouted: false },
        loginCandidates: [],
        useful: true,
        observedEndpoints: [
          {
            method: 'GET',
            pathPattern: '/customer/getbyemail',
            status: 200,
            // Mirrors a real capture cut mid-structure at browser/index.ts's char cap.
            sampleResponseBody: '{"entity":{"customers":[{"id":"abc123","email":"user@examp…',
            host: 'eu.api.example.com',
          },
        ],
      },
    } as unknown as Partial<TestModeContext>);

    await scaffold(ctx);
    const contents = await readFile(join(projectDir, 'fixtures', 'mock.fixture.ts'), 'utf-8');
    const routesMatch = /const MOCKED_ROUTES = (\[[\s\S]*?\n\]);/.exec(contents);
    const routes = JSON.parse(routesMatch![1]);
    const route = routes.find((r: { id: string }) => r.id === 'env:VITE_API_BASE_URL');
    const endpoint = route.endpoints.find(
      (e: { pathPattern: string }) => e.pathPattern === '/customer/getbyemail',
    );
    expect(endpoint.response.body).toEqual({});
  });

  it('lets a statically-detected endpoint win over an observed one for the same (method, path)', async () => {
    const deps: ExternalDependency[] = [
      {
        id: 'env:VITE_API_BASE_URL',
        category: 'backend',
        label: 'Backend API',
        source: 'env-var',
        mockStrategy: 'both',
        hostnames: ['api.example.com'],
        endpoints: [
          {
            method: 'GET',
            pathPattern: '/customer/profile',
            response: { status: 200, body: { fromStatic: true } },
          },
        ],
      },
    ];
    const mockResponses: Record<string, MockResponse> = {
      'env:VITE_API_BASE_URL': { status: 200, body: {} },
    };
    const ctx = makeCtx({
      mockExternalDependencies: true,
      externalDependencies: deps,
      mockResponses,
      exploration: {
        crawl: {
          routes: [],
          visitedCount: 0,
          budgetExhausted: false,
          redirectLoopsDetected: [],
          shellCollapsed: false,
          degenerateRedirectsSkipped: [],
          authAttempted: false,
          authVerified: false,
        },
        routing: { hashRouted: false },
        loginCandidates: [],
        useful: true,
        observedEndpoints: [
          {
            method: 'GET',
            pathPattern: '/customer/profile',
            status: 200,
            sampleResponseBody: '{"fromObserved":true}',
            host: 'api.example.com',
          },
        ],
      },
    } as unknown as Partial<TestModeContext>);

    await scaffold(ctx);
    const contents = await readFile(join(projectDir, 'fixtures', 'mock.fixture.ts'), 'utf-8');
    expect(contents).toContain('fromStatic');
    expect(contents).not.toContain('fromObserved');
  });
});
