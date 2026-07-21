import { describe, expect, it } from 'vitest';
import { authSetupContents, mockFixtureContents, playwrightConfigContents } from './templates.js';

describe('playwrightConfigContents — artifact capture policy', () => {
  it('records a screenshot AND video for every test, pass or fail', () => {
    const cfg = playwrightConfigContents();
    // 'on' (not 'only-on-failure' / 'retain-on-failure') is load-bearing: the
    // run detail's media gallery must have something to show for EVERY UI test.
    expect(cfg).toContain("screenshot: 'on'");
    expect(cfg).toContain("video: 'on'");
    expect(cfg).toContain("trace: 'retain-on-failure'");
  });

  it('declares the json/html/list reporters that produce results.json and playwright-report/', () => {
    const cfg = playwrightConfigContents();
    expect(cfg).toContain("['json', { outputFile: 'results.json' }]");
    expect(cfg).toContain("['html', { open: 'never' }]");
    expect(cfg).toContain("['list']");
  });

  it('honors HEALIX_BASE_URL over any baked-in base URL', () => {
    expect(playwrightConfigContents({ baseUrl: 'http://example.test' })).toContain(
      'process.env.HEALIX_BASE_URL || "http://example.test"',
    );
    expect(playwrightConfigContents()).toContain("process.env.HEALIX_BASE_URL || 'http://localhost:3000'");
  });

  it('enables retries locally so flaky detection can trigger (overridable via HEALIX_RETRIES)', () => {
    const cfg = playwrightConfigContents();
    // Local default must be non-zero (1) or a fail-then-pass can never register
    // as flaky; CI gets 2; HEALIX_RETRIES overrides both.
    expect(cfg).toContain('process.env.HEALIX_RETRIES');
    expect(cfg).toContain('process.env.CI ? 2 : 1');
  });
});

describe('mockFixtureContents', () => {
  it('embeds the given routes and re-exports test/expect from @playwright/test', () => {
    const src = mockFixtureContents([
      { id: 'pkg:twilio', hostnames: ['api.twilio.com'], response: { status: 200, body: { ok: true } } },
    ]);
    expect(src).toContain("from '@playwright/test'");
    expect(src).toContain('"id": "pkg:twilio"');
    expect(src).toContain('"api.twilio.com"');
    expect(src).toContain('page.route(');
    expect(src).toContain('export { expect };');
  });

  it('produces a harmless no-op fixture for an empty route list', () => {
    const src = mockFixtureContents([]);
    expect(src).toContain('const MOCKED_ROUTES = []');
  });
});

describe('authSetupContents — locale-aware login fixture', () => {
  it('matches email/password fields and the submit button in both English and common Slovak forms', () => {
    const fixture = authSetupContents();
    // Email: plain "email" and hyphenated "e-mail"/"e-mailová" forms.
    expect(fixture).toContain('/e-?mail/i');
    // Password: English + Slovak "Heslo".
    expect(fixture).toContain('/heslo|password/i');
    // Submit/reveal: English + Slovak "Prihlásiť" (matched via the "prihl" stem).
    expect(fixture).toContain('prihl');
  });

  it('clicks through a login-reveal control before searching for the form when no email field is visible', () => {
    const fixture = authSetupContents();
    expect(fixture).toContain('hasEmailField');
    expect(fixture).toContain('submitButtonLocator(page, loginRevealRe)');
  });

  it('prefers native submit semantics and test-hint attributes over localized button text when finding the submit button', () => {
    const fixture = authSetupContents();
    // A button's visible text is locale-dependent (e.g. a Slovak app's submit
    // button reads "Pokračovať", not "continue"/"prihl") — native type="submit"
    // and data-testid/name/id hints must be tried first, with the text regex
    // only as a last-resort fallback.
    expect(fixture).toContain('function submitButtonLocator(page, textRe)');
    expect(fixture).toContain('button[type="submit"], input[type="submit"]');
    expect(fixture).toContain('[data-testid*="submit" i]');
    expect(fixture).toContain('submitButtonLocator(page, /prihl|sign in|log ?in|continue/i)');
  });

  it('still writes performedLogin:false before attempting login and true only after storageState is captured', () => {
    const fixture = authSetupContents();
    const beforeIdx = fixture.indexOf('writeMeta(false)');
    const loginCallIdx = fixture.indexOf('await login(page, defaultCred, loginUrl, baseUrl, authFile)');
    const storageIdx = fixture.indexOf('storageState({ path });');
    const afterIdx = fixture.indexOf('writeMeta(true)');
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(beforeIdx).toBeLessThan(loginCallIdx);
    expect(loginCallIdx).toBeLessThan(afterIdx);
    // storageState is captured inside the shared login()/loginForm()/loginUrlToken() helpers.
    expect(storageIdx).toBeGreaterThanOrEqual(0);
  });

  it('dispatches to url-token login when a credential is authType url-token', () => {
    const fixture = authSetupContents();
    expect(fixture).toContain("cred.authType === 'url-token'");
    expect(fixture).toContain('loginUrlToken(page, cred, baseUrl, path)');
  });

  it('logs in every additional role-tagged credential into its own storageState file without blocking the default session', () => {
    const fixture = authSetupContents();
    expect(fixture).toContain('HEALIX_TIERB_CREDENTIALS_JSON');
    expect(fixture).toContain('roleStorageStatePath');
    expect(fixture).toContain('browser.newContext()');
  });

  it('throws immediately when credentials/login URL are not fully resolved, instead of writing an anonymous storageState', () => {
    const fixture = authSetupContents();
    // No env var is missing an anonymous fallback anymore: an incomplete
    // email/password/loginUrl trio must throw, not silently produce
    // {"cookies": [], "origins": []} — that anonymous session used to let
    // every Tier B spec run to its own 60s timeout instead of failing fast.
    expect(fixture).not.toContain('cookies: []');
    expect(fixture).not.toContain('access(authFile)');
    const guardIdx = fixture.indexOf('if (!email || !password || !loginUrl)');
    const throwIdx = fixture.indexOf('throw new Error(', guardIdx);
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(throwIdx).toBeGreaterThan(guardIdx);
    expect(fixture).toContain('Tier B auth setup skipped');
    expect(fixture).toContain('testUsername/testPassword');
  });

  it('writes performedLogin:false before throwing on the missing-credentials path, so post-run triage can classify it as blocked', () => {
    const fixture = authSetupContents();
    const guardIdx = fixture.indexOf('if (!email || !password || !loginUrl)');
    const blockStart = fixture.indexOf('{', guardIdx);
    const blockEnd = fixture.indexOf('}', fixture.indexOf('throw new Error(', guardIdx));
    const block = fixture.slice(blockStart, blockEnd);
    expect(block).toContain('writeMeta(false)');
    expect(block.indexOf('writeMeta(false)')).toBeLessThan(block.indexOf('throw new Error('));
  });

  it('verifies the login form actually navigated away before capturing storageState, instead of trusting a networkidle wait', () => {
    const fixture = authSetupContents();
    // GAP-017-style regression guard: a click that "succeeds" without ever
    // authenticating (wrong credentials, async login chain still pending)
    // must not be captured as a real session.
    expect(fixture).toContain('function waitForLoginOutcome(page, beforeUrl)');
    expect(fixture).toContain('stillHasPasswordField && !navigatedAway');
    const verifyIdx = fixture.indexOf(
      'waitForLoginOutcome(page, beforeUrl)',
      fixture.indexOf('async function loginForm'),
    );
    const storageIdx = fixture.indexOf('storageState({ path })', fixture.indexOf('async function loginForm'));
    expect(verifyIdx).toBeGreaterThan(0);
    expect(verifyIdx).toBeLessThan(storageIdx);
  });

  it('throws on an empty captured session for url-token logins instead of silently succeeding', () => {
    const fixture = authSetupContents();
    expect(fixture).toContain('state.cookies.length === 0 && state.origins.length === 0');
  });

  it('never leaves the setup fixture with a no-op success path when credentials are missing', () => {
    // Regression guard for the old shape: the function used to `return;` after
    // the anonymous-session fallback so `setup('authenticate', ...)` resolved
    // successfully. Now every path either performs a real login or throws.
    const fixture = authSetupContents();
    const setupBodyStart = fixture.indexOf("setup('authenticate'");
    const setupBody = fixture.slice(setupBodyStart);
    expect(setupBody).not.toMatch(/access\(authFile\)/);
  });
});
