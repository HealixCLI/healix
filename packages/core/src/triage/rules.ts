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

// Healix's own synthetic 'blocked' messages (execute.ts) — a tierB-auth prerequisite
// wasn't met (setup fixture failed, or the project has no credentials configured so the
// session ran anonymously). Neither the app nor the test is defective; this is a run-setup
// gap that only project configuration can close. Must run BEFORE the generic environment
// rule below, since a wrapped setup error can itself contain environment-flavored text
// (e.g. a real ECONNREFUSED from a failed login attempt) that would otherwise steal the match.
//
// The third alternative also covers the generated auth fixture's OWN messages
// (authSetupContents() in templates.ts), which surface on the auth-setup row itself —
// the row execute.ts deliberately keeps visible as the root cause of a blocked Tier B —
// rather than only on its cascaded dependants: "Tier B auth setup skipped: no test
// credentials configured..." and "Login submit button never became enabled...". Without
// this, those rows fell through to the generic selector/timeout rules below and were
// misclassified as test_is_wrong/ambiguous instead of the environment/config issue they are.
const RE_BLOCKED_TIERB =
  /Tier B prerequisite not met|Tier B ran without credentials|Tier B auth setup skipped|submit button never became enabled/;

// Missing local dependency (a Playwright browser binary never downloaded, or
// a Node package never installed) — a Healix/CI environment setup gap, not a
// defect in the app or the test. Must run before the generic environment rule
// (and before selector/assertion) since "Executable doesn't exist" carries no
// navigation/connection signal of its own and would otherwise fall through to
// the low-confidence ambiguous default.
const RE_MISSING_DEPENDENCY =
  /(Executable doesn't exist|browserType\.launch:|please run the following command to download new browsers|npx playwright install|pnpm (?:exec )?playwright install|yarn playwright install|Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)/i;

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

// A status-code assertion that expected a redirect (3xx) but observed the
// FOLLOWED redirect's terminal response (200) instead — the signature of a
// request made without disabling auto-redirect-following (e.g. missing
// `maxRedirects: 0`). This is the test's own request configuration being
// incomplete, not the app misbehaving: the app DID redirect; the test just
// never stopped to look at the intermediate response.
const RE_REDIRECT_NOT_FOLLOWED = /Expected:?\s*"?3\d{2}"?[\s\S]{0,120}?Received:?\s*"?200"?\b/i;

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
 *  1. blocked_tierb — Healix's own synthetic "prerequisite not met" message;
 *     must pre-empt everything else since a wrapped setup error can contain
 *     any other signal (environment, assertion, ...) inside it.
 *  2. missing_dependency — a browser binary or Node package was never
 *     installed; carries no navigation/connection signal of its own, so it
 *     must run before the generic environment/selector/assertion rules or it
 *     falls through to the low-confidence ambiguous default.
 *  3. environment   — a down server makes every selector lookup "fail", so it
 *     must pre-empt the selector rule.
 *  4. redirect_not_followed — expected a 3xx, observed the followed
 *     redirect's terminal 200 → the test's own request is missing
 *     `maxRedirects: 0`. Runs BEFORE the generic assertion rule so this
 *     specific, high-confidence test_is_wrong signal isn't swallowed by the
 *     lower-confidence default-ambiguous/app_is_wrong assertion bucket
 *     first (first-match wins).
 *  5. assertion     — expect() mismatch; content checks lean app_is_wrong,
 *     everything else is genuinely ambiguous. Runs BEFORE the selector rule
 *     because Playwright assertion-timeout output embeds locator phrases
 *     ("waiting for locator", getBy*) that would otherwise be misclassified as
 *     test_is_wrong.
 *  6. selector      — locator not found / strict-mode → the test is wrong.
 *     Suppressed when assertion signals (expect(), Expected/Received,
 *     toHaveText/toBeVisible …) are present.
 *  7. flaky         — visibility/detached/instability.
 *  8. timeout       — residual bare timeouts → environment/slowness.
 */
const RULES: readonly Rule[] = [
  {
    id: 'blocked_tierb_prerequisite',
    match(error) {
      if (!RE_BLOCKED_TIERB.test(error)) return null;
      return mk(
        'environment',
        0.9,
        'This test was BLOCKED, not failed: a Tier-B auth prerequisite was not met (either the auth setup fixture itself failed, or the project has no test credentials configured, so the session ran anonymously). Neither the app nor the test is defective — add test credentials (or fix the underlying auth setup failure) to unblock this coverage.',
      );
    },
  },
  {
    id: 'missing_dependency',
    match(error) {
      if (!RE_MISSING_DEPENDENCY.test(error)) return null;
      return mk(
        'environment',
        0.85,
        'A required local dependency (a Playwright browser binary, or a Node package) was never installed in this execution environment — not an app or test defect. Install the missing dependency (e.g. `npx playwright install`, or a package install) and re-run.',
      );
    },
  },
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
    id: 'redirect_not_followed',
    match(error) {
      if (!RE_REDIRECT_NOT_FOLLOWED.test(error)) return null;
      return mk(
        'test_is_wrong',
        0.7,
        "The test expected a redirect status (3xx) but observed 200 — the app almost certainly DID redirect, but the request auto-followed it and landed on the redirect target's own response instead. The test's own request is missing `maxRedirects: 0` (or an equivalent no-follow option), not an app defect.",
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
        // F-20: was 0.55 (same as flaky) — deliberately lowered so a bare
        // timeout reliably lands in orchestrator/index.ts's AI-escalation
        // candidate pool (aiCandidates sorts ascending by confidence, takes
        // the lowest TRIAGE_AI_LIMIT). classifyByRules() only ever sees ONE
        // failure at a time and has no way to notice that a bare timeout is
        // actually a downstream symptom of a DIFFERENT, already-diagnosed
        // app_is_wrong failure in the same run (e.g. a broken form submit
        // that hangs every subsequent waitForURL) — only a human-quality AI
        // pass (which receives full run context) has a real chance of
        // catching that correlation, so this confidence must be low enough
        // to reliably win a slot over higher-confidence rivals rather than
        // being silently left on this generic "environment" label.
        0.4,
        'A timeout fired with no selector or assertion context — most likely the app or environment was slow to respond, though this can also be a downstream symptom of a different, already-broken interaction earlier in the same test (e.g. a hung page after a broken form submit) rather than genuine infrastructure slowness.',
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
