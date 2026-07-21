import { describe, expect, it, vi } from 'vitest';
import { attemptLogin, attemptLoginViaToggle } from './login.js';
import type {
  BrowserSurface,
  BrowserSurfaceOptions,
  DomSnapshot,
  InteractiveElement,
  Point,
} from './types.js';

interface FakePage {
  elements: InteractiveElement[];
}

/** A fake BrowserSurface that can transition to a different page on submit-click. */
function makeFakeBrowser(config: {
  pages: Record<string, FakePage>;
  /** Maps a submit-button click's source URL to the URL it lands on. */
  onSubmitGoTo?: Record<string, string>;
  /** Maps a specific clicked selector to a destination page key, regardless of
   * currentUrl — used to model a login-toggle click swapping in a different
   * (same-URL, in real terms) view without going through onSubmitGoTo's
   * per-URL lookup. */
  onClickSelectorGoTo?: Record<string, string>;
  throwOnClick?: boolean;
  /** Selectors whose click() call throws, instead of every click (throwOnClick). */
  throwOnSelector?: Set<string>;
}): BrowserSurface {
  let currentUrl = '';
  return {
    async start(_opts?: BrowserSurfaceOptions): Promise<void> {},
    async goto(url: string): Promise<void> {
      currentUrl = url;
    },
    async screenshot(): Promise<Buffer> {
      return Buffer.alloc(0);
    },
    async snapshot(): Promise<DomSnapshot> {
      const page = config.pages[currentUrl];
      if (!page) throw new Error(`no fake page configured for ${currentUrl}`);
      return { url: currentUrl, title: currentUrl, interactiveElements: page.elements };
    },
    async click(selector: string): Promise<void> {
      if (config.throwOnClick || config.throwOnSelector?.has(selector)) {
        throw new Error('click failed');
      }
      const bySelector = config.onClickSelectorGoTo?.[selector];
      if (bySelector) {
        currentUrl = bySelector;
        return;
      }
      const next = config.onSubmitGoTo?.[currentUrl];
      if (next) currentUrl = next;
    },
    async clickAt(_point: Point): Promise<void> {},
    async type(_selector: string, _text: string): Promise<void> {},
    async pressKey(_key: string): Promise<void> {},
    onFrame(_cb: (png: Buffer) => void): () => void {
      return () => {};
    },
    drainNetworkEvents() {
      return [];
    },
    async stop(): Promise<void> {},
  };
}

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
const SUBMIT_BUTTON: InteractiveElement = { role: 'button', name: 'Sign in', selector: '#submit' };

describe('attemptLogin()', () => {
  it('succeeds and reports the landing URL when the session leaves the login page', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON] },
        'https://a.test/dashboard': { elements: [{ role: 'heading', name: 'Dashboard', selector: 'h1' }] },
      },
      onSubmitGoTo: { 'https://a.test/login': 'https://a.test/dashboard' },
    });

    const result = await attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'correct-pw');

    expect(result.ok).toBe(true);
    expect(result.landingUrl).toBe('https://a.test/dashboard');
  });

  it('fails when the login page re-renders with the password field still present (wrong credentials)', async () => {
    // A genuine failure never resolves on its own — attemptLogin polls up to
    // LOGIN_SETTLE_TIMEOUT_MS (10s) waiting for a redirect that never comes,
    // so this exercises that full wait via fake timers rather than a real
    // 10-second sleep.
    vi.useFakeTimers();
    try {
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON] },
        },
        // No onSubmitGoTo entry: click() is a no-op, session stays on /login.
      });

      const resultPromise = attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'wrong-pw');
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/still on a page with a password field/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast when the candidate page has no password field at all', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/not-a-login-page': { elements: [{ role: 'heading', name: 'Home', selector: 'h1' }] },
      },
    });

    const result = await attemptLogin(browser, 'https://a.test/not-a-login-page', 'user@a.test', 'pw');

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no password field/i);
  });

  it('fails when there is a password field but no separate username/email field', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/login': { elements: [PASSWORD_FIELD, SUBMIT_BUTTON] },
      },
    });

    const result = await attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'pw');

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no username\/email field/i);
  });

  it('treats a URL change away from the login page as success even without re-checking the password field', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON] },
        'https://a.test/home': { elements: [PASSWORD_FIELD] }, // pathological but URL changed
      },
      onSubmitGoTo: { 'https://a.test/login': 'https://a.test/home' },
    });

    const result = await attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'pw');

    expect(result.ok).toBe(true);
    expect(result.landingUrl).toBe('https://a.test/home');
  });

  it('does not throw when the form interaction itself fails; reports a reason instead', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON] },
      },
      throwOnClick: true,
    });

    const result = await attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'pw');

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/login form interaction failed/i);
  });

  describe('findLoginSubmitButton() tiers (via attemptLogin, selector recorded per click)', () => {
    it('picks the in-form submit-type button over a same-page name-matching decoy (tier 1 wins)', async () => {
      // The exact C&A shape: the real submit button's visible name is
      // localized ("Pokračovať") and matches nothing, but it IS a
      // type="submit" button inside the form. A decoy button elsewhere on
      // the page happens to have an English name-matching label ("Continue
      // reading") — tier 1 must win so the decoy is never clicked.
      const realSubmit: InteractiveElement = {
        role: 'button',
        name: 'Pokračovať',
        selector: '#real-submit',
        inForm: true,
        buttonType: 'submit',
      };
      const decoy: InteractiveElement = {
        role: 'button',
        name: 'Continue reading',
        selector: '#decoy',
      };
      const clicked: string[] = [];
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, decoy, realSubmit] },
          'https://a.test/dashboard': { elements: [] },
        },
        onSubmitGoTo: { 'https://a.test/login': 'https://a.test/dashboard' },
      });
      const originalClick = browser.click.bind(browser);
      browser.click = async (selector: string) => {
        clicked.push(selector);
        return originalClick(selector);
      };

      const result = await attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'pw');

      expect(result.ok).toBe(true);
      expect(clicked).toEqual(['#real-submit']);
    });

    it('falls back to selector/testid keyword matching when there is no <form> wrapper', async () => {
      // Non-semantic SPA markup: no inForm/buttonType signal at all, but the
      // developer-facing selector (built from data-testid) reads as a submit
      // action even though the visible name is localized.
      const testIdSubmit: InteractiveElement = {
        role: 'button',
        name: 'Pokračovať',
        selector: 'button[data-testid="login-submit"]',
      };
      const clicked: string[] = [];
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, testIdSubmit] },
          'https://a.test/dashboard': { elements: [] },
        },
        onSubmitGoTo: { 'https://a.test/login': 'https://a.test/dashboard' },
      });
      const originalClick = browser.click.bind(browser);
      browser.click = async (selector: string) => {
        clicked.push(selector);
        return originalClick(selector);
      };

      const result = await attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'pw');

      expect(result.ok).toBe(true);
      expect(clicked).toEqual(['button[data-testid="login-submit"]']);
    });

    it('falls back to the visible-name regex only when neither structural signal is present (backward compat)', async () => {
      // Selector deliberately doesn't match SELECTOR_SUBMIT_HINT_RE (no
      // "submit"/"login"/etc. substring) and there's no inForm/buttonType —
      // only the visible name ("Sign in") can identify this as the button.
      const nameOnlyButton: InteractiveElement = {
        role: 'button',
        name: 'Sign in',
        selector: '#action-button',
      };
      const clicked: string[] = [];
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, nameOnlyButton] },
          'https://a.test/dashboard': { elements: [] },
        },
        onSubmitGoTo: { 'https://a.test/login': 'https://a.test/dashboard' },
      });
      const originalClick = browser.click.bind(browser);
      browser.click = async (selector: string) => {
        clicked.push(selector);
        return originalClick(selector);
      };

      const result = await attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'pw');

      expect(result.ok).toBe(true);
      expect(clicked).toEqual(['#action-button']);
    });

    it('never picks a disabled button at any tier', async () => {
      const disabledSubmit: InteractiveElement = {
        role: 'button',
        name: 'Sign in',
        selector: '#disabled-submit',
        inForm: true,
        buttonType: 'submit',
        disabled: true,
      };
      const enabledFallback: InteractiveElement = {
        role: 'button',
        name: 'Sign in',
        selector: '#enabled-fallback',
      };
      const clicked: string[] = [];
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/login': {
            elements: [EMAIL_FIELD, PASSWORD_FIELD, disabledSubmit, enabledFallback],
          },
          'https://a.test/dashboard': { elements: [] },
        },
        onSubmitGoTo: { 'https://a.test/login': 'https://a.test/dashboard' },
      });
      const originalClick = browser.click.bind(browser);
      browser.click = async (selector: string) => {
        clicked.push(selector);
        return originalClick(selector);
      };

      const result = await attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'pw');

      expect(result.ok).toBe(true);
      expect(clicked).toEqual(['#enabled-fallback']);
    });
  });
});

describe('attemptLoginViaToggle()', () => {
  it('replays the toggle click before filling the form, then succeeds like attemptLogin', async () => {
    // Models a same-URL client-side toggle (e.g. a register page's "Log in
    // instead" button): goto() lands on the register-shaped page, the toggle
    // click swaps in the login-shaped fields (mapped to a distinct page key
    // here since this fake has no separate reveal layer), and submitting
    // that revealed form succeeds.
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/register': { elements: [{ role: 'heading', name: 'Register', selector: 'h1' }] },
        'https://a.test/register#toggled-login': {
          elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON],
        },
        'https://a.test/dashboard': { elements: [{ role: 'heading', name: 'Dashboard', selector: 'h1' }] },
      },
      onClickSelectorGoTo: { '#toggle-login-btn': 'https://a.test/register#toggled-login' },
      onSubmitGoTo: { 'https://a.test/register#toggled-login': 'https://a.test/dashboard' },
    });

    const result = await attemptLoginViaToggle(
      browser,
      'https://a.test/register',
      '#toggle-login-btn',
      'user@a.test',
      'correct-pw',
    );

    expect(result.ok).toBe(true);
    expect(result.landingUrl).toBe('https://a.test/dashboard');
  });

  it('reports a reason and does not throw when the toggle click itself fails', async () => {
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/register': { elements: [{ role: 'heading', name: 'Register', selector: 'h1' }] },
      },
      throwOnSelector: new Set(['#toggle-login-btn']),
    });

    const result = await attemptLoginViaToggle(
      browser,
      'https://a.test/register',
      '#toggle-login-btn',
      'user@a.test',
      'pw',
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/failed to activate login toggle/i);
  });

  it('fails the same way as attemptLogin when the toggled-in view still has a password field after submit', async () => {
    vi.useFakeTimers();
    try {
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/register': { elements: [{ role: 'heading', name: 'Register', selector: 'h1' }] },
          'https://a.test/register#toggled-login': {
            elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON],
          },
        },
        onClickSelectorGoTo: { '#toggle-login-btn': 'https://a.test/register#toggled-login' },
        // No onSubmitGoTo entry: submitting leaves the session on the toggled-in view.
      });

      const resultPromise = attemptLoginViaToggle(
        browser,
        'https://a.test/register',
        '#toggle-login-btn',
        'user@a.test',
        'wrong-pw',
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/still on a page with a password field/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
