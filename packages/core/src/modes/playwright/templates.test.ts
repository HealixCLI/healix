import { describe, expect, it } from 'vitest';
import { authSetupContents, playwrightConfigContents } from './templates.js';

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
    expect(fixture).toContain("getByRole('button', { name: loginRevealRe })");
    expect(fixture).toContain("getByRole('link', { name: loginRevealRe })");
  });

  it('still writes performedLogin:false before attempting login and true only after storageState is captured', () => {
    const fixture = authSetupContents();
    const beforeIdx = fixture.indexOf('writeMeta(false)');
    const gotoIdx = fixture.indexOf('page.goto(loginUrl)');
    const storageIdx = fixture.indexOf('storageState({ path: authFile })');
    const afterIdx = fixture.indexOf('writeMeta(true)');
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(beforeIdx).toBeLessThan(gotoIdx);
    expect(storageIdx).toBeLessThan(afterIdx);
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
    const throwIdx = fixture.indexOf('throw new Error(');
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
