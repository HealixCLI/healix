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
        error: 'Tier B ran without credentials (no HEALIX_TIERB_* configured; anonymous session).\nsome failure',
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
        error: 'Error: Auth setup failed — Tier B prerequisite not met.\nError: connect ECONNREFUSED 127.0.0.1:3000',
      });
      expect(result.rationale).toContain('BLOCKED, not failed');
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
