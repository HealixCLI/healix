import { describe, expect, it } from 'vitest';
import {
  crawl,
  crawlWithAuth,
  reconcileStaticRoutePaths,
  scoreLoginCandidates,
  type RoutePrefixInfo,
} from './crawler.js';
import type {
  BrowserSurface,
  BrowserSurfaceOptions,
  CapturedNetworkEvent,
  DomSnapshot,
  InteractiveElement,
  Point,
} from './types.js';

interface FakePage {
  title?: string;
  elements: InteractiveElement[];
  /** Network traffic to hand back from drainNetworkEvents() after navigating to this page. */
  network?: CapturedNetworkEvent[];
  /** Simulated `ariaSnapshot()` output — a plain string, matching the real DomSnapshot.axTree shape. */
  axTree?: unknown;
  /** Simulated captured modal/body text (see browser/index.ts's snapshot() — crawler.ts itself
   * does no modal-text capture; this just confirms it passes both fields through untouched. */
  modalText?: string;
  bodyText?: string;
}

/**
 * A fake BrowserSurface driven purely by a URL->page map, keyed by the final
 * (post-redirect) URL. `redirects` maps a requested URL to the URL goto()
 * actually lands on, mirroring how a real page's `page.url()` can differ from
 * what was requested. `onClickGoTo` maps a source URL to a destination URL,
 * simulating a login form's submit button navigating on success.
 * `onClickSelectorGoTo` maps a specific clicked selector to a destination URL
 * (regardless of the current URL) — used to give two candidates on the same
 * page distinct destinations for click-probing tests. `onClickSelectorReveal`
 * maps a specific clicked selector to a replacement element list shown on the
 * SAME URL (no navigation) — models a client-side view toggle (e.g. a
 * register<->login switch that doesn't change the route); `pressKey('Escape')`
 * reverts back to the page's original elements, and any `goto()` also clears
 * the reveal (client-side toggle state doesn't survive a fresh navigation).
 * `log`, when provided, records every `goto`/`click` call (as `goto:<url>` /
 * `click:<selector>`) in order, so tests can assert reset-after-click
 * sequencing.
 */
function makeFakeBrowser(config: {
  pages: Record<string, FakePage>;
  redirects?: Record<string, string>;
  throwFor?: Set<string>;
  delayMs?: number;
  onClickGoTo?: Record<string, string>;
  onClickSelectorGoTo?: Record<string, string>;
  onClickSelectorReveal?: Record<string, InteractiveElement[]>;
  recordClicks?: string[];
  /** Records every selector passed to type(), in call order — used to assert fillSafeInputs'
   * safety filters (never password/file/OTP-shaped fields). */
  recordTypes?: string[];
  log?: string[];
}): BrowserSurface {
  let currentUrl = '';
  let networkBuffer: CapturedNetworkEvent[] = [];
  let revealedElements: InteractiveElement[] | undefined;
  return {
    async start(_opts?: BrowserSurfaceOptions): Promise<void> {},
    async goto(url: string): Promise<void> {
      config.log?.push(`goto:${url}`);
      revealedElements = undefined;
      if (config.throwFor?.has(url)) {
        // Model a request that actually fired (and would otherwise leak into the
        // next route's drain) even though this navigation ultimately fails.
        const events = config.pages[url]?.network;
        if (events) networkBuffer.push(...events);
        throw new Error(`fake nav failure for ${url}`);
      }
      if (config.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, config.delayMs));
      }
      currentUrl = config.redirects?.[url] ?? url;
      const events = config.pages[currentUrl]?.network;
      if (events) networkBuffer.push(...events);
    },
    async screenshot(): Promise<Buffer> {
      return Buffer.alloc(0);
    },
    async snapshot(): Promise<DomSnapshot> {
      const page = config.pages[currentUrl];
      if (!page) {
        throw new Error(`no fake page configured for ${currentUrl}`);
      }
      return {
        url: currentUrl,
        title: page.title ?? currentUrl,
        interactiveElements: revealedElements ?? page.elements,
        axTree: page.axTree,
        modalText: page.modalText,
        bodyText: page.bodyText,
      };
    },
    async click(selector: string): Promise<void> {
      config.recordClicks?.push(selector);
      config.log?.push(`click:${selector}`);
      const reveal = config.onClickSelectorReveal?.[selector];
      if (reveal) {
        revealedElements = reveal;
        return;
      }
      const bySelector = config.onClickSelectorGoTo?.[selector];
      if (bySelector) {
        currentUrl = bySelector;
        revealedElements = undefined;
        return;
      }
      const next = config.onClickGoTo?.[currentUrl];
      if (next) {
        currentUrl = next;
        revealedElements = undefined;
      }
    },
    async clickAt(_point: Point): Promise<void> {},
    async type(selector: string, _text: string): Promise<void> {
      config.recordTypes?.push(selector);
    },
    async pressKey(key: string): Promise<void> {
      if (key === 'Escape') revealedElements = undefined;
    },
    onFrame(_cb: (png: Buffer) => void): () => void {
      return () => {};
    },
    drainNetworkEvents(): CapturedNetworkEvent[] {
      const drained = networkBuffer;
      networkBuffer = [];
      return drained;
    },
    async stop(): Promise<void> {},
  };
}

function link(href: string, name = href): InteractiveElement {
  return { role: 'link', name, selector: `a[href="${href}"]`, href };
}

function button(name: string): InteractiveElement {
  return { role: 'button', name, selector: `button:has-text("${name}")` };
}

describe('crawl()', () => {
  it('a single-page app with no links terminates after exactly one node', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [button('Submit')] },
      },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.url).toBe('https://a.test/');
    expect(result.visitedCount).toBe(1);
    expect(result.budgetExhausted).toBe(false);
    expect(result.shellCollapsed).toBe(false);
    expect(result.redirectLoopsDetected).toEqual([]);
  });

  it('skips (does not record) a runaway redirect that recursively appends a segment to itself', async () => {
    // Observed live against a real hash-routed SPA: navigating directly to an
    // unrecognized path triggers an unmatched-route fallback that keeps
    // re-appending "/home" to the hash, producing an ever-growing URL that
    // never repeats a prior one (so redirectLoopsDetected's A<->B check
    // never fires) but is obviously not a real route.
    const runaway = `https://a.test/#/${Array(8).fill('home').join('/')}`;
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/unknown-route': { elements: [] },
        [runaway]: { elements: [] },
      },
      redirects: { 'https://a.test/unknown-route': runaway },
    });

    const result = await crawl(browser, 'https://a.test/unknown-route');

    expect(result.routes).toEqual([]);
    expect(result.visitedCount).toBe(0);
    // Recorded (not silently dropped) so callers can surface it as a breadcrumb.
    expect(result.degenerateRedirectsSkipped).toEqual(['https://a.test/unknown-route']);
  });

  it('does not flag a URL with only a few repeated segments as degenerate', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/#/home/home/home': { elements: [button('ok')] },
      },
    });

    const result = await crawl(browser, 'https://a.test/#/home/home/home');
    expect(result.degenerateRedirectsSkipped).toEqual([]);

    expect(result.routes).toHaveLength(1);
  });

  it('follows same-origin links and visits each linked page once', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/about'), link('https://a.test/contact')] },
        'https://a.test/about': { elements: [button('Back')] },
        'https://a.test/contact': { elements: [button('Send')] },
      },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.visitedCount).toBe(3);
    const urls = result.routes.map((r) => r.url).sort();
    expect(urls).toEqual(['https://a.test/', 'https://a.test/about', 'https://a.test/contact']);
    expect(result.budgetExhausted).toBe(false);
    // BFS: the seed is depth 0, its direct links are depth 1.
    expect(result.routes.find((r) => r.url === 'https://a.test/')?.depth).toBe(0);
    expect(result.routes.find((r) => r.url === 'https://a.test/about')?.depth).toBe(1);
  });

  it('never re-visits a URL already visited (no infinite loop on a cyclic link graph)', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/about')] },
        'https://a.test/about': { elements: [link('https://a.test/')] }, // links back to home
      },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.visitedCount).toBe(2);
    expect(result.budgetExhausted).toBe(false);
  });

  it('detects a two-node redirect ping-pong and does not loop forever', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/home': { elements: [] },
        'https://a.test/x': { elements: [] },
        'https://a.test/y': { elements: [] },
      },
      redirects: {
        'https://a.test/x': 'https://a.test/y',
        'https://a.test/y': 'https://a.test/x',
      },
    });

    const result = await crawl(browser, 'https://a.test/home', {
      seedRoutes: ['https://a.test/x', 'https://a.test/y'],
    });

    expect(result.redirectLoopsDetected).toHaveLength(1);
    expect(result.redirectLoopsDetected[0]).toMatch(/x.*<->.*y|y.*<->.*x/);
    // home + the one resolved page from following x -> y; the ping-pong branch contributes no route.
    expect(result.visitedCount).toBe(2);
  });

  it('flags shellCollapsed when most visited routes render an identical DOM fingerprint', async () => {
    const shellElements = [button('Menu'), button('Search')];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': {
          elements: [
            link('https://a.test/p1'),
            link('https://a.test/p2'),
            link('https://a.test/p3'),
            link('https://a.test/p4'),
            ...shellElements,
          ],
        },
        'https://a.test/p1': { elements: shellElements },
        'https://a.test/p2': { elements: shellElements },
        'https://a.test/p3': { elements: shellElements },
        'https://a.test/p4': { elements: shellElements },
      },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.visitedCount).toBe(5);
    expect(result.shellCollapsed).toBe(true);
  });

  it('caps at maxRoutes on a large reachable graph and reports budgetExhausted', async () => {
    const pages: Record<string, FakePage> = {};
    const chainLength = 10;
    for (let i = 0; i < chainLength; i += 1) {
      const url = `https://a.test/p${i}`;
      const next = i + 1 < chainLength ? [link(`https://a.test/p${i + 1}`)] : [];
      pages[url] = { elements: next };
    }

    const browser = makeFakeBrowser({ pages });
    const result = await crawl(browser, 'https://a.test/p0', { maxRoutes: 3 });

    expect(result.visitedCount).toBe(3);
    expect(result.budgetExhausted).toBe(true);
  });

  it('stops early on the wall-clock budget when pages resolve slowly', async () => {
    const pages: Record<string, FakePage> = {};
    const chainLength = 20;
    for (let i = 0; i < chainLength; i += 1) {
      const url = `https://a.test/p${i}`;
      const next = i + 1 < chainLength ? [link(`https://a.test/p${i + 1}`)] : [];
      pages[url] = { elements: next };
    }

    const browser = makeFakeBrowser({ pages, delayMs: 15 });
    const result = await crawl(browser, 'https://a.test/p0', {
      maxRoutes: 1000,
      wallClockBudgetMs: 40,
    });

    expect(result.budgetExhausted).toBe(true);
    expect(result.visitedCount).toBeLessThan(chainLength);
    expect(result.visitedCount).toBeGreaterThan(0);
  });

  it('skips a dead link (goto throws) without crashing the rest of the crawl', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/good'), link('https://a.test/bad')] },
        'https://a.test/good': { elements: [] },
      },
      throwFor: new Set(['https://a.test/bad']),
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.routes.map((r) => r.url).sort()).toEqual(['https://a.test/', 'https://a.test/good']);
    expect(result.visitedCount).toBe(2);
  });

  it('marks a route hasPasswordField when its snapshot has a password input', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/login': {
          elements: [{ role: 'textbox', name: 'Password', selector: '#pw', inputType: 'password' }],
        },
      },
    });

    const result = await crawl(browser, 'https://a.test/login');

    expect(result.routes[0]?.hasPasswordField).toBe(true);
  });

  it('ignores cross-origin, mailto, tel, and javascript: links', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': {
          elements: [
            link('https://other.test/x'),
            link('mailto:hi@a.test'),
            link('tel:+15555550100'),
            { role: 'link', name: 'js', selector: 'a#js', href: 'javascript:void(0)' },
          ],
        },
      },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.visitedCount).toBe(1);
  });
});

describe('crawl() click-probing (route discovery beyond <a href>)', () => {
  it('discovers a route reachable only via a button click when the link queue is thin (SPA nav without <a href>)', async () => {
    // Mirrors the real-world case this closes (GAP-042): a page whose only
    // navigation is a <button>, not a real anchor, so extractLinks() alone
    // would stall the crawl at exactly one route.
    const signIn = button('Sign In');
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [signIn] },
        'https://a.test/login': { elements: [button('Continue')] },
      },
      onClickGoTo: { 'https://a.test/': 'https://a.test/login' },
      recordClicks,
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.visitedCount).toBe(2);
    expect(result.routes.map((r) => r.url).sort()).toEqual(['https://a.test/', 'https://a.test/login']);
    expect(recordClicks).toContain(signIn.selector);
  });

  it('never click-probes a control whose name reads as a destructive/mutating action', async () => {
    const unsafeButton = button('Delete account');
    const safeButton = button('View Menu');
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [unsafeButton, safeButton] },
        'https://a.test/menu': { elements: [] },
      },
      onClickGoTo: { 'https://a.test/': 'https://a.test/menu' },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks).not.toContain(unsafeButton.selector);
    expect(recordClicks).toContain(safeButton.selector);
  });

  it('DOES click-probe a "Register"/"Sign up" nav control — navigating there is safe, only the submit is excluded', async () => {
    // A button-driven SPA nav often renders "Register"/"Create account" as a plain <button
    // onClick> rather than a real <a href> — excluding it by name would hide that whole route on
    // any app whose primary entry point uses that wording, when the actual mutation (account
    // creation) is already independently blocked via buttonType==='submit'.
    const registerButton = button('Register now');
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [registerButton] },
        'https://a.test/register': { elements: [] },
      },
      onClickGoTo: { 'https://a.test/': 'https://a.test/register' },
      recordClicks,
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(recordClicks).toContain(registerButton.selector);
    expect(result.routes.map((r) => r.url)).toContain('https://a.test/register');
  });

  it('does click-probe a non-submit control inside a <form> (e.g. a login/register view toggle)', async () => {
    // Some apps put their login<->register view toggle inside the
    // registration <form> (a "Log in instead" button that isn't itself a
    // submit control). Excluding every in-form button meant the crawler
    // could discover the registration route but never the login route
    // behind that toggle. A non-submit in-form button can't mutate/submit
    // the form, so it's no riskier than any other click-probe candidate.
    const inFormToggle: InteractiveElement = {
      role: 'button',
      name: 'Log in instead',
      selector: '#toggle-login-btn',
      inForm: true,
    };
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: [inFormToggle] } },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks).toEqual(['#toggle-login-btn']);
  });

  it('records a same-URL login-toggle reveal as loginToggleSelector on the route', async () => {
    // The exact bug scenario: a register-only page (no dedicated /login
    // route) whose in-form "Log in instead" toggle flips to a login view via
    // client-side state, without changing the URL. Naively, this would fall
    // into the generic "menu/dropdown" branch and be discarded — leaving no
    // trace that a real login view was ever reachable.
    const inFormToggle: InteractiveElement = {
      role: 'button',
      name: 'Log in instead',
      selector: '#toggle-login-btn',
      inForm: true,
    };
    const registerElements = [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON, inFormToggle];
    const loginElements = [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/register': { elements: registerElements } },
      onClickSelectorReveal: { '#toggle-login-btn': loginElements },
    });

    const result = await crawl(browser, 'https://a.test/register');

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.loginToggleSelector).toBe('#toggle-login-btn');
  });

  it('does not record loginToggleSelector for an ordinary same-URL toggle (menu/dropdown) whose name does not read as login', async () => {
    const menuToggle: InteractiveElement = {
      role: 'button',
      name: 'Options',
      selector: '#menu-toggle',
      inForm: true,
    };
    const revealedMenu = [{ role: 'link', name: 'Help', selector: 'a#help', href: 'https://a.test/help' }];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [menuToggle] },
        'https://a.test/help': { elements: [] },
      },
      onClickSelectorReveal: { '#menu-toggle': revealedMenu },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.routes[0]?.loginToggleSelector).toBeUndefined();
    // The regular reveal-then-Escape behavior (extract links, close menu) is unaffected.
    expect(result.routes.map((r) => r.url).sort()).toEqual(['https://a.test/', 'https://a.test/help']);
  });

  it('never click-probes a submit-type control inside a <form>', async () => {
    const inFormSubmit: InteractiveElement = {
      role: 'button',
      name: 'Continue',
      selector: '#continue-btn',
      inForm: true,
      buttonType: 'submit',
    };
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: [inFormSubmit] } },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks).toEqual([]);
  });

  it('never click-probes a disabled control', async () => {
    const disabledButton: InteractiveElement = {
      role: 'button',
      name: 'Next',
      selector: '#next-btn',
      disabled: true,
    };
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: [disabledButton] } },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks).toEqual([]);
  });

  it('never click-probes a submit-type button', async () => {
    const submitButton: InteractiveElement = {
      role: 'button',
      name: 'Next',
      selector: '#next',
      buttonType: 'submit',
    };
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: [submitButton] } },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks).toEqual([]);
  });

  it('does not spend route-discovery click budget on a page while the link-following queue still has 5+ pending URLs, but still deep-probes it (GAP-056)', async () => {
    // The link-queue-thin gate exists to avoid GUESSING at a new route via a click when there
    // are plenty of real links left to follow — a route-discovery-specific tradeoff. It does NOT
    // apply to deep-probing (looking for a same-URL modal/panel behind a button on THIS page,
    // see GAP-056): a live audit found exactly this shape on a page that had plenty of other
    // content too, so gating deep-probing on "is the link queue idle" would keep missing it.
    const extraNav = button('Extra Nav');
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': {
          elements: [
            link('https://a.test/p1'),
            link('https://a.test/p2'),
            link('https://a.test/p3'),
            link('https://a.test/p4'),
            link('https://a.test/p5'),
            extraNav,
          ],
        },
        'https://a.test/p1': { elements: [] },
        'https://a.test/p2': { elements: [] },
        'https://a.test/p3': { elements: [] },
        'https://a.test/p4': { elements: [] },
        'https://a.test/p5': { elements: [] },
      },
      recordClicks,
    });

    const result = await crawl(browser, 'https://a.test/');

    // The click happens (deep-probing engaged), but reveals nothing meaningful on this fixture
    // (no onClickSelectorReveal configured for extraNav), so it's harmless and no state is recorded.
    expect(recordClicks).toEqual([extraNav.selector]);
    expect(result.routes.some((r) => r.stateKey)).toBe(false);
  });

  it('caps click-probes at 8 candidates on a single page even with more safe candidates available', async () => {
    const buttons = Array.from({ length: 10 }, (_, i) => button(`Nav ${i}`));
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: buttons } },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks.length).toBeLessThanOrEqual(8);
  });

  it('resets to the original page after each navigating click, so every safe candidate is tried from the same starting point', async () => {
    const btnA = button('Go A');
    const btnB = button('Go B');
    const log: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [btnA, btnB] },
        'https://a.test/a': { elements: [] },
        'https://a.test/b': { elements: [] },
      },
      onClickSelectorGoTo: {
        [btnA.selector]: 'https://a.test/a',
        [btnB.selector]: 'https://a.test/b',
      },
      log,
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.routes.map((r) => r.url).sort()).toEqual([
      'https://a.test/',
      'https://a.test/a',
      'https://a.test/b',
    ]);
    // Each navigating click must be followed by a reset goto() back to the
    // original page BEFORE the next candidate is clicked — otherwise btnB
    // would be clicked from page /a instead of from the original page.
    expect(log).toEqual([
      'goto:https://a.test/',
      `click:${btnA.selector}`,
      'goto:https://a.test/',
      `click:${btnB.selector}`,
      'goto:https://a.test/',
      'goto:https://a.test/a',
      'goto:https://a.test/b',
    ]);
  });

  it('exhausts the total click-probe budget across the crawl, not just per page', async () => {
    // 10 pages reachable only by clicking a button (no <a href>), each
    // offering 4 safe candidates (the per-page max). Spending 4 clicks per
    // page against a crawl-wide budget of 20 means only ~5 of the 10 pages
    // can ever be reached via click-probing — proving the budget is shared
    // across the whole crawl, not reset per page.
    const navButtons = () => [button('Nav A'), button('Nav B'), button('Nav C'), button('Nav D')];
    const pageCount = 10;
    const recordClicks: string[] = [];
    const pages: Record<string, FakePage> = { 'https://a.test/': { elements: navButtons() } };
    const onClickGoTo: Record<string, string> = { 'https://a.test/': 'https://a.test/p0' };
    for (let i = 0; i < pageCount; i += 1) {
      const url = `https://a.test/p${i}`;
      pages[url] = { elements: navButtons() };
      onClickGoTo[url] = i + 1 < pageCount ? `https://a.test/p${i + 1}` : 'https://a.test/pEnd';
    }
    pages['https://a.test/pEnd'] = { elements: [] };

    const browser = makeFakeBrowser({ pages, onClickGoTo, recordClicks });

    const result = await crawl(browser, 'https://a.test/');

    expect(recordClicks.length).toBeLessThanOrEqual(20);
    // Nowhere near all 10 button-only pages get reached before the
    // crawl-wide click-probe budget runs out.
    expect(result.visitedCount).toBeLessThan(pageCount);
  });
});

describe('crawl() deep-probes for modal/multi-step state (GAP-056)', () => {
  it('records a same-URL click that reveals a materially larger DOM as its own state, then reverts', async () => {
    // A thin page (< 5 elements) whose "Manage wallet" button opens a modal with 6 real
    // interactive elements — the exact wallet/subscription-panel shape the plain click-probing
    // pass would otherwise harvest zero links from and immediately Escape-revert.
    const walletButton = button('Manage wallet');
    const thinPage = [walletButton];
    const modalElements = [
      button('Add card'),
      button('Remove card'),
      { role: 'textbox', name: 'Card nickname', selector: '#card-nickname' } as InteractiveElement,
      link('https://a.test/wallet/history'),
      button('Close'),
      button('Something else'),
    ];
    const log: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/dashboard': { elements: thinPage },
        'https://a.test/wallet/history': { elements: [] },
      },
      onClickSelectorReveal: { [walletButton.selector]: modalElements },
      log,
    });

    const result = await crawl(browser, 'https://a.test/dashboard');

    const baseRoute = result.routes.find((r) => r.url === 'https://a.test/dashboard' && !r.stateKey);
    const stateRoute = result.routes.find((r) => r.stateKey);
    expect(baseRoute).toBeDefined();
    expect(stateRoute).toBeDefined();
    expect(stateRoute?.stateKey).toBe(`https://a.test/dashboard>>${walletButton.selector}`);
    expect(stateRoute?.snapshot.interactiveElements).toHaveLength(modalElements.length);
    // The link inside the modal is still harvested for ordinary route discovery.
    expect(result.routes.some((r) => r.url === 'https://a.test/wallet/history')).toBe(true);
    // After recording the state (and probing whatever it reveals), the page must end up back at
    // its original state — same revert guarantee the plain click-probing pass already gives
    // every other candidate, so the next top-level BFS step starts from a known page.
    const clickIdx = log.indexOf(`click:${walletButton.selector}`);
    expect(log.slice(clickIdx)).toContain('goto:https://a.test/dashboard');
  });

  it('deep-probes a route that already has plenty of interactive elements too, when a candidate reveals a real modal', async () => {
    // Real-world shape found via a live audit of the C&A app: a well-populated "My account" page
    // (~15 elements, nowhere near thin) whose "change password" button reveals a same-URL form —
    // gating deep-probing on the ROUTE's own element count would keep missing exactly this case,
    // since the surrounding page being healthy says nothing about whether one specific button
    // opens an ungrounded panel. STATE_REVEAL_MIN_NEW_ELEMENTS is what keeps this targeted instead.
    const healthyPage = [
      button('A'),
      button('B'),
      button('C'),
      link('https://a.test/other'),
      { role: 'textbox', name: 'Search', selector: '#search' } as InteractiveElement,
    ];
    // healthyPage has 5 elements; revealed must add >= STATE_REVEAL_MIN_NEW_ELEMENTS (5) to
    // count as a real modal, not an ordinary dropdown — 10 total clears that.
    const revealed = [
      button('X'),
      button('Y'),
      button('Z'),
      button('W'),
      button('V'),
      button('U'),
      button('T'),
      button('S'),
      button('R'),
      button('Q'),
    ];
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: healthyPage },
        'https://a.test/other': { elements: [] },
      },
      onClickSelectorReveal: { [healthyPage[0]!.selector]: revealed },
      recordClicks,
    });

    const result = await crawl(browser, 'https://a.test/');

    const stateRoute = result.routes.find((r) => r.stateKey);
    expect(stateRoute).toBeDefined();
    expect(stateRoute?.snapshot.interactiveElements).toHaveLength(revealed.length);
  });

  it('recurses into a revealed state up to the depth cap, filling safe inputs but never a password/OTP field', async () => {
    const openWallet = button('Manage wallet');
    const openAddCard = button('Add card');
    // fillSafeInputs only ever runs on a state right before recursing INTO it (there'd be no
    // point filling a form we're not going to progress past), so the fields under test live on
    // level1 — the state depth0's call recurses into. Base page has 1 element; level1 must add
    // >= STATE_REVEAL_MIN_NEW_ELEMENTS (5) to count as a real reveal, not a dropdown.
    const level1 = [
      openAddCard,
      { role: 'textbox', name: 'Card number', selector: '#card-number' } as InteractiveElement,
      { role: 'textbox', name: 'OTP code', selector: '#otp-code' } as InteractiveElement,
      { role: 'textbox', name: 'Password', selector: '#pw', inputType: 'password' } as InteractiveElement,
      { role: 'textbox', name: 'Nickname', selector: '#nick' } as InteractiveElement,
      button('F'),
    ];
    const thirdLevelButton = button('Go deeper');
    // level1 has 6 elements; level2 must add >= 5 more against THAT baseline, so needs >= 11 total.
    const level2 = [
      thirdLevelButton,
      button('Z1'),
      button('Z2'),
      button('Z3'),
      button('Z4'),
      button('Z5'),
      button('Z6'),
      button('Z7'),
      button('Z8'),
      button('Z9'),
      button('Z10'),
    ];
    const level3 = [
      button('past-depth-cap-1'),
      button('past-depth-cap-2'),
      button('past-depth-cap-3'),
      button('past-depth-cap-4'),
      button('past-depth-cap-5'),
    ];
    const recordTypes: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/dashboard': { elements: [openWallet] } },
      onClickSelectorReveal: {
        [openWallet.selector]: level1,
        [openAddCard.selector]: level2,
        [thirdLevelButton.selector]: level3,
      },
      recordTypes,
    });

    const result = await crawl(browser, 'https://a.test/dashboard');

    // hop1 (level1) and hop2 (level2) are recorded (MAX_STATE_DEPTH=2); level3 would be hop3 and
    // must never even be attempted — nothing ever clicks INSIDE a hop2 state's own candidates.
    const stateRoutes = result.routes.filter((r) => r.stateKey);
    expect(stateRoutes.some((r) => r.snapshot.interactiveElements === level1)).toBe(true);
    expect(stateRoutes.some((r) => r.snapshot.interactiveElements === level2)).toBe(true);
    expect(stateRoutes.some((r) => r.snapshot.interactiveElements === level3)).toBe(false);
    // Safety: card number/nickname get filled, password and OTP-shaped fields never do.
    expect(recordTypes).toContain('#card-number');
    expect(recordTypes).toContain('#nick');
    expect(recordTypes).not.toContain('#pw');
    expect(recordTypes).not.toContain('#otp-code');
    // Cluster C: the OTP field on level1 (where fillSafeInputs actually ran and skipped it) is
    // recorded as a gate, not silently discarded.
    const level1Route = stateRoutes.find((r) => r.snapshot.interactiveElements === level1);
    expect(level1Route?.otpGateReached).toBe(true);
  });

  it('never exceeds the crawl-wide state-probe budget of 20', async () => {
    // A thin base page (< 5 elements, so deep-probing engages at all) whose every safe candidate
    // reveals a fresh, materially larger state one hop deep — without a shared budget this could
    // spend far more than MAX_STATE_PROBES_PER_CRAWL clicks chasing all of them.
    const candidates = Array.from({ length: 4 }, (_, i) => button(`Open ${i}`));
    const reveal: Record<string, InteractiveElement[]> = {};
    for (const c of candidates) {
      // 10 elements against a 4-element base clears STATE_REVEAL_MIN_NEW_ELEMENTS (5).
      reveal[c.selector] = Array.from({ length: 10 }, (_, j) => button(`${c.name} inner ${j}`));
    }
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: candidates } },
      onClickSelectorReveal: reveal,
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    // Only 4 top-level candidates exist, so ordinary click-probe/link-discovery budget (60) is
    // nowhere near the limiting factor here — MAX_STATE_PROBES_PER_CRAWL (20) is what actually
    // caps this run, well short of the 4 * (1 + 8) = 36 clicks unbounded recursion would spend.
    expect(recordClicks.length).toBeLessThanOrEqual(20);
  });
});

describe('otpGateReached / destructiveActionsSeen (Cluster C)', () => {
  it('flags the OTP gate even when the OTP field is on the DEEPEST discovered hop, where fillSafeInputs never runs to look further', async () => {
    // fillSafeInputs only ever runs on a state to advance ONE hop deeper — at MAX_STATE_DEPTH's
    // final hop it never runs against that hop's own snapshot, so an OTP field living there is
    // never inspected by fillSafeInputs at all. otpGateReached must still catch it independently.
    const openWallet = button('Manage wallet');
    const level1 = [
      button('F'),
      button('G'),
      button('H'),
      button('I'),
      button('J'),
      { role: 'textbox', name: 'Card number', selector: '#card-number' } as InteractiveElement,
    ];
    // level1 has 6 elements; the nested discoverClickRoutes call measures level2 against THAT
    // baseline (6), so level2 needs >= 11 elements total to clear STATE_REVEAL_MIN_NEW_ELEMENTS (5).
    const level2 = [
      button('Z1'),
      button('Z2'),
      button('Z3'),
      button('Z4'),
      button('Z5'),
      button('Z6'),
      button('Z7'),
      button('Z8'),
      button('Z9'),
      button('Z10'),
      { role: 'textbox', name: 'Enter verification code', selector: '#otp' } as InteractiveElement,
    ];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/reset': { elements: [openWallet] } },
      onClickSelectorReveal: { [openWallet.selector]: level1, [level1[0]!.selector]: level2 },
    });

    const result = await crawl(browser, 'https://a.test/reset');

    const stateRoutes = result.routes.filter((r) => r.stateKey);
    const level1Route = stateRoutes.find((r) => r.snapshot.interactiveElements === level1);
    const level2Route = stateRoutes.find((r) => r.snapshot.interactiveElements === level2);
    expect(level1Route?.otpGateReached).toBeFalsy();
    expect(level2Route?.otpGateReached).toBe(true);
  });

  it('flags otpGateReached on a plain top-level route (not just a deep-probed state)', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/verify': {
          elements: [{ role: 'textbox', name: 'One-time code', selector: '#code' } as InteractiveElement],
        },
      },
    });
    const result = await crawl(browser, 'https://a.test/verify');
    expect(result.routes[0]?.otpGateReached).toBe(true);
  });

  it('leaves otpGateReached falsy when no OTP-shaped field exists anywhere on the route', async () => {
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: [button('Save')] } },
    });
    const result = await crawl(browser, 'https://a.test/');
    expect(result.routes[0]?.otpGateReached).toBeFalsy();
  });

  it('records destructiveActionsSeen for a visible "Delete account"/"Pay now" control', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/account': { elements: [button('Delete account'), button('Pay now')] },
      },
    });
    const result = await crawl(browser, 'https://a.test/account');
    expect(result.routes[0]?.destructiveActionsSeen).toEqual(
      expect.arrayContaining(['Delete account', 'Pay now']),
    );
  });

  it('does NOT flag reversible/safe actions ("Save", "Submit", "Logout") as destructive (narrow-scope boundary)', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/settings': { elements: [button('Save'), button('Submit'), button('Logout')] },
      },
    });
    const result = await crawl(browser, 'https://a.test/settings');
    expect(result.routes[0]?.destructiveActionsSeen ?? []).toHaveLength(0);
  });
});

describe('modalText / bodyText pass-through (Cluster E)', () => {
  it('carries a captured modalText/bodyText from the browser snapshot onto the recorded route, untouched', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/account': {
          elements: [button('Delete account')],
          modalText: 'Delete your account? This cannot be undone.',
          bodyText: 'Delete your account? This cannot be undone. Footer: contact us.',
        },
      },
    });
    const result = await crawl(browser, 'https://a.test/account');
    expect(result.routes[0]?.snapshot.modalText).toBe('Delete your account? This cannot be undone.');
    expect(result.routes[0]?.snapshot.bodyText).toBe(
      'Delete your account? This cannot be undone. Footer: contact us.',
    );
  });

  it('leaves modalText/bodyText undefined when the browser snapshot never captured either', async () => {
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: [] } },
    });
    const result = await crawl(browser, 'https://a.test/');
    expect(result.routes[0]?.snapshot.modalText).toBeUndefined();
    expect(result.routes[0]?.snapshot.bodyText).toBeUndefined();
  });
});

const EMAIL_FIELD: InteractiveElement = {
  role: 'textbox',
  name: 'Email',
  selector: '#email',
  inputType: 'email',
};
const PASSWORD_FIELD: InteractiveElement = {
  role: 'textbox',
  name: 'Password',
  selector: '#password',
  inputType: 'password',
};
// Realistic markup: a login form's submit button lives inside a <form>, so
// click-probing (which never touches in-form controls) must never fire it
// prematurely during the plain anonymous crawl() that precedes attemptLogin().
const SUBMIT_BUTTON: InteractiveElement = {
  role: 'button',
  name: 'Sign in',
  selector: '#submit',
  inForm: true,
  buttonType: 'submit',
};

describe('crawlWithAuth()', () => {
  it('returns anonymous-only routes and skips auth when no credentials are supplied', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/login')] },
        'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON] },
      },
    });

    const result = await crawlWithAuth(browser, 'https://a.test/');

    expect(result.authAttempted).toBe(false);
    expect(result.authVerified).toBe(false);
    expect(result.routes.every((r) => r.role === 'anonymous')).toBe(true);
  });

  it('degrades to anonymous-only (with a reason) when no password-bearing route is found', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [] },
      },
    });

    const result = await crawlWithAuth(browser, 'https://a.test/', {
      credentials: { username: 'user@a.test', password: 'pw' },
    });

    expect(result.authAttempted).toBe(false);
    expect(result.authReason).toMatch(/no password-bearing route/i);
  });

  it('attempts login on the discovered candidate and crawls authenticated routes on success', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/login')] },
        'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON] },
        'https://a.test/dashboard': {
          elements: [
            link('https://a.test/dashboard/settings'),
            { role: 'heading', name: 'Dashboard', selector: 'h1' },
          ],
        },
        'https://a.test/dashboard/settings': {
          elements: [{ role: 'heading', name: 'Settings', selector: 'h1' }],
        },
      },
      onClickGoTo: { 'https://a.test/login': 'https://a.test/dashboard' },
    });

    const result = await crawlWithAuth(browser, 'https://a.test/', {
      credentials: { username: 'user@a.test', password: 'correct-pw' },
    });

    expect(result.authAttempted).toBe(true);
    expect(result.authVerified).toBe(true);

    const anonymousUrls = result.routes.filter((r) => r.role === 'anonymous').map((r) => r.url);
    expect(anonymousUrls.sort()).toEqual(['https://a.test/', 'https://a.test/login']);

    const authUrls = result.routes.filter((r) => r.role === 'authenticated').map((r) => r.url);
    expect(authUrls.sort()).toEqual(['https://a.test/dashboard', 'https://a.test/dashboard/settings']);
  });

  it('prefers a /login-hinted route over a /register-hinted route when both have a password field', async () => {
    // Both routes carry a password field (a common shape: registration also
    // collects a password), but only /login is the actual login page. Wiring
    // /register's form with the login credentials would fail (missing
    // required registration fields) even though a password field was found.
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': {
          elements: [link('https://a.test/register'), link('https://a.test/login')],
        },
        'https://a.test/register': { elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON] },
        'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON] },
        'https://a.test/dashboard': { elements: [{ role: 'heading', name: 'Dashboard', selector: 'h1' }] },
      },
      onClickGoTo: { 'https://a.test/login': 'https://a.test/dashboard' },
    });

    const result = await crawlWithAuth(browser, 'https://a.test/', {
      credentials: { username: 'user@a.test', password: 'correct-pw' },
    });

    expect(result.authAttempted).toBe(true);
    expect(result.authVerified).toBe(true);
    const authUrls = result.routes.filter((r) => r.role === 'authenticated').map((r) => r.url);
    expect(authUrls).toEqual(['https://a.test/dashboard']);
  });

  it('verifies login via a discovered same-URL login toggle when no dedicated login route exists (regression: register-only app)', async () => {
    // Reproduces the reported bug end-to-end: the only password-bearing
    // route is /register (no /login route at all), reachable via an in-form
    // "Log in instead" toggle that flips view state without changing the
    // URL. Before this fix, pickLoginCandidate would fall back to /register
    // itself and attemptLogin's fresh goto() would always reload the
    // default register view, submitting login creds into the registration
    // form and reporting a false "login likely failed".
    //
    // The login view's fields use DISTINCT selectors from the register
    // view's — this is what makes the test fail against the pre-fix code:
    // a plain attemptLogin() (fresh goto, no toggle replay) would fill and
    // submit the register view's fields, which have no route to /dashboard
    // wired up, so it would stay on a page with a password field and be
    // reported as a failed login — exactly the reported bug.
    const inFormToggle: InteractiveElement = {
      role: 'button',
      name: 'Log in instead',
      selector: '#toggle-login-btn',
      inForm: true,
    };
    const registerElements = [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON, inFormToggle];
    const loginEmailField: InteractiveElement = { ...EMAIL_FIELD, selector: '#login-email' };
    const loginPasswordField: InteractiveElement = { ...PASSWORD_FIELD, selector: '#login-password' };
    const loginSubmitButton: InteractiveElement = { ...SUBMIT_BUTTON, selector: '#login-submit' };
    const loginElements = [loginEmailField, loginPasswordField, loginSubmitButton];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/register': { elements: registerElements },
        'https://a.test/dashboard': { elements: [{ role: 'heading', name: 'Dashboard', selector: 'h1' }] },
      },
      onClickSelectorReveal: { '#toggle-login-btn': loginElements },
      // Only the toggled-in login view's submit button leads anywhere —
      // submitting the register form's own submit button goes nowhere.
      onClickSelectorGoTo: { '#login-submit': 'https://a.test/dashboard' },
    });

    const result = await crawlWithAuth(browser, 'https://a.test/register', {
      credentials: { username: 'user@a.test', password: 'correct-pw' },
    });

    expect(result.authAttempted).toBe(true);
    expect(result.authVerified).toBe(true);
    expect(result.authReason).toBeUndefined();
    const authUrls = result.routes.filter((r) => r.role === 'authenticated').map((r) => r.url);
    expect(authUrls).toEqual(['https://a.test/dashboard']);
  });

  // Runs ~10s on purpose: a submit that never leaves the login page is only CONFIRMED failed
  // once login.ts's LOGIN_SETTLE_TIMEOUT_MS has elapsed, since a real login legitimately chains
  // several requests before redirecting. Fits this package's 15s testTimeout (vitest.config.ts)
  // without needing its own.
  it('degrades to anonymous-only when login cannot be verified (wrong credentials)', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/login')] },
        'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON] },
      },
      // No onClickGoTo entry: submitting leaves the session on /login.
    });

    const result = await crawlWithAuth(browser, 'https://a.test/', {
      credentials: { username: 'user@a.test', password: 'wrong-pw' },
    });

    expect(result.authAttempted).toBe(true);
    expect(result.authVerified).toBe(false);
    expect(result.authReason).toMatch(/password field/i);
    expect(result.routes.every((r) => r.role === 'anonymous')).toBe(true);
  });
});

describe('reconcileStaticRoutePaths()', () => {
  it('joins plain paths unchanged for a non-hash-routed app', () => {
    const out = reconcileStaticRoutePaths(['/checkout', '/about'], { hashRouted: false }, 'https://a.test/');
    expect(out).toEqual(['https://a.test/checkout', 'https://a.test/about']);
  });

  it('joins paths behind the detected hash/region prefix for a hash-routed app', () => {
    const out = reconcileStaticRoutePaths(
      ['/checkout'],
      { hashRouted: true, invariantPrefix: '#/SK' },
      'https://a.test/',
    );
    expect(out).toEqual(['https://a.test/#/SK/checkout']);
  });

  it('falls back to a bare "#" prefix when hash-routed but no invariant prefix was detected', () => {
    const out = reconcileStaticRoutePaths(['/checkout'], { hashRouted: true }, 'https://a.test/');
    expect(out).toEqual(['https://a.test/#/checkout']);
  });

  it('inserts the separating slash a naive string concat would drop when the static path has no leading slash', () => {
    const out = reconcileStaticRoutePaths(
      ['home'],
      { hashRouted: true, invariantPrefix: '#/SK' },
      'https://a.test/',
    );
    expect(out).toEqual(['https://a.test/#/SK/home']);
    expect(out).not.toEqual(['https://a.test/#/SKhome']);
  });

  it('drops paths with a dynamic segment (:id, [id], or *) instead of guessing a value', () => {
    const out = reconcileStaticRoutePaths(
      ['/users/:id', '/posts/[slug]', '/files/*', '/checkout'],
      { hashRouted: false },
      'https://a.test/',
    );
    expect(out).toEqual(['https://a.test/checkout']);
  });

  it('skips a path that fails to resolve against a malformed base URL rather than throwing', () => {
    expect(() => reconcileStaticRoutePaths(['/checkout'], { hashRouted: false }, 'not-a-url')).not.toThrow();
    expect(reconcileStaticRoutePaths(['/checkout'], { hashRouted: false }, 'not-a-url')).toEqual([]);
  });
});

describe('crawl() subpath-hosted entry navigation (GAP-052)', () => {
  it('navigates to the entry URL exactly as given, trailing slash intact', async () => {
    const log: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/app/': { elements: [] } },
      log,
    });

    await crawl(browser, 'https://a.test/app/');

    // normalizeUrl() would strip this to "https://a.test/app" — a subpath-hosted
    // dev server (e.g. Vite's `base` config) can 404/diagnostic-page on that
    // stripped form even though the trailing-slash form is the real app.
    expect(log).toContain('goto:https://a.test/app/');
  });

  it('navigates to a discovered link exactly as resolved, trailing slash intact', async () => {
    const log: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/app/': { elements: [link('https://a.test/app/about/')] },
        'https://a.test/app/about/': { elements: [] },
      },
      log,
    });

    const result = await crawl(browser, 'https://a.test/app/');

    // The navigated URL keeps the trailing slash (this is the actual fix)...
    expect(log).toContain('goto:https://a.test/app/about/');
    // ...while the RECORDED route url is still normalizeUrl()'s canonical
    // (stripped) form — that's an intentional, separate concern (dedup/
    // reporting key), untouched by this fix.
    expect(result.routes.map((r) => r.url).sort()).toEqual([
      'https://a.test/app',
      'https://a.test/app/about',
    ]);
  });

  it('still dedupes a trailing-slash and non-trailing-slash variant of the same link as one route', async () => {
    // normalizeUrl() remains the DEDUP key even though it's no longer the
    // navigated URL — two links differing only by trailing slash must still
    // collapse to a single visited route, not be crawled twice.
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': {
          elements: [link('https://a.test/about'), link('https://a.test/about/')],
        },
        'https://a.test/about': { elements: [] },
      },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.visitedCount).toBe(2);
  });
});

describe('crawl() href="#" phantom routes (GAP-054)', () => {
  it('does not queue a bare href="#" as a new route', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': {
          elements: [
            { role: 'link', name: 'brand', selector: 'a.brand', href: '#' },
            link('https://a.test/about'),
          ],
        },
        'https://a.test/about': { elements: [] },
      },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.visitedCount).toBe(2);
    expect(result.routes.map((r) => r.url).sort()).toEqual(['https://a.test/', 'https://a.test/about']);
  });

  it('still follows a real hash-route href (content after the "#")', async () => {
    // Raw attribute is "#/login" (not a bare "#") — must resolve and be
    // followed like any other same-origin link, unlike the phantom-route case above.
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('#/login')] },
        'https://a.test/#/login': { elements: [] },
      },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.visitedCount).toBe(2);
  });
});

describe('crawl() non-semantic clickable elements are click-probe eligible (GAP-053)', () => {
  it('click-probes a role: generic candidate (a cursor-pointer div/span with an onClick handler)', async () => {
    const genericTrigger: InteractiveElement = {
      role: 'generic',
      name: 'Change birthday',
      selector: 'div.change-birthday',
    };
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [genericTrigger] },
        'https://a.test/modal': { elements: [] },
      },
      onClickGoTo: { 'https://a.test/': 'https://a.test/modal' },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks).toContain(genericTrigger.selector);
  });

  it('still excludes a role: generic candidate whose name reads as a destructive/mutating action', async () => {
    const deleteTrigger: InteractiveElement = {
      role: 'generic',
      name: 'Delete account',
      selector: 'div.delete-account',
    };
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: [deleteTrigger] } },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks).not.toContain(deleteTrigger.selector);
  });
});

describe('crawl() drops over-long generic candidate names to avoid crowding real targets out of the probe slice (GAP-057)', () => {
  it('excludes a role: generic candidate whose name exceeds the length cap', async () => {
    // A pointer-styled CONTAINER (widened discovery from GAP-057's '*' scan) whose textContent
    // swept up a whole panel's text, not a real click target.
    const container: InteractiveElement = {
      role: 'generic',
      name: 'x'.repeat(61),
      selector: 'div.panel',
    };
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: [container] } },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks).not.toContain(container.selector);
  });

  it('keeps a role: generic candidate whose name is exactly at the length cap (boundary)', async () => {
    const atLimit: InteractiveElement = {
      role: 'generic',
      name: 'x'.repeat(60),
      selector: 'div.at-limit',
    };
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [atLimit] },
        'https://a.test/modal': { elements: [] },
      },
      onClickGoTo: { 'https://a.test/': 'https://a.test/modal' },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks).toContain(atLimit.selector);
  });

  it('never applies the length cap to a semantic button candidate, however long its name', async () => {
    const longButton: InteractiveElement = {
      role: 'button',
      name: 'y'.repeat(300),
      selector: 'button.long-name',
    };
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [longButton] },
        'https://a.test/modal': { elements: [] },
      },
      onClickGoTo: { 'https://a.test/': 'https://a.test/modal' },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks).toContain(longButton.selector);
  });
});

describe('crawl() per-route crash signal', () => {
  it('flags a route whose accessible tree reads as an unhandled app-side crash', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/admin': {
          elements: [],
          axTree: '- heading "Unexpected Application Error!"\n- text "users.filter is not a function"',
        },
      },
    });

    const result = await crawl(browser, 'https://a.test/admin');

    expect(result.routes[0]?.crashed).toBe(true);
  });

  it('does not flag an ordinary sparse route as crashed', async () => {
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/blank': { elements: [], axTree: '- text "Nothing here yet"' } },
    });

    const result = await crawl(browser, 'https://a.test/blank');

    expect(result.routes[0]?.crashed).toBe(false);
  });
});

describe('crawl() network capture (GAP-046)', () => {
  it('attaches the network events captured while a route settled to that route', async () => {
    const homeEvents: CapturedNetworkEvent[] = [
      { method: 'GET', url: 'https://a.test/api/profile', status: 200, responseBody: '{"name":"Ada"}' },
    ];
    const aboutEvents: CapturedNetworkEvent[] = [
      { method: 'GET', url: 'https://a.test/api/about', status: 200, responseBody: '{"version":1}' },
    ];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/about')], network: homeEvents },
        'https://a.test/about': { elements: [], network: aboutEvents },
      },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.routes).toHaveLength(2);
    const home = result.routes.find((r) => r.url === 'https://a.test/');
    const about = result.routes.find((r) => r.url === 'https://a.test/about');
    expect(home?.networkEvents).toEqual(homeEvents);
    expect(about?.networkEvents).toEqual(aboutEvents);
  });

  it('gives a route an empty networkEvents array when nothing was captured for it', async () => {
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: [] } },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.routes[0]?.networkEvents).toEqual([]);
  });

  it('discards traffic from a failed navigation instead of attributing it to the next successful route', async () => {
    const deadEvents: CapturedNetworkEvent[] = [
      { method: 'GET', url: 'https://a.test/api/dead', status: 500 },
    ];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/dead': { elements: [], network: deadEvents },
        'https://a.test/ok': { elements: [] },
      },
      throwFor: new Set(['https://a.test/dead']),
    });

    const result = await crawl(browser, 'https://a.test/dead', { seedRoutes: ['https://a.test/ok'] });

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.url).toBe('https://a.test/ok');
    expect(result.routes[0]?.networkEvents).toEqual([]);
  });
});

describe('scoreLoginCandidates()', () => {
  const NO_HASH: RoutePrefixInfo = { hashRouted: false };

  function route(url: string, opts: { title?: string; hasPasswordField?: boolean } = {}) {
    return {
      url,
      title: opts.title ?? '',
      snapshot: { url, title: opts.title ?? '', interactiveElements: [] },
      depth: 0,
      hasPasswordField: opts.hasPasswordField ?? false,
      role: 'anonymous' as const,
      networkEvents: [],
    };
  }

  it('ranks a real login route above a password-bearing register route', () => {
    const candidates = scoreLoginCandidates(
      [
        route('https://a.test/#/SK/register', { title: 'Registrácia', hasPasswordField: true }),
        route('https://a.test/#/SK/login', { title: 'Prihlásiť sa', hasPasswordField: true }),
      ],
      { hashRouted: true, invariantPrefix: '#/SK' },
      'https://a.test/',
    );

    expect(candidates[0]?.url).toBe('https://a.test/#/SK/login');
    expect(candidates[0]?.score).toBeGreaterThan(candidates[1]?.score ?? 0);
  });

  it('a register page is not confident on its password field alone, so the /login fallback still fires', () => {
    const candidates = scoreLoginCandidates(
      [route('https://a.test/#/SK/register', { title: 'Registrácia', hasPasswordField: true })],
      { hashRouted: true, invariantPrefix: '#/SK' },
      'https://a.test/',
    );

    // The whole bug: +3 for the password field used to equal CONFIDENT_SCORE, so the register
    // page was reported as a CONFIDENT login candidate and the fallback was suppressed entirely,
    // leaving the run with no alternative to a page that isn't a login form.
    expect(candidates.some((c) => c.source === 'common-path')).toBe(true);
    expect(candidates.find((c) => c.url.endsWith('/register'))?.score).toBeLessThan(3);
  });

  it('ranks a crawled register page ABOVE a merely guessed /login', () => {
    const candidates = scoreLoginCandidates(
      [route('https://a.test/#/SK/register', { title: 'Registrácia', hasPasswordField: true })],
      { hashRouted: true, invariantPrefix: '#/SK' },
      'https://a.test/',
    );

    // Deliberate: on an app whose login is only a toggle inside the register form, there is no
    // /login route at all, so preferring the guess would send the auth fixture to a URL that
    // renders the SPA's fallback and lose a login that otherwise works. We positively observed
    // the register page and its password field; /login is only a guess.
    expect(candidates[0]?.url).toBe('https://a.test/#/SK/register');
    const guess = candidates.find((c) => c.source === 'common-path');
    expect(candidates[0]?.score).toBeGreaterThan(guess?.score ?? 0);
  });

  it('keeps a login-hinted route confident so no fallback candidates are added', () => {
    const candidates = scoreLoginCandidates(
      [route('https://a.test/login', { hasPasswordField: true })],
      NO_HASH,
      'https://a.test/',
    );

    expect(candidates.every((c) => c.source === 'crawled')).toBe(true);
  });

  it('collapses a route and its deep-probe states into one candidate, keeping the highest score', () => {
    const base = route('https://a.test/login');
    const probed = { ...route('https://a.test/login', { hasPasswordField: true }), stateKey: 'x>>y' };

    const candidates = scoreLoginCandidates([base, probed], NO_HASH, 'https://a.test/');

    const forLogin = candidates.filter((c) => c.url === 'https://a.test/login');
    expect(forLogin).toHaveLength(1);
    // 3 (password field, contributed only by the probed state) + 2 (URL hint).
    expect(forLogin[0]?.score).toBe(5);
  });

  it('still treats a route reading as both register and login as a login candidate', () => {
    const candidates = scoreLoginCandidates(
      [route('https://a.test/register-or-login', { hasPasswordField: true })],
      NO_HASH,
      'https://a.test/',
    );

    // No signup penalty applied, so the password field alone keeps it confident.
    expect(candidates[0]?.url).toBe('https://a.test/register-or-login');
    expect(candidates.every((c) => c.source === 'crawled')).toBe(true);
  });
});

describe('crawl() login-route discovery priority', () => {
  it('visits a login-looking route before other routes queued ahead of it', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': {
          // Register is discovered FIRST, so plain FIFO order would visit it first.
          elements: [link('https://a.test/register'), link('https://a.test/login')],
        },
        'https://a.test/register': { elements: [] },
        'https://a.test/login': { elements: [] },
      },
    });

    const result = await crawl(browser, 'https://a.test/', { maxRoutes: 2 });

    // maxRoutes: 2 means exactly one of the two gets visited — it must be login.
    expect(result.routes.map((r) => r.url)).toEqual(['https://a.test/', 'https://a.test/login']);
  });

  it('reports discovered-but-unvisited routes so a truncated crawl is not silent', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/a'), link('https://a.test/b')] },
        'https://a.test/a': { elements: [] },
        'https://a.test/b': { elements: [] },
      },
    });

    const result = await crawl(browser, 'https://a.test/', { maxRoutes: 1 });

    expect(result.budgetExhausted).toBe(true);
    expect(result.unvisitedQueuedCount).toBe(2);
  });

  it('reports zero unvisited routes when the queue drained normally', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': { elements: [link('https://a.test/a')] },
        'https://a.test/a': { elements: [] },
      },
    });

    const result = await crawl(browser, 'https://a.test/');

    expect(result.budgetExhausted).toBe(false);
    expect(result.unvisitedQueuedCount).toBe(0);
  });
});
