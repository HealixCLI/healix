import { describe, expect, it } from 'vitest';
import { crawl, crawlWithAuth, reconcileStaticRoutePaths } from './crawler.js';
import type {
  BrowserSurface,
  BrowserSurfaceOptions,
  DomSnapshot,
  InteractiveElement,
  Point,
} from './types.js';

interface FakePage {
  title?: string;
  elements: InteractiveElement[];
}

/**
 * A fake BrowserSurface driven purely by a URL->page map, keyed by the final
 * (post-redirect) URL. `redirects` maps a requested URL to the URL goto()
 * actually lands on, mirroring how a real page's `page.url()` can differ from
 * what was requested. `onClickGoTo` maps a source URL to a destination URL,
 * simulating a login form's submit button navigating on success.
 * `onClickSelectorGoTo` maps a specific clicked selector to a destination URL
 * (regardless of the current URL) — used to give two candidates on the same
 * page distinct destinations for click-probing tests. `log`, when provided,
 * records every `goto`/`click` call (as `goto:<url>` / `click:<selector>`) in
 * order, so tests can assert reset-after-click sequencing.
 */
function makeFakeBrowser(config: {
  pages: Record<string, FakePage>;
  redirects?: Record<string, string>;
  throwFor?: Set<string>;
  delayMs?: number;
  onClickGoTo?: Record<string, string>;
  onClickSelectorGoTo?: Record<string, string>;
  recordClicks?: string[];
  log?: string[];
}): BrowserSurface {
  let currentUrl = '';
  return {
    async start(_opts?: BrowserSurfaceOptions): Promise<void> {},
    async goto(url: string): Promise<void> {
      config.log?.push(`goto:${url}`);
      if (config.throwFor?.has(url)) {
        throw new Error(`fake nav failure for ${url}`);
      }
      if (config.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, config.delayMs));
      }
      currentUrl = config.redirects?.[url] ?? url;
    },
    async screenshot(): Promise<Buffer> {
      return Buffer.alloc(0);
    },
    async snapshot(): Promise<DomSnapshot> {
      const page = config.pages[currentUrl];
      if (!page) {
        throw new Error(`no fake page configured for ${currentUrl}`);
      }
      return { url: currentUrl, title: page.title ?? currentUrl, interactiveElements: page.elements };
    },
    async click(selector: string): Promise<void> {
      config.recordClicks?.push(selector);
      config.log?.push(`click:${selector}`);
      const bySelector = config.onClickSelectorGoTo?.[selector];
      if (bySelector) {
        currentUrl = bySelector;
        return;
      }
      const next = config.onClickGoTo?.[currentUrl];
      if (next) currentUrl = next;
    },
    async clickAt(_point: Point): Promise<void> {},
    async type(_selector: string, _text: string): Promise<void> {},
    async pressKey(_key: string): Promise<void> {},
    onFrame(_cb: (png: Buffer) => void): () => void {
      return () => {};
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
    const unsafeButton = button('Register now');
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

  it('never click-probes a control inside a <form>, even with a safe-sounding name', async () => {
    const inFormButton: InteractiveElement = {
      role: 'button',
      name: 'Continue',
      selector: '#continue-btn',
      inForm: true,
    };
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: [inFormButton] } },
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

  it('does not click-probe a page while the link-following queue still has 3+ pending URLs', async () => {
    const extraNav = button('Extra Nav');
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/': {
          elements: [
            link('https://a.test/p1'),
            link('https://a.test/p2'),
            link('https://a.test/p3'),
            extraNav,
          ],
        },
        'https://a.test/p1': { elements: [] },
        'https://a.test/p2': { elements: [] },
        'https://a.test/p3': { elements: [] },
      },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks).toEqual([]);
  });

  it('caps click-probes at 4 candidates on a single page even with more safe candidates available', async () => {
    const buttons = Array.from({ length: 6 }, (_, i) => button(`Nav ${i}`));
    const recordClicks: string[] = [];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/': { elements: buttons } },
      recordClicks,
    });

    await crawl(browser, 'https://a.test/');

    expect(recordClicks.length).toBeLessThanOrEqual(4);
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
