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
    async exportStorageState() {
      return {};
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

  it('reports no password field only after waiting for one to mount', async () => {
    // Deliberately NOT fast: a client-side-routed page can hold the previous route's elements
    // (or none) for a moment after goto(), so absence is only real after a bounded wait —
    // see waitForCredentialForm. Driven by fake timers rather than a real 5-second sleep.
    vi.useFakeTimers();
    try {
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/not-a-login-page': {
            elements: [{ role: 'heading', name: 'Home', selector: 'h1' }],
          },
        },
      });

      const resultPromise = attemptLogin(browser, 'https://a.test/not-a-login-page', 'user@a.test', 'pw');
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/no password field/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits out a late-mounting credential form instead of declaring the page has none', async () => {
    vi.useFakeTimers();
    try {
      const pages: Record<string, { elements: InteractiveElement[] }> = {
        // Mounts empty, exactly as a hash-routed SPA does between goto() and hydration.
        'https://a.test/login': { elements: [] },
      };
      const browser = makeFakeBrowser({
        pages,
        onSubmitGoTo: { 'https://a.test/login': 'https://a.test/home' },
      });
      pages['https://a.test/home'] = { elements: [] };

      const resultPromise = attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'pw');
      // Hydrate the form one poll interval in.
      await vi.advanceTimersByTimeAsync(300);
      pages['https://a.test/login'].elements = [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON];
      await vi.advanceTimersByTimeAsync(5_000);

      const result = await resultPromise;
      expect(result.ok).toBe(true);
      expect(result.landingUrl).toBe('https://a.test/home');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicks a login-named control to reveal a form hidden behind a register/login toggle', async () => {
    const TOGGLE: InteractiveElement = {
      role: 'button',
      name: 'Prihlásiť sa',
      selector: 'form > div > button',
      buttonType: 'button',
      inForm: true,
    };
    const browser = makeFakeBrowser({
      pages: {
        // The register view: no password field is reachable until the toggle is clicked.
        'https://a.test/#/SK/register': { elements: [TOGGLE] },
        'https://a.test/#/SK/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON] },
        'https://a.test/#/SK/dashboard': { elements: [] },
      },
      onClickSelectorGoTo: { 'form > div > button': 'https://a.test/#/SK/login' },
      onSubmitGoTo: { 'https://a.test/#/SK/login': 'https://a.test/#/SK/dashboard' },
    });

    const result = await attemptLogin(browser, 'https://a.test/#/SK/register', 'user@a.test', 'pw');

    expect(result.ok).toBe(true);
    expect(result.landingUrl).toBe('https://a.test/#/SK/dashboard');
  });

  it('refuses to submit a registration form as a login', async () => {
    const REGISTER_SUBMIT: InteractiveElement = {
      role: 'button',
      name: 'Pokračovať',
      selector: 'button[data-testid="register-submit"]',
      buttonType: 'submit',
      inForm: true,
    };
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/#/SK/register': {
          elements: [EMAIL_FIELD, PASSWORD_FIELD, REGISTER_SUBMIT],
        },
      },
    });

    const result = await attemptLogin(browser, 'https://a.test/#/SK/register', 'user@a.test', 'pw');

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/registration form/i);
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

  describe('username field selection (via attemptLogin, selector recorded per type() call)', () => {
    it('picks the textbox closest to the password field, not the first textbox on the page', async () => {
      // A header search box appears well before the real login form in DOM
      // order — the naive "first non-password textbox" heuristic would type
      // the username into it instead of the real email field.
      const searchBox: InteractiveElement = { role: 'textbox', name: 'Search', selector: '#search' };
      const realEmailField: InteractiveElement = {
        role: 'textbox',
        name: 'Email',
        selector: '#real-email',
        inputType: 'email',
      };
      const typed: Array<{ selector: string; text: string }> = [];
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/login': {
            elements: [searchBox, realEmailField, PASSWORD_FIELD, SUBMIT_BUTTON],
          },
          'https://a.test/dashboard': { elements: [] },
        },
        onSubmitGoTo: { 'https://a.test/login': 'https://a.test/dashboard' },
      });
      const originalType = browser.type.bind(browser);
      browser.type = async (selector: string, text: string) => {
        typed.push({ selector, text });
        return originalType(selector, text);
      };

      const result = await attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'pw');

      expect(result.ok).toBe(true);
      expect(typed).toContainEqual({ selector: '#real-email', text: 'user@a.test' });
      expect(typed).not.toContainEqual({ selector: '#search', text: 'user@a.test' });
    });

    it('prefers a textbox that comes AFTER the password field when it is strictly nearer than one before it', async () => {
      // Some forms render password before username (uncommon but real) —
      // proximity must work in both directions, not just "look backward".
      const farBefore: InteractiveElement = { role: 'textbox', name: 'Newsletter', selector: '#newsletter' };
      const distractor1: InteractiveElement = { role: 'button', name: 'Menu', selector: '#menu' };
      const distractor2: InteractiveElement = { role: 'link', name: 'Help', selector: '#help' };
      const nearAfter: InteractiveElement = {
        role: 'textbox',
        name: 'Username',
        selector: '#near-username',
        inputType: 'text',
      };
      const typed: Array<{ selector: string; text: string }> = [];
      const browser = makeFakeBrowser({
        pages: {
          'https://a.test/login': {
            elements: [farBefore, distractor1, distractor2, PASSWORD_FIELD, nearAfter, SUBMIT_BUTTON],
          },
          'https://a.test/dashboard': { elements: [] },
        },
        onSubmitGoTo: { 'https://a.test/login': 'https://a.test/dashboard' },
      });
      const originalType = browser.type.bind(browser);
      browser.type = async (selector: string, text: string) => {
        typed.push({ selector, text });
        return originalType(selector, text);
      };

      const result = await attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'pw');

      expect(result.ok).toBe(true);
      expect(typed).toContainEqual({ selector: '#near-username', text: 'user@a.test' });
    });
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
