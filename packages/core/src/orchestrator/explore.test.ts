import { describe, expect, it } from 'vitest';
import { assessExplorationUsefulness, runExplorePhase } from './explore.js';
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
      currentUrl = url;
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
        state.stopped = state.stopped; // no-op, unsub tracked separately below if needed
      };
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

function makeEmit(): { emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void; events: Array<{ phase: string; level: string; message: string; data?: unknown }> } {
  const events: Array<{ phase: string; level: string; message: string; data?: unknown }> = [];
  return {
    events,
    emit: (phase, level, message, data) => {
      events.push({ phase, level, message, data });
    },
  };
}

describe('assessExplorationUsefulness()', () => {
  function crawlResult(overrides: Partial<CrawlWithAuthResult>): CrawlWithAuthResult {
    return {
      routes: [],
      visitedCount: 0,
      budgetExhausted: false,
      redirectLoopsDetected: [],
      shellCollapsed: false,
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
          },
        ],
        visitedCount: 1,
      }),
    );
    expect(result.useful).toBe(false);
    expect(result.reason).toMatch(/single thin route/i);
  });

  it('flags shell-collapsed results as not useful', () => {
    const result = assessExplorationUsefulness(crawlResult({ routes: [], shellCollapsed: true, visitedCount: 5 }));
    // shellCollapsed alone with zero routes hits the zero-routes branch first; use >=2 routes for this case.
    const withRoutes = assessExplorationUsefulness(
      crawlResult({
        shellCollapsed: true,
        visitedCount: 2,
        routes: [
          {
            url: 'https://a.test/a',
            title: 'A',
            snapshot: { url: 'https://a.test/a', title: 'A', interactiveElements: [heading('x'), heading('y')] },
            depth: 0,
            hasPasswordField: false,
            role: 'anonymous',
          },
          {
            url: 'https://a.test/b',
            title: 'B',
            snapshot: { url: 'https://a.test/b', title: 'B', interactiveElements: [heading('x'), heading('y')] },
            depth: 1,
            hasPasswordField: false,
            role: 'anonymous',
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
          },
          {
            url: 'https://a.test/about',
            title: 'About',
            snapshot: { url: 'https://a.test/about', title: 'About', interactiveElements: [heading('f')] },
            depth: 1,
            hasPasswordField: false,
            role: 'anonymous',
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
    const warn = events.find((e) => e.phase === 'explore' && e.level === 'warn' && /thin context/i.test(e.message));
    expect(warn).toBeDefined();
  });

  it('propagates a hard navigation failure to the caller, but teardown still runs (orchestrator catches and continues)', async () => {
    const browser = makeFakeBrowser({ pages: {}, throwOnGoto: new Set(['https://a.test/']) });
    const { emit } = makeEmit();

    await expect(runExplorePhase({ browser, baseUrl: 'https://a.test/', emit })).rejects.toThrow(/fake nav failure/);

    // Teardown still ran even though the phase itself threw.
    expect(browser.stopped).toBe(true);
  });

  it('emits a warn breadcrumb (never throws) when credentials are present but login cannot be verified', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/login')] },
        'https://a.test/login': { elements: [passwordField(), { role: 'textbox', name: 'Email', selector: '#e', inputType: 'email' }] },
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
});
