/**
 * Deterministic first-match failure rules — ported/adapted from TestBot's
 * failure-triage/classifier.js.
 *
 * Why deterministic-first: LLMs have a documented "blame the test" bias, so
 * running cheap rule-based detection first yields confident-correct verdicts
 * for clear cases (server down, locator hallucinated, navigation timeout) and
 * keeps the AI hypothesis layer for genuinely ambiguous failures only.
 *
 * Each matcher inspects the raw error text (and, for content assertions, the
 * test title) and returns a partial verdict. The engine evaluates them in
 * order and takes the first match; if none fire we default to `ambiguous`
 * with low confidence so the AI layer can take over.
 */
import type { TriageInput, TriageResult, Verdict } from './types.js';

interface Rule {
  readonly id: string;
  /** Returns a verdict when this rule fires, otherwise null. */
  match(error: string, title: string, input: TriageInput): TriageResult | null;
}

// --- Signal regexes ---------------------------------------------------------

// Locator/selector resolution problems → the test referenced something the app
// does not expose. "strict mode violation" = the locator matched >1 element.
const RE_SELECTOR_NOT_FOUND =
  /(strict mode violation|resolved to 0 elements|locator not found|waiting for (?:locator|selector)|locator\.[a-zA-Z]+: *Timeout|getByRole|getByText|getByLabel|no element|element\(s\) not found)/i;

// Environment / infrastructure: server unreachable, DNS, connection refused,
// or a navigation (page.goto) that timed out.
const RE_ENVIRONMENT =
  /(net::ERR_CONNECTION|net::ERR_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|page\.goto: *Timeout|Timeout.*(?:goto|navigat)|Navigation (?:timeout|failed)|net::ERR_NAME_NOT_RESOLVED)/i;

// A bare Timeout (action/wait level) that is not already a navigation or
// selector timeout — treated as environment/slowness.
const RE_TIMEOUT = /\bTimeout(?:Error)?\b|timed out/i;

// Element became unstable: present but not interactable / removed mid-action.
const RE_FLAKY =
  /(not visible|element is not visible|detached|not stable|intercepts pointer events|element is outside of the viewport|not attached)/i;

// Assertion failures — Playwright's expect() output.
const RE_ASSERTION =
  /(expect\(received\)|expect\(.*?\)\.(?:to[A-Za-z]+)|Expected (?:string|substring|value|pattern)|toHaveText|toHaveURL|toContainText|toBeVisible|toHaveValue|toHaveCount|toMatchSnapshot|Received string|assertion)/i;

// Within an assertion, signals that it is a *content* check (text/url/value)
// rather than a visibility/count check — leans toward app_is_wrong.
const RE_CONTENT_ASSERTION =
  /(toHaveText|toContainText|toHaveURL|toHaveValue|Expected substring|Expected string|Received string|toHaveTitle)/i;

// Signals that an error is fundamentally an assertion failure, even though it
// may also mention a locator (Playwright includes "waiting for locator" /
// getBy* text inside expect() timeout output). When any of these are present we
// suppress the selector rule so the assertion rule can claim the verdict.
const RE_ASSERTION_CONTEXT =
  /(expect\(|Expected:|Received:|Expected (?:string|substring|value|pattern)|Received string|toHaveText|toContainText|toBeVisible|toHaveURL|toHaveValue|toHaveCount|toHaveTitle|toMatchSnapshot)/i;

function mk(verdict: Verdict, confidence: number, rationale: string): TriageResult {
  return { verdict, confidence, rationale };
}

/**
 * Rule order matters (first-match-wins):
 *  1. environment   — a down server makes every selector lookup "fail", so it
 *     must pre-empt the selector rule.
 *  2. assertion     — expect() mismatch; content checks lean app_is_wrong,
 *     everything else is genuinely ambiguous. Runs BEFORE the selector rule
 *     because Playwright assertion-timeout output embeds locator phrases
 *     ("waiting for locator", getBy*) that would otherwise be misclassified as
 *     test_is_wrong.
 *  3. selector      — locator not found / strict-mode → the test is wrong.
 *     Suppressed when assertion signals (expect(), Expected/Received,
 *     toHaveText/toBeVisible …) are present.
 *  4. flaky         — visibility/detached/instability.
 *  5. timeout       — residual bare timeouts → environment/slowness.
 */
const RULES: readonly Rule[] = [
  {
    id: 'environment_unreachable',
    match(error) {
      if (!RE_ENVIRONMENT.test(error)) return null;
      return mk(
        'environment',
        0.75,
        'Connection/navigation failure (server unreachable, DNS, or navigation timeout) — the app under test could not be loaded, so this is an environment issue rather than a real defect.',
      );
    },
  },
  {
    id: 'assertion_mismatch',
    match(error) {
      if (!RE_ASSERTION.test(error)) return null;
      if (RE_CONTENT_ASSERTION.test(error)) {
        return mk(
          'app_is_wrong',
          0.5,
          'A content assertion (text/url/value) failed even though the element resolved — the app rendered content that does not match the expected acceptance criteria. Leaning app_is_wrong, but ambiguous enough to warrant review.',
        );
      }
      return mk(
        'ambiguous',
        0.5,
        'An expect() assertion failed. Without more context this could be a stale expectation in the test or a genuine app regression.',
      );
    },
  },
  {
    id: 'selector_not_found',
    match(error) {
      // Playwright assertion-timeout output embeds locator phrases ("waiting
      // for locator", getBy*); only treat this as a selector defect when there
      // is no assertion context, otherwise the assertion rule above owns it.
      if (RE_ASSERTION_CONTEXT.test(error)) return null;
      if (!RE_SELECTOR_NOT_FOUND.test(error)) return null;
      return mk(
        'test_is_wrong',
        0.7,
        "The test's locator did not resolve to exactly one element (not found, zero matches, or strict-mode violation). This usually means the selector in the test no longer matches the live UI.",
      );
    },
  },
  {
    id: 'element_unstable',
    match(error) {
      if (!RE_FLAKY.test(error)) return null;
      return mk(
        'flaky',
        0.55,
        'The element was present but not interactable (not visible, detached, unstable, or pointer-intercepted) at the moment of the action — a classic timing/flakiness signature that often passes on retry.',
      );
    },
  },
  {
    id: 'bare_timeout',
    match(error) {
      if (!RE_TIMEOUT.test(error)) return null;
      return mk(
        'environment',
        0.55,
        'A timeout fired with no selector or assertion context — most likely the app or environment was slow to respond rather than a deterministic defect.',
      );
    },
  },
];

/**
 * Run the deterministic rule chain. Returns the first matching verdict, or a
 * low-confidence `ambiguous` default when nothing fires (handing off to AI).
 */
export function classifyByRules(input: TriageInput): TriageResult {
  const error = String(input.error ?? '');
  const title = String(input.title ?? '');
  for (const rule of RULES) {
    const hit = rule.match(error, title, input);
    if (hit) return hit;
  }
  return mk(
    'ambiguous',
    0.3,
    'No deterministic rule matched this failure. The error did not contain a recognizable selector, navigation, assertion, or flakiness signature — escalate to AI analysis for a verdict.',
  );
}
