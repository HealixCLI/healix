/**
 * Unit tests for the deterministic triage rule chain.
 *
 * Exercised through the public engine surface (`createTriageEngine().classify`)
 * which delegates to `classifyByRules`. We feed representative Playwright error
 * strings and assert the resulting verdict, with particular focus on rule
 * ORDERING — the first-match chain must put environment before selector and
 * (critically) assertion before selector, so an assertion-timeout that also
 * mentions a locator is not misfiled as `test_is_wrong`.
 */
import { describe, it, expect } from 'vitest';
import { createTriageEngine } from './index.js';
import type { TriageInput, Verdict } from './types.js';

const engine = createTriageEngine();

function verdictFor(error: string, title = 'example test'): Verdict {
  const input: TriageInput = { title, error };
  return engine.classify(input).verdict;
}

describe('classifyByRules / engine.classify', () => {
  describe('blocked tierB-auth prerequisite (Healix synthetic message)', () => {
    it('classifies an auth-setup-failed blocked message as environment, not ambiguous', () => {
      const result = engine.classify({
        title: '[REQ:REQ-1] authenticated flow',
        error: 'Error: Auth setup failed — Tier B prerequisite not met.\nsome nested setup error',
      });
      expect(result.verdict).toBe('environment');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('classifies a no-credentials-configured blocked message as environment', () => {
      const result = engine.classify({
        title: '[REQ:REQ-1] authenticated flow',
        error:
          'Tier B ran without credentials (no HEALIX_TIERB_* configured; anonymous session).\nsome failure',
      });
      expect(result.verdict).toBe('environment');
    });

    it('takes precedence over environment-flavored text nested inside the setup error', () => {
      // The wrapped setup error itself contains ECONNREFUSED — the blocked-tierB rule must
      // still win (it's a MORE specific, MORE certain signal) rather than falling through to
      // the generic environment_unreachable rule, though both land on 'environment' here the
      // distinction matters once verdicts diverge or rationale text is surfaced to the user.
      const result = engine.classify({
        title: '[REQ:REQ-1] authenticated flow',
        error:
          'Error: Auth setup failed — Tier B prerequisite not met.\nError: connect ECONNREFUSED 127.0.0.1:3000',
      });
      expect(result.rationale).toContain('BLOCKED, not failed');
    });

    it('cites the ACTUAL cause (server unreachable) instead of hedging between "setup failed OR no credentials" when the wrapped error shows a real connection failure', () => {
      // The blocked test's error already carries the auth-setup fixture's own
      // real reason (execute.ts appends auth.setupError after the generic
      // prefix) — the rationale must say THAT, not a vague "could be either".
      const result = engine.classify({
        title: '[REQ:REQ-1] authenticated flow',
        error:
          'Auth setup failed — Tier B prerequisite not met.\n' +
          'net::ERR_CONNECTION_REFUSED at http://localhost:4202/login',
      });
      expect(result.rationale).toContain('unreachable');
      expect(result.rationale).not.toContain(
        'either the auth setup fixture itself failed, or the project has no test credentials configured',
      );
    });

    it('cites a genuine missing-credentials cause specifically when that really is what the wrapped error says', () => {
      const result = engine.classify({
        title: '[REQ:REQ-1] authenticated flow',
        error:
          'Auth setup failed — Tier B prerequisite not met.\n' +
          'Tier B auth setup skipped: no test credentials configured for this project.',
      });
      expect(result.rationale).toContain('no test credentials configured');
      expect(result.rationale).not.toContain('unreachable');
    });

    it('falls back to the generic "either X or Y" phrasing only when the wrapped error gives no specific reason at all', () => {
      const result = engine.classify({
        title: '[REQ:REQ-1] authenticated flow',
        error: 'Auth setup failed — Tier B prerequisite not met.',
      });
      expect(result.rationale).toContain(
        'either the auth setup fixture itself failed, or the project has no test credentials configured',
      );
    });

    it('classifies the auth-setup fixture\'s OWN "no credentials configured" message as environment (on the setup row itself, not just its cascaded dependants)', () => {
      const result = engine.classify({
        title: 'authenticate',
        error:
          'Tier B auth setup skipped: no test credentials configured for this project ' +
          '(and no HEALIX_TIERB_EMAIL/PASSWORD/LOGIN_URL env vars set). Set testUsername/testPassword on the project.',
      });
      expect(result.verdict).toBe('environment');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('classifies the auth-setup fixture\'s "submit button never became enabled" message as environment, not test_is_wrong', () => {
      const result = engine.classify({
        title: 'authenticate',
        error:
          'Login submit button never became enabled within 8s of filling both credential fields ' +
          '(still on http://localhost:4202/#/SK/login). Both fields were located (identifier field ' +
          'non-empty: true, password field non-empty: true), so this is not a selector gap — the ' +
          "app's own client-side validation is still refusing to enable submit.",
      });
      expect(result.verdict).toBe('environment');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("classifies a BARE auth-setup timeout as environment via execute.ts's own marker", () => {
      // The residual case the fixture's own messages can't cover: a fixture that times out
      // without emitting anything of its own. Before the marker this landed on the generic
      // timeout rule as environment @0.55 ("no selector or assertion context"), burying the
      // real cause of 45 blocked tests behind a low-confidence shrug.
      const result = engine.classify({
        title: 'authenticate',
        error: 'Tier B auth setup failed.\nTest timeout of 60000ms exceeded.',
      });
      expect(result.verdict).toBe('environment');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('does NOT over-match a plain, unrelated 60s timeout that lacks any Tier B phrase (regression guard)', () => {
      const result = engine.classify({
        title: 'some other test',
        error: 'Test timeout of 60000ms exceeded.\nwaiting for locator(\'button[type="submit"]\')',
      });
      expect(result.verdict).not.toBe('environment');
    });
  });

  describe('missing local dependency (browser binary / Node package never installed)', () => {
    it('classifies a missing Playwright browser executable as environment, not ambiguous', () => {
      const result = engine.classify({
        title: 'Exploring https://example.test/ (codegen)',
        error:
          "browserType.launch: Executable doesn't exist at C:\\Users\\x\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1228\\chrome-headless-shell-win64\\chrome-headless-shell.exe\n" +
          'Looks like Playwright was just installed or updated.\n' +
          'Please run the following command to download new browsers:\n\n    pnpm exec playwright install\n',
      });
      expect(result.verdict).toBe('environment');
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('classifies a missing Node module (Cannot find module) as environment', () => {
      const result = engine.classify({
        title: 'authenticate',
        error: "Error: Cannot find module 'express'\nRequire stack:\n- /app/server.js",
      });
      expect(result.verdict).toBe('environment');
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it.each([
      ['Cannot find package', "Error: Cannot find package '@playwright/test'"],
      ['ERR_MODULE_NOT_FOUND', 'Error [ERR_MODULE_NOT_FOUND]: Cannot resolve module'],
      ['MODULE_NOT_FOUND', "Error: Cannot resolve\n  code: 'MODULE_NOT_FOUND'"],
      ['npx playwright install (bare)', 'Please run the following command:\n\n    npx playwright install\n'],
      ['pnpm exec playwright install', '    pnpm exec playwright install\n'],
      ['yarn playwright install', '    yarn playwright install\n'],
      [
        'please run the following command to download new browsers (no install line)',
        'Please run the following command to download new browsers:',
      ],
    ])('classifies "%s" as environment', (_label, error) => {
      expect(verdictFor(error)).toBe('environment');
    });

    it('takes precedence over the generic bare-timeout rule when a missing-module error also mentions a timeout', () => {
      // A require() hang wrapped by some tooling can surface alongside timeout-flavored text;
      // the missing-dependency signal must still win rather than being read as generic slowness.
      const result = engine.classify({
        title: 'setup',
        error: "Error: Cannot find module 'left-pad'\nTimeout of 30000ms exceeded while loading.",
      });
      expect(result.verdict).toBe('environment');
      expect(result.rationale).toMatch(/dependency|installed/i);
    });

    it('does not fire on an ordinary selector or assertion failure that merely mentions "module" in passing', () => {
      expect(
        verdictFor(
          "locator.click: Error: locator not found for getByRole('button', { name: 'Submit module' })",
        ),
      ).toBe('test_is_wrong');
    });
  });

  describe('codegen defect (the generated test script itself threw a runtime error)', () => {
    it('classifies "is not a function" (a hallucinated Playwright API call) as test_is_wrong', () => {
      const result = engine.classify({
        title: 'some test',
        error: 'TypeError: page.getByRoleX is not a function',
      });
      expect(result.verdict).toBe('test_is_wrong');
      expect(result.confidence).toBeGreaterThanOrEqual(0.75);
    });

    it('classifies a ReferenceError (undeclared variable in generated code) as test_is_wrong', () => {
      expect(verdictFor('ReferenceError: expectedTitle is not defined')).toBe('test_is_wrong');
    });

    it('classifies "is not defined" as test_is_wrong', () => {
      expect(verdictFor('Error: someHelper is not defined')).toBe('test_is_wrong');
    });

    it('classifies an unguarded null/undefined property access as test_is_wrong', () => {
      expect(verdictFor("TypeError: Cannot read properties of null (reading 'textContent')")).toBe(
        'test_is_wrong',
      );
    });

    it('classifies "is not a constructor" as test_is_wrong', () => {
      expect(verdictFor('TypeError: SomeHelper is not a constructor')).toBe('test_is_wrong');
    });

    it('does not fire on an ordinary environment or assertion failure (no false positives)', () => {
      expect(verdictFor('Error: connect ECONNREFUSED 127.0.0.1:3000')).toBe('environment');
      expect(
        verdictFor(['Error: expect(received).toHaveText(expected)', 'Expected string: "Welcome"'].join('\n')),
      ).not.toBe('test_is_wrong');
    });
  });

  describe('environment failures', () => {
    it('classifies ECONNREFUSED as environment', () => {
      expect(verdictFor('Error: connect ECONNREFUSED 127.0.0.1:3000')).toBe('environment');
    });

    it('classifies net::ERR_CONNECTION_REFUSED as environment', () => {
      expect(verdictFor('page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/')).toBe(
        'environment',
      );
    });

    it('classifies a navigation (page.goto) timeout as environment', () => {
      expect(verdictFor('page.goto: Timeout 30000ms exceeded.\nNavigating to "http://localhost:3000/"')).toBe(
        'environment',
      );
    });

    it('classifies DNS resolution failure (ENOTFOUND) as environment', () => {
      expect(verdictFor('Error: getaddrinfo ENOTFOUND api.example.test')).toBe('environment');
    });
  });

  describe('flaky / unstable element failures', () => {
    it("classifies element 'not visible' as flaky", () => {
      expect(
        verdictFor(
          'locator.click: Error: element is not visible\nwaiting for element to be visible, enabled and stable',
        ),
      ).toBe('flaky');
    });

    it('classifies a detached element as flaky', () => {
      expect(verdictFor('locator.click: Error: element was detached from the DOM, retrying')).toBe('flaky');
    });

    it('classifies pointer-event interception as flaky', () => {
      expect(verdictFor('locator.click: Error: <div> intercepts pointer events at the click point')).toBe(
        'flaky',
      );
    });
  });

  describe('F-20: bare_timeout confidence lowered to reliably reach AI escalation', () => {
    it('a bare timeout now gets a LOWER confidence than flaky (previously tied at 0.55)', () => {
      const timeout = engine.classify({ title: 'x', error: 'page.waitForURL: Timeout 30000ms exceeded.' });
      const flaky = engine.classify({ title: 'y', error: 'locator.click: Error: element is not visible' });
      expect(timeout.verdict).toBe('environment');
      expect(timeout.confidence).toBeLessThan(flaky.confidence);
    });

    it('sorts ahead of tied-confidence flaky rivals for AI-escalation ORDER (orchestrator/index.ts ascending-sorts by confidence; every failure is eventually escalated, but a cancelled/budget-limited run reviews lowest-confidence first)', () => {
      // Mirrors the Flask CRUD scenario: a bare-timeout failure (the real
      // root cause is a DIFFERENT, already-diagnosed app_is_wrong bug
      // earlier in the same test — e.g. a broken form submit that hangs a
      // subsequent waitForURL) competing for EARLY review against several
      // flaky-confidence rivals.
      const flakyInputs = Array.from({ length: 5 }, (_, i) => ({
        title: `flaky ${i}`,
        error: 'locator.click: Error: element is not visible',
      }));
      const timeoutInput = { title: 'hung waitForURL', error: 'page.waitForURL: Timeout 30000ms exceeded.' };

      const all = [...flakyInputs, timeoutInput].map((input) => ({ input, triage: engine.classify(input) }));

      // Same ordering logic as orchestrator/index.ts's aiCandidates: sort
      // ascending by confidence (no cap anymore — this is purely about which
      // failure would be reviewed FIRST if a run stopped partway through).
      const ordered = [...all].sort((a, b) => a.triage.confidence - b.triage.confidence);
      const firstFive = new Set(ordered.slice(0, 5).map((s) => s.input.title));

      expect(firstFive.has(timeoutInput.title)).toBe(true);
      // Exactly one flaky candidate was bumped later — proves the lowered
      // confidence actually changed ordering, not just the number itself.
      expect(flakyInputs.filter((f) => firstFive.has(f.title))).toHaveLength(4);
    });
  });

  describe('selector / locator failures → test_is_wrong', () => {
    it("classifies pure 'locator not found' as test_is_wrong", () => {
      expect(
        verdictFor("locator.click: Error: locator not found for getByRole('button', { name: 'Checkout' })"),
      ).toBe('test_is_wrong');
    });

    it("classifies 'strict mode violation' as test_is_wrong", () => {
      expect(
        verdictFor("locator.click: Error: strict mode violation: getByRole('link') resolved to 4 elements"),
      ).toBe('test_is_wrong');
    });

    it("classifies 'resolved to 0 elements' as test_is_wrong", () => {
      expect(verdictFor("Error: locator.waitFor: getByText('Welcome back') resolved to 0 elements")).toBe(
        'test_is_wrong',
      );
    });
  });

  describe('F-19: redirect assertion without maxRedirects → test_is_wrong', () => {
    it('classifies "expected 302, got 200" (Flask CRUD update-entry-api-contract case) as test_is_wrong, not ambiguous', () => {
      // Real shape captured from the Flask CRUD run's error-context.md for
      // update-entry-api-contract-and-error-handling.spec.ts: the app DID
      // respond with a 302, but the request auto-followed it (no
      // maxRedirects: 0), so Playwright observed the terminal 200 instead.
      const error = [
        'Error: expect(received).toBe(expected) // Object.is equality',
        '',
        'Expected: 302',
        'Received: 200',
        '',
        '    at update-entry-api-contract-and-error-handling.spec.ts:45:34',
      ].join('\n');
      const result = engine.classify({
        title: '[REQ:REQ-1] update entry API contract and error handling',
        error,
      });
      expect(result.verdict).toBe('test_is_wrong');
    });

    it('also matches a 3xx other than 302 (e.g. 301) expected-vs-followed-200', () => {
      expect(verdictFor('Expected: 301\nReceived: 200')).toBe('test_is_wrong');
    });

    it('does not fire when the received status is not 200 (a genuinely different mismatch)', () => {
      expect(verdictFor('Expected: 302\nReceived: 500')).not.toBe('test_is_wrong');
    });
  });

  describe('status code assertion (a non-redirect HTTP status mismatch) → app_is_wrong, not ambiguous', () => {
    it('classifies "expected 200, got 500" as app_is_wrong', () => {
      const error = [
        'Error: expect(received).toBe(expected) // Object.is equality',
        '',
        'Expected: 200',
        'Received: 500',
        '',
        '    at status-codes-api-responses.spec.ts:22:38',
      ].join('\n');
      const result = engine.classify({ title: '[REQ:REQ-43] returns 200 for a valid request', error });
      expect(result.verdict).toBe('app_is_wrong');
      expect(result.confidence).toBeGreaterThanOrEqual(0.55);
    });

    it('classifies "expected 200, got 404" as app_is_wrong', () => {
      const error = [
        'Error: expect(received).toBe(expected) // Object.is equality',
        '',
        'Expected: 200',
        'Received: 404',
      ].join('\n');
      expect(verdictFor(error)).toBe('app_is_wrong');
    });

    it('classifies a toEqual status mismatch the same way', () => {
      const error = [
        'Error: expect(received).toEqual(expected) // deep equality',
        '',
        'Expected: 401',
        'Received: 403',
      ].join('\n');
      expect(verdictFor(error)).toBe('app_is_wrong');
    });

    it('still lets redirect_not_followed claim a genuine 3xx-expected/200-received case (no regression)', () => {
      const error = [
        'Error: expect(received).toBe(expected) // Object.is equality',
        '',
        'Expected: 302',
        'Received: 200',
      ].join('\n');
      expect(verdictFor(error)).toBe('test_is_wrong');
    });

    it('does NOT fire on a toHaveCount mismatch, even with small numbers that could look status-code-ish (no regression)', () => {
      const error = ['Error: expect(locator).toHaveCount(expected)', 'Expected: 3', 'Received: 2'].join('\n');
      expect(verdictFor(error)).toBe('ambiguous');
    });

    it('does not fire without the toBe/toEqual(expected) prefix (plain numbers alone are not enough)', () => {
      expect(verdictFor('Expected: 200\nReceived: 500')).not.toBe('app_is_wrong');
    });
  });

  describe('apiEvidence-corroborated rules (real captured API responses, not a guess)', () => {
    const ASSERTION_ERROR = 'Error: expect(received).toBeTruthy() failed\nReceived: undefined';

    describe('mock_response_incomplete', () => {
      it("classifies as environment when apiEvidence shows Healix's OWN mock answered", () => {
        const result = engine.classify({
          title: 'customer_lookup API',
          error: ASSERTION_ERROR,
          apiEvidence: '[HEALIX MOCK] GET /customer_lookup -> status 200\nBody: {}',
        });
        expect(result.verdict).toBe('environment');
        expect(result.confidence).toBeGreaterThanOrEqual(0.6);
        expect(result.rationale).toMatch(/mock/i);
      });

      it('does NOT fire when apiEvidence is absent (falls through to the generic ambiguous default)', () => {
        expect(verdictFor(ASSERTION_ERROR)).toBe('ambiguous');
      });

      it('does NOT fire when apiEvidence shows the REAL backend answered', () => {
        const result = engine.classify({
          title: 't',
          error: ASSERTION_ERROR,
          apiEvidence: '[REAL BACKEND] GET /customer_lookup -> status 200\nBody: {}',
        });
        expect(result.verdict).not.toBe('environment');
      });

      it('does NOT fire when the error itself has no expect()-style signature at all (apiEvidence alone is not enough)', () => {
        const result = engine.classify({
          title: 't',
          error: 'some unrelated crash with no matcher signature',
          apiEvidence: '[HEALIX MOCK] GET /customer_lookup -> status 200\nBody: {}',
        });
        expect(result.verdict).not.toBe('environment');
      });
    });

    describe('real_api_error_evidence', () => {
      it('classifies as app_is_wrong (high confidence) when apiEvidence shows a REAL 500', () => {
        const result = engine.classify({
          title: 't',
          error: ASSERTION_ERROR,
          apiEvidence: '[REAL BACKEND] GET /customer_lookup -> status 500\nBody: {}',
        });
        expect(result.verdict).toBe('app_is_wrong');
        expect(result.confidence).toBeGreaterThanOrEqual(0.75);
        expect(result.rationale).toContain('500');
      });

      it('classifies as app_is_wrong for a REAL 404 too', () => {
        const result = engine.classify({
          title: 't',
          error: ASSERTION_ERROR,
          apiEvidence: '[REAL BACKEND] GET /x -> status 404\nBody: {}',
        });
        expect(result.verdict).toBe('app_is_wrong');
      });

      it('does NOT fire on a REAL 2xx status (no error to corroborate)', () => {
        const result = engine.classify({
          title: 't',
          error: ASSERTION_ERROR,
          apiEvidence: '[REAL BACKEND] GET /x -> status 200\nBody: {}',
        });
        expect(result.verdict).not.toBe('app_is_wrong');
      });

      it('does NOT fire on a MOCKED 500 (that path belongs to mock_response_incomplete, not this rule)', () => {
        const result = engine.classify({
          title: 't',
          error: ASSERTION_ERROR,
          apiEvidence: '[HEALIX MOCK] GET /x -> status 500\nBody: {}',
        });
        expect(result.verdict).not.toBe('app_is_wrong');
      });
    });
  });

  describe('suite_url_convention_mismatch', () => {
    const BASE_URL = 'http://localhost:4202/#/SK/home';
    const NOT_FOUND_ERROR = "Error: expect(locator).toBeVisible() failed\nLocator: getByText('Not found')";
    const NULL_VALUE_ERROR = 'Expected: "T"\nReceived: null';

    it("classifies as test_is_wrong when the test's own goto() omits the baseUrl's required path segment", () => {
      const result = engine.classify({
        title: 't',
        error: NULL_VALUE_ERROR,
        baseUrl: BASE_URL,
        specSource: "await page.goto('/#/?token=T&mobile=M&lang=ar-sa');",
      });
      expect(result.verdict).toBe('test_is_wrong');
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      expect(result.rationale).toContain('/#/?token=T&mobile=M&lang=ar-sa');
      expect(result.rationale).toMatch(/suite|codegen/i);
    });

    it('fires the same way for a "Not found" gate test using the same shallow convention', () => {
      const result = engine.classify({
        title: 't',
        error: NOT_FOUND_ERROR,
        baseUrl: BASE_URL,
        specSource: "await page.goto('/#/?token=abc123');",
      });
      expect(result.verdict).toBe('test_is_wrong');
    });

    it('does NOT fire when the goto target already matches the baseUrl convention (e.g. includes /SK/)', () => {
      const result = engine.classify({
        title: 't',
        error: NULL_VALUE_ERROR,
        baseUrl: BASE_URL,
        specSource: "await page.goto('/#/SK/home?token=T&mobile=M');",
      });
      expect(result.verdict).not.toBe('test_is_wrong');
    });

    it('does NOT fire when baseUrl is absent', () => {
      const result = engine.classify({
        title: 't',
        error: NULL_VALUE_ERROR,
        specSource: "await page.goto('/#/?token=T&mobile=M&lang=ar-sa');",
      });
      expect(result.verdict).not.toBe('test_is_wrong');
    });

    it('does NOT fire when specSource is absent (nothing to compare)', () => {
      const result = engine.classify({
        title: 't',
        error: NULL_VALUE_ERROR,
        baseUrl: BASE_URL,
      });
      expect(result.verdict).not.toBe('test_is_wrong');
    });

    it("does NOT fire when the app's own baseUrl has no required path segment (bare hash root)", () => {
      const result = engine.classify({
        title: 't',
        error: NULL_VALUE_ERROR,
        baseUrl: 'http://localhost:4202/#/',
        specSource: "await page.goto('/#/?token=T');",
      });
      expect(result.verdict).not.toBe('test_is_wrong');
    });

    it('does NOT fire when none of the goto() calls carry query params (nothing to compare)', () => {
      const result = engine.classify({
        title: 't',
        error: NOT_FOUND_ERROR,
        baseUrl: BASE_URL,
        specSource: "await page.goto('/#/games');",
      });
      expect(result.verdict).not.toBe('test_is_wrong');
    });
  });

  describe('assertion failures', () => {
    it('classifies a content (text) assertion mismatch as app_is_wrong', () => {
      const verdict = verdictFor(
        [
          'Error: expect(received).toHaveText(expected)',
          'Expected string: "Welcome, Alice"',
          'Received string: "Welcome, Bob"',
        ].join('\n'),
      );
      expect(verdict).toBe('app_is_wrong');
    });

    it('classifies a URL assertion mismatch as app_is_wrong', () => {
      const verdict = verdictFor(
        [
          'Error: expect(page).toHaveURL(expected)',
          'Expected string: "/dashboard"',
          'Received string: "/login"',
        ].join('\n'),
      );
      expect(verdict).toBe('app_is_wrong');
    });

    it('classifies a non-content assertion (toHaveCount) as ambiguous', () => {
      const verdict = verdictFor(
        ['Error: expect(locator).toHaveCount(expected)', 'Expected: 3', 'Received: 2'].join('\n'),
      );
      expect(verdict).toBe('ambiguous');
    });
  });

  describe('CRITICAL regression: assertion timeout that also mentions a locator', () => {
    // Playwright assertion-timeout output embeds locator phrases such as
    // "waiting for locator" and getBy* text. The selector rule MUST NOT
    // pre-empt the assertion rule, otherwise a real content regression is
    // misattributed to a stale selector (test_is_wrong).
    const assertionTimeoutWithLocator = [
      'Error: expect(locator).toHaveText(expected)',
      '',
      'Expected string: "Order confirmed"',
      'Received string: "Order failed"',
      '',
      'Call log:',
      '  - expect.toHaveText with timeout 5000ms',
      "  - waiting for locator('#status')",
      '  - locator resolved to <div id="status">Order failed</div>',
    ].join('\n');

    it('does NOT classify as test_is_wrong (selector rule must not win)', () => {
      expect(verdictFor(assertionTimeoutWithLocator)).not.toBe('test_is_wrong');
    });

    it('classifies as an assertion-related verdict (app_is_wrong / ambiguous)', () => {
      const verdict = verdictFor(assertionTimeoutWithLocator);
      expect(['app_is_wrong', 'ambiguous']).toContain(verdict);
    });

    it('a toBeVisible assertion timeout mentioning a locator is not test_is_wrong', () => {
      const error = [
        'Error: expect(locator).toBeVisible()',
        '',
        'Call log:',
        '  - expect.toBeVisible with timeout 5000ms',
        "  - waiting for getByRole('alert')",
      ].join('\n');
      const verdict = verdictFor(error);
      expect(verdict).not.toBe('test_is_wrong');
      expect(['app_is_wrong', 'ambiguous']).toContain(verdict);
    });
  });

  describe('default / unknown failures', () => {
    it('classifies an unrecognized error as ambiguous (low-confidence default)', () => {
      const result = engine.classify({
        title: 'mystery failure',
        error: 'Error: something completely unrecognized happened in worker 2',
      });
      expect(result.verdict).toBe('ambiguous');
      expect(result.confidence).toBeLessThanOrEqual(0.3);
    });

    it('handles empty error text without throwing, yielding ambiguous', () => {
      expect(verdictFor('')).toBe('ambiguous');
    });
  });
});
