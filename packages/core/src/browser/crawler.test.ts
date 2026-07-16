import { describe, expect, it } from 'vitest';
import { crawl, crawlWithAuth } from './crawler.js';
import type { BrowserSurface, BrowserSurfaceOptions, DomSnapshot, InteractiveElement, Point } from './types.js';

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
 */
function makeFakeBrowser(config: {
  pages: Record<string, FakePage>;
  redirects?: Record<string, string>;
  throwFor?: Set<string>;
  delayMs?: number;
  onClickGoTo?: Record<string, string>;
}): BrowserSurface {
  let currentUrl = '';
  return {
    async start(_opts?: BrowserSurfaceOptions): Promise<void> {},
    async goto(url: string): Promise<void> {
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
    async click(_selector: string): Promise<void> {
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

const EMAIL_FIELD: InteractiveElement = { role: 'textbox', name: 'Email', selector: '#email', inputType: 'email' };
const PASSWORD_FIELD: InteractiveElement = {
  role: 'textbox',
  name: 'Password',
  selector: '#password',
  inputType: 'password',
};
const SUBMIT_BUTTON: InteractiveElement = { role: 'button', name: 'Sign in', selector: '#submit' };

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
          elements: [link('https://a.test/dashboard/settings'), { role: 'heading', name: 'Dashboard', selector: 'h1' }],
        },
        'https://a.test/dashboard/settings': { elements: [{ role: 'heading', name: 'Settings', selector: 'h1' }] },
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
