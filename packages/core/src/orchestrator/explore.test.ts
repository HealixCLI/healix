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
    async exportStorageState() {
      return {};
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

  it('directed exploration: moves priority-keyed routes to the front, preserving relative order within each group', () => {
    const { routePaths } = splitStaticUnitsForExplore(
      [
        unit('route', 'route:/home'),
        unit('route', 'route:/dashboard'),
        unit('route', 'route:/settings'),
        unit('route', 'route:/checkout'),
      ],
      new Set(['route:/settings', 'route:/checkout']),
    );
    expect(routePaths).toEqual(['/settings', '/checkout', '/home', '/dashboard']);
  });

  it('directed exploration: a priority-keyed endpoint survives the MAX_ENDPOINT_PROBES truncation even when it would otherwise be cut off', () => {
    const units = Array.from({ length: 20 }, (_, i) => unit('endpoint', `endpoint:GET /api/e${i}`));
    // e15 is well past the 10-item cap in plain discovery order.
    const { endpointPaths } = splitStaticUnitsForExplore(units, new Set(['endpoint:GET /api/e15']));
    expect(endpointPaths).toContain('/api/e15');
    expect(endpointPaths).toHaveLength(10);
  });

  it('directed exploration: an absent/empty priority set behaves identically to no priority at all', () => {
    const units = [unit('route', 'route:/a'), unit('route', 'route:/b')];
    expect(splitStaticUnitsForExplore(units, new Set())).toEqual(splitStaticUnitsForExplore(units));
    expect(splitStaticUnitsForExplore(units, undefined)).toEqual(splitStaticUnitsForExplore(units));
  });

  it('directed exploration: a priority key matching nothing has no effect', () => {
    const units = [unit('route', 'route:/a'), unit('route', 'route:/b')];
    expect(splitStaticUnitsForExplore(units, new Set(['route:/nonexistent']))).toEqual(
      splitStaticUnitsForExplore(units),
    );
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

  /** Builds a route with `n` heading elements (>= THIN_ROUTE_ELEMENT_THRESHOLD=5 counts as "rich", < 5 as "thin"). */
  function routeWithElements(url: string, n: number): CrawlWithAuthResult['routes'][number] {
    return {
      url,
      title: url,
      snapshot: {
        url,
        title: url,
        interactiveElements: Array.from({ length: n }, (_, i) => heading(`h${i}`)),
      },
      depth: 0,
      hasPasswordField: false,
      role: 'anonymous',
      networkEvents: [],
    };
  }

  it('reports a thinRouteRatio degradation signal for a multi-route crawl where most routes are near-empty (F-03/F-06)', () => {
    const routes = [
      ...Array.from({ length: 8 }, (_, i) => routeWithElements(`https://a.test/thin-${i}`, 1)),
      routeWithElements('https://a.test/rich-1', 8),
      routeWithElements('https://a.test/rich-2', 6),
    ];
    const result = assessExplorationUsefulness(crawlResult({ routes, visitedCount: routes.length }));
    // Still "useful" — this is a degradation signal, not a new hard-fail.
    expect(result.useful).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.thinRouteRatio).toBeCloseTo(0.8, 5);
  });

  it('pins the thinRouteRatio boundary at exactly 50% thin routes', () => {
    const routes = [
      routeWithElements('https://a.test/thin-1', 0),
      routeWithElements('https://a.test/thin-2', 2),
      routeWithElements('https://a.test/rich-1', 5),
      routeWithElements('https://a.test/rich-2', 10),
    ];
    const result = assessExplorationUsefulness(crawlResult({ routes, visitedCount: routes.length }));
    expect(result.useful).toBe(true);
    expect(result.thinRouteRatio).toBeCloseTo(0.5, 5);
  });

  it('returns a low thinRouteRatio when nearly all routes are richly populated', () => {
    const routes = [
      routeWithElements('https://a.test/rich-1', 10),
      routeWithElements('https://a.test/rich-2', 12),
      routeWithElements('https://a.test/rich-3', 9),
      routeWithElements('https://a.test/thin-1', 1),
    ];
    const result = assessExplorationUsefulness(crawlResult({ routes, visitedCount: routes.length }));
    expect(result.useful).toBe(true);
    expect(result.thinRouteRatio).toBeCloseTo(0.25, 5);
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

  // Runs ~10s on purpose: login is only CONFIRMED failed once login.ts's
  // LOGIN_SETTLE_TIMEOUT_MS has elapsed. Fits this package's 15s testTimeout (vitest.config.ts).
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

  describe('knownRegionCodes (same-context region-seed injection)', () => {
    it('derives and crawls a sibling-region route not linked from the primary crawl, reusing the same session', async () => {
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/': { elements: [link('https://a.test/#/SK/home')] },
          'https://a.test/#/SK/home': { elements: [heading('Vitajte')] },
          // Never linked from anywhere in the SK subtree — only reachable by substituting the
          // region prefix, exactly the scenario found in the real C&A app.
          'https://a.test/#/CZ/home': { elements: [heading('Vítejte'), heading('Extra')] },
        },
      });
      const { emit, events } = makeEmit();

      const artifact = await runExplorePhase({
        browser,
        baseUrl: 'https://a.test/',
        knownRegionCodes: ['SK', 'CZ'],
        emit,
      });

      const czRoute = artifact.crawl.routes.find((r) => r.url === 'https://a.test/#/CZ/home');
      expect(czRoute).toBeDefined();
      expect(czRoute?.seedLabel).toBe('CZ');
      expect(artifact.seedsCrawled).toEqual([{ url: '#/SK/CZ', label: 'CZ', routeCount: 1 }]);
      expect(events.some((e) => /region-seed fan-out found/i.test(e.message))).toBe(true);
    });

    it('does nothing when knownRegionCodes is empty', async () => {
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/': { elements: [link('https://a.test/#/SK/home')] },
          'https://a.test/#/SK/home': { elements: [heading('Vitajte')] },
        },
      });
      const { emit, events } = makeEmit();

      const artifact = await runExplorePhase({
        browser,
        baseUrl: 'https://a.test/',
        emit,
      });

      expect(artifact.seedsCrawled).toBeUndefined();
      expect(events.some((e) => /region-seed fan-out/i.test(e.message))).toBe(false);
    });
  });

  describe('onBeforeStop hook', () => {
    it('calls onBeforeStop with the still-live browser before stop() tears it down', async () => {
      const browser = makeFakeBrowser({
        pages: { 'https://a.test/': { elements: [] } },
      });
      const { emit } = makeEmit();
      let sawStoppedAtHookTime: boolean | undefined;

      await runExplorePhase({
        browser,
        baseUrl: 'https://a.test/',
        onBeforeStop: (b) => {
          sawStoppedAtHookTime = (b as typeof browser).stopped;
        },
        emit,
      });

      expect(sawStoppedAtHookTime).toBe(false);
      expect(browser.stopped).toBe(true);
    });

    it('never lets a failing onBeforeStop hook abort the run', async () => {
      const browser = makeFakeBrowser({
        pages: { 'https://a.test/': { elements: [] } },
      });
      const { emit } = makeEmit();

      const artifact = await runExplorePhase({
        browser,
        baseUrl: 'https://a.test/',
        onBeforeStop: () => {
          throw new Error('boom');
        },
        emit,
      });

      expect(artifact).toBeDefined();
      expect(browser.stopped).toBe(true);
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
