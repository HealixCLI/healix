import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessExplorationUsefulness, runExplorePhase, splitStaticUnitsForExplore } from './explore.js';
import type { FunctionalityUnit } from '../target/functionality-index.js';
import { indexSource } from '../target/source-index.js';
import type { OrchestratorEvent } from './types.js';
import type {
  BrowserSurface,
  BrowserSurfaceOptions,
  DomSnapshot,
  InteractiveElement,
  Point,
} from '../browser/types.js';
import type { CrawlWithAuthResult } from '../browser/crawler.js';

interface FakePage {
  title?: string;
  elements: InteractiveElement[];
}

function makeFakeBrowser(config: {
  pages: Record<string, FakePage>;
  onClickGoTo?: Record<string, string>;
  frameOnSubscribe?: boolean;
  throwOnGoto?: Set<string>;
  redirects?: Record<string, string>;
}): BrowserSurface & { started: boolean; stopped: boolean; gotoCalls: string[] } {
  let currentUrl = '';
  const state = { started: false, stopped: false, gotoCalls: [] as string[] };
  return {
    get started() {
      return state.started;
    },
    get stopped() {
      return state.stopped;
    },
    get gotoCalls() {
      return state.gotoCalls;
    },
    async start(_opts?: BrowserSurfaceOptions): Promise<void> {
      state.started = true;
    },
    async goto(url: string): Promise<void> {
      state.gotoCalls.push(url);
      if (config.throwOnGoto?.has(url)) {
        throw new Error(`fake nav failure for ${url}`);
      }
      currentUrl = config.redirects?.[url] ?? url;
    },
    async screenshot(): Promise<Buffer> {
      return Buffer.alloc(0);
    },
    async snapshot(): Promise<DomSnapshot> {
      const page = config.pages[currentUrl];
      if (!page) throw new Error(`no fake page configured for ${currentUrl}`);
      return { url: currentUrl, title: page.title ?? currentUrl, interactiveElements: page.elements };
    },
    async click(_selector: string): Promise<void> {
      const next = config.onClickGoTo?.[currentUrl];
      if (next) currentUrl = next;
    },
    async clickAt(_point: Point): Promise<void> {},
    async type(_selector: string, _text: string): Promise<void> {},
    async pressKey(_key: string): Promise<void> {},
    onFrame(cb: (png: Buffer) => void): () => void {
      if (config.frameOnSubscribe !== false) {
        cb(Buffer.from([1, 2, 3]));
      }
      return () => {
        // no-op unsubscribe — unsub tracking (if a test needs it) happens separately below.
      };
    },
    drainNetworkEvents() {
      return [];
    },
    async stop(): Promise<void> {
      state.stopped = true;
    },
  };
}

function link(href: string, name = href): InteractiveElement {
  return { role: 'link', name, selector: `a[href="${href}"]`, href };
}

function heading(name: string): InteractiveElement {
  return { role: 'heading', name, selector: 'h1' };
}

function passwordField(): InteractiveElement {
  return { role: 'textbox', name: 'Password', selector: '#pw', inputType: 'password' };
}

function makeEmit(): {
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void;
  events: Array<{ phase: string; level: string; message: string; data?: unknown }>;
} {
  const events: Array<{ phase: string; level: string; message: string; data?: unknown }> = [];
  return {
    events,
    emit: (phase, level, message, data) => {
      events.push({ phase, level, message, data });
    },
  };
}

describe('splitStaticUnitsForExplore()', () => {
  function unit(kind: FunctionalityUnit['kind'], key: string): FunctionalityUnit {
    return { key, kind, label: key, file: 'src/App.tsx' };
  }

  it('routes route-kind units to routePaths, stripping the "route:" prefix', () => {
    const { routePaths } = splitStaticUnitsForExplore([
      unit('route', 'route:/dashboard'),
      unit('route', 'route:/settings'),
    ]);
    expect(routePaths).toEqual(['/dashboard', '/settings']);
  });

  it('routes endpoint-kind units to endpointPaths, stripping the "endpoint:METHOD " prefix', () => {
    const { endpointPaths } = splitStaticUnitsForExplore([
      unit('endpoint', 'endpoint:GET /api/users/:id'),
      unit('endpoint', 'endpoint:POST /api/orders'),
    ]);
    expect(endpointPaths).toEqual(['/api/users/:id', '/api/orders']);
  });

  it('never mixes route units into endpointPaths or vice versa', () => {
    const result = splitStaticUnitsForExplore([
      unit('route', 'route:/home'),
      unit('endpoint', 'endpoint:GET /api/health'),
    ]);
    expect(result.routePaths).toEqual(['/home']);
    expect(result.endpointPaths).toEqual(['/api/health']);
  });

  it('ignores component-kind units entirely (neither crawl seed nor probe target)', () => {
    const result = splitStaticUnitsForExplore([unit('component', 'component:Button')]);
    expect(result.routePaths).toEqual([]);
    expect(result.endpointPaths).toEqual([]);
  });

  it('caps endpointPaths at 10, never uncapping routePaths', () => {
    const units = [
      ...Array.from({ length: 20 }, (_, i) => unit('endpoint', `endpoint:GET /api/e${i}`)),
      ...Array.from({ length: 20 }, (_, i) => unit('route', `route:/r${i}`)),
    ];
    const result = splitStaticUnitsForExplore(units);
    expect(result.endpointPaths).toHaveLength(10);
    expect(result.routePaths).toHaveLength(20);
  });
});

describe('assessExplorationUsefulness()', () => {
  function crawlResult(overrides: Partial<CrawlWithAuthResult>): CrawlWithAuthResult {
    return {
      routes: [],
      visitedCount: 0,
      budgetExhausted: false,
      redirectLoopsDetected: [],
      shellCollapsed: false,
      degenerateRedirectsSkipped: [],
      authAttempted: false,
      authVerified: false,
      ...overrides,
    };
  }

  it('flags zero routes as not useful', () => {
    const result = assessExplorationUsefulness(crawlResult({ routes: [] }));
    expect(result.useful).toBe(false);
    expect(result.reason).toMatch(/zero routes/i);
  });

  it('flags a single thin (login-only) route as not useful', () => {
    const result = assessExplorationUsefulness(
      crawlResult({
        routes: [
          {
            url: 'https://a.test/login',
            title: 'Login',
            snapshot: { url: 'https://a.test/login', title: 'Login', interactiveElements: [passwordField()] },
            depth: 0,
            hasPasswordField: true,
            role: 'anonymous',
            networkEvents: [],
          },
        ],
        visitedCount: 1,
      }),
    );
    expect(result.useful).toBe(false);
    expect(result.reason).toMatch(/single thin route/i);
  });

  it('flags shell-collapsed results as not useful', () => {
    const result = assessExplorationUsefulness(
      crawlResult({ routes: [], shellCollapsed: true, visitedCount: 5 }),
    );
    // shellCollapsed alone with zero routes hits the zero-routes branch first; use >=2 routes for this case.
    const withRoutes = assessExplorationUsefulness(
      crawlResult({
        shellCollapsed: true,
        visitedCount: 2,
        routes: [
          {
            url: 'https://a.test/a',
            title: 'A',
            snapshot: {
              url: 'https://a.test/a',
              title: 'A',
              interactiveElements: [heading('x'), heading('y')],
            },
            depth: 0,
            hasPasswordField: false,
            role: 'anonymous',
            networkEvents: [],
          },
          {
            url: 'https://a.test/b',
            title: 'B',
            snapshot: {
              url: 'https://a.test/b',
              title: 'B',
              interactiveElements: [heading('x'), heading('y')],
            },
            depth: 1,
            hasPasswordField: false,
            role: 'anonymous',
            networkEvents: [],
          },
        ],
      }),
    );
    expect(result.useful).toBe(false);
    expect(withRoutes.useful).toBe(false);
    expect(withRoutes.reason).toMatch(/near-identical DOM/i);
  });

  it('treats a multi-route, multi-element crawl as useful', () => {
    const result = assessExplorationUsefulness(
      crawlResult({
        visitedCount: 2,
        routes: [
          {
            url: 'https://a.test/',
            title: 'Home',
            snapshot: {
              url: 'https://a.test/',
              title: 'Home',
              interactiveElements: [heading('a'), heading('b'), heading('c'), heading('d'), heading('e')],
            },
            depth: 0,
            hasPasswordField: false,
            role: 'anonymous',
            networkEvents: [],
          },
          {
            url: 'https://a.test/about',
            title: 'About',
            snapshot: { url: 'https://a.test/about', title: 'About', interactiveElements: [heading('f')] },
            depth: 1,
            hasPasswordField: false,
            role: 'anonymous',
            networkEvents: [],
          },
        ],
      }),
    );
    expect(result.useful).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe('runExplorePhase()', () => {
  it('crawls, detects a hash/region prefix, and ranks a password-bearing route as the top login candidate', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/#/SK/home')] },
        'https://a.test/#/SK/home': {
          elements: [link('https://a.test/#/SK/login'), link('https://a.test/#/SK/about')],
        },
        'https://a.test/#/SK/login': { elements: [passwordField()] },
        'https://a.test/#/SK/about': { elements: [heading('About')] },
      },
    });
    const { emit, events } = makeEmit();

    const artifact = await runExplorePhase({ browser, baseUrl: 'https://a.test/', emit });

    expect(artifact.routing.hashRouted).toBe(true);
    expect(artifact.routing.invariantPrefix).toBe('#/SK');
    expect(artifact.loginCandidates[0]?.url).toBe('https://a.test/#/SK/login');
    expect(artifact.loginCandidates[0]?.source).toBe('crawled');
    expect(artifact.useful).toBe(true);

    // Browser lifecycle: started, then torn down; an info event was emitted.
    expect(browser.started).toBe(true);
    expect(browser.stopped).toBe(true);
    expect(events.some((e) => e.phase === 'explore' && e.level === 'info')).toBe(true);
  });

  it('surfaces a thin-context warning breadcrumb without throwing when the crawl is login-only', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/login': { elements: [passwordField()] },
      },
    });
    const { emit, events } = makeEmit();

    const artifact = await runExplorePhase({ browser, baseUrl: 'https://a.test/login', emit });

    expect(artifact.useful).toBe(false);
    expect(artifact.uselessReason).toMatch(/single thin route/i);
    const warn = events.find(
      (e) => e.phase === 'explore' && e.level === 'warn' && /thin context/i.test(e.message),
    );
    expect(warn).toBeDefined();
  });

  it('propagates a hard navigation failure to the caller, but teardown still runs (orchestrator catches and continues)', async () => {
    const browser = makeFakeBrowser({ pages: {}, throwOnGoto: new Set(['https://a.test/']) });
    const { emit } = makeEmit();

    await expect(runExplorePhase({ browser, baseUrl: 'https://a.test/', emit })).rejects.toThrow(
      /fake nav failure/,
    );

    // Teardown still ran even though the phase itself threw.
    expect(browser.stopped).toBe(true);
  });

  it('emits a warn breadcrumb (never throws) when credentials are present but login cannot be verified', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/login')] },
        'https://a.test/login': {
          elements: [passwordField(), { role: 'textbox', name: 'Email', selector: '#e', inputType: 'email' }],
        },
      },
      // No onClickGoTo — submitting leaves the session on /login, so login is never verified.
    });
    const { emit, events } = makeEmit();

    const artifact = await runExplorePhase({
      browser,
      baseUrl: 'https://a.test/',
      credentials: { username: 'user@a.test', password: 'wrong' },
      emit,
    });

    expect(artifact.crawl.authAttempted).toBe(true);
    expect(artifact.crawl.authVerified).toBe(false);
    expect(artifact.crawl.routes.every((r) => r.role === 'anonymous')).toBe(true);
    const warn = events.find(
      (e) => e.phase === 'explore' && e.level === 'warn' && /could not be verified/i.test(e.message),
    );
    expect(warn).toBeDefined();
  });

  describe('staticRoutePaths (static-analysis route seeding)', () => {
    it('reaches a route only reachable via a static path, not linked from any crawled page', async () => {
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/': { elements: [link('https://a.test/#/SK/home')] },
          'https://a.test/#/SK/home': { elements: [heading('Home')] },
          // Not linked from home or anywhere else — only discoverable via the static path.
          'https://a.test/#/SK/admin': { elements: [heading('Admin')] },
        },
      });
      const { emit } = makeEmit();

      const artifact = await runExplorePhase({
        browser,
        baseUrl: 'https://a.test/',
        staticRoutePaths: ['/admin'],
        emit,
      });

      const adminRoute = artifact.crawl.routes.find((r) => r.url === 'https://a.test/#/SK/admin');
      expect(adminRoute).toBeDefined();
      expect(adminRoute?.role).toBe('anonymous');
    });

    it('silently skips a static path that fails to resolve, without failing the run', async () => {
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/': { elements: [] },
        },
        throwOnGoto: new Set(['https://a.test/nonexistent']),
      });
      const { emit } = makeEmit();

      const artifact = await runExplorePhase({
        browser,
        baseUrl: 'https://a.test/',
        staticRoutePaths: ['/nonexistent'],
        emit,
      });

      expect(artifact.crawl.routes.some((r) => r.url === 'https://a.test/nonexistent')).toBe(false);
      expect(artifact.crawl.routes.some((r) => r.url === 'https://a.test/')).toBe(true);
    });

    it('does not run a redundant follow-up crawl when every static path was already visited', async () => {
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/': { elements: [link('https://a.test/about')] },
          'https://a.test/about': { elements: [heading('About')] },
        },
      });
      const { emit, events } = makeEmit();

      const artifact = await runExplorePhase({
        browser,
        baseUrl: 'https://a.test/',
        staticRoutePaths: ['/about'],
        emit,
      });

      expect(artifact.crawl.routes.filter((r) => r.url === 'https://a.test/about')).toHaveLength(1);
      expect(events.some((e) => /static-analysis route seeding found/i.test(e.message))).toBe(false);
    });

    it('emits a warn breadcrumb (not a triage verdict) when a static seed resolves to a runaway redirect', async () => {
      const runaway = `https://a.test/#/${Array(8).fill('home').join('/')}`;
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/': { elements: [] },
          [runaway]: { elements: [] },
        },
        redirects: { 'https://a.test/broken': runaway },
      });
      const { emit, events } = makeEmit();

      const artifact = await runExplorePhase({
        browser,
        baseUrl: 'https://a.test/',
        staticRoutePaths: ['/broken'],
        emit,
      });

      expect(artifact.crawl.degenerateRedirectsSkipped).toEqual(['https://a.test/broken']);
      const warn = events.find(
        (e) => e.phase === 'explore' && e.level === 'warn' && /runaway redirect/i.test(e.message),
      );
      expect(warn).toBeDefined();
      expect(warn?.data).toEqual({ skipped: ['https://a.test/broken'] });
    });
  });
});

// --- Isolated check against a real fixture repo (Item E3) -------------------
// Confirms the split itself is correct against a real combined backend+frontend static-analysis
// result — the orchestrator only ever passes routePaths to the browser crawl seed and
// endpointPaths to the HTTP probe, so a correct split here is exactly what guarantees an API-only
// unit never reaches a browser navigation.

const RBAC_ROOT = path.join(
  'C:',
  'Users',
  'AdroyFernandes',
  'Documents',
  'TestApps',
  'Role-Based-Access-Control-RBAC-',
);

describe.skipIf(!fs.existsSync(RBAC_ROOT))(
  'splitStaticUnitsForExplore against the real RBAC repo (isolated check)',
  () => {
    it('classifies real backend endpoints and real frontend routes into the correct bucket, never crossed', async () => {
      const sourceContext = await indexSource(RBAC_ROOT, { maxUnits: 500 });
      const { routePaths, endpointPaths } = splitStaticUnitsForExplore(sourceContext.units);

      expect(endpointPaths).toContain('/api/users/:id');
      expect(endpointPaths.every((p) => !p.startsWith('route:'))).toBe(true);
      expect(routePaths).toContain('/userdashboard');
      expect(routePaths.every((p) => !endpointPaths.includes(p))).toBe(true);
    });
  },
);
