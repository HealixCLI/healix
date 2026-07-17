import { describe, expect, it } from 'vitest';
import { attemptLogin } from './login.js';
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
  throwOnClick?: boolean;
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
    async click(_selector: string): Promise<void> {
      if (config.throwOnClick) throw new Error('click failed');
      const next = config.onSubmitGoTo?.[currentUrl];
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
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/login': { elements: [EMAIL_FIELD, PASSWORD_FIELD, SUBMIT_BUTTON] },
      },
      // No onSubmitGoTo entry: click() is a no-op, session stays on /login.
    });

    const result = await attemptLogin(browser, 'https://a.test/login', 'user@a.test', 'wrong-pw');

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/still on a page with a password field/i);
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
});
