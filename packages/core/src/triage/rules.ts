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
//
// "Tier B auth setup failed" is execute.ts's own AUTH_SETUP_FAILURE_MARKER, stamped on the
// auth-setup row where that row's identity is known STRUCTURALLY (see isAuthSetup). It's what
// catches the residual case the fixture's own messages can't: a bare
// "Test timeout of 60000ms exceeded." carries no auth signal at all, so it landed on
// RE_TIMEOUT as `environment` @0.55 — "a timeout fired with no selector or assertion context"
// — burying the real cause of an entire blocked Tier B. Deliberately a marker Healix writes
// rather than a pattern over Playwright's text: Playwright embeds the failing source snippet
// in its errors, so matching auth-ish words would resurrect the defect-leakage bug that
// AuthSignals in execute.ts exists to prevent.
const RE_BLOCKED_TIERB =
  /Tier B prerequisite not met|Tier B ran without credentials|Tier B auth setup skipped|Tier B auth setup failed|submit button never became enabled/;

// Missing local dependency (a Playwright browser binary never downloaded, or
// a Node package never installed) — a Healix/CI environment setup gap, not a
// defect in the app or the test. Must run before the generic environment rule
// (and before selector/assertion) since "Executable doesn't exist" carries no
// navigation/connection signal of its own and would otherwise fall through to
// the low-confidence ambiguous default.
const RE_MISSING_DEPENDENCY =
  /(Executable doesn't exist|browserType\.launch:|please run the following command to download new browsers|npx playwright install|pnpm (?:exec )?playwright install|yarn playwright install|Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)/i;

// A Node-side JavaScript runtime error thrown by the GENERATED TEST SCRIPT
// itself (not a DOM/browser-side symptom like a stale selector or a slow
// assertion) — a hallucinated/wrong Playwright API call, an undeclared
// reference, or an unguarded null/undefined access in the test's own code.
// Distinct from every other rule here in that it's never a signal ABOUT the
// app under test at all; it's the test script failing to even run correctly.
// Previously uncovered by any rule, so these fell through to the generic
// low-confidence ambiguous default despite being about as unambiguous as a
// failure signature gets. Must run before the generic assertion/selector/
// timeout rules since none of those phrases are expected to co-occur here,
// but ordering wouldn't matter much either way — this is a narrow, specific
// signature with essentially no overlap risk.
const RE_CODEGEN_DEFECT =
  /(is not a function\b|is not a constructor\b|ReferenceError:|is not defined\b|Cannot read propert(?:y|ies) of (?:null|undefined))/i;

// input.apiEvidence markers (see ExecOutcome.apiEvidence / execute.ts's
// readApiEvidence): which side actually answered this test's own `request`-
// fixture call(s) — Healix's mock, or the real backend — and, for the real
// backend, whether it came back with a 4xx/5xx. Real, captured evidence
// rather than something inferred from the failing assertion's own text, so
// rules keyed on these run BEFORE the generic assertion/status rules below —
// they're corroborated, not guessed.
const RE_MOCK_ANSWERED = /\[HEALIX MOCK\]/;
const RE_REAL_ERROR_STATUS = /\[REAL BACKEND\][^\n]*-> status ([45]\d{2})\b/;

// A test's own `page.goto('...')` call targets, read back out of specSource —
// used to compare against the project's baseUrl navigation convention (see
// suite_url_convention_mismatch below).
const RE_GOTO_CALL = /page\.goto\(\s*['"`]([^'"`]+)['"`]/g;

/** The hash-router path portion of a URL (everything between '#' and the first '?', if any), trailing slashes trimmed. Null when there's no '#' at all. */
function extractHashPath(url: string): string | null {
  const m = /#(\/[^?]*)/.exec(url);
  if (!m) return null;
  const trimmed = m[1].replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function hashPathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

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

// A generic expect(received).toBe/toEqual(expected) mismatch where BOTH sides
// look like a plausible HTTP status code (100-599) — the signature of an
// API-level status assertion (e.g. expect(response.status()).toBe(200))
// receiving a different code than expected, distinct from a DOM content/count
// check. The literal "expect(received).toBe/toEqual(expected)" prefix is what
// naturally excludes toHaveCount/toHaveValue mismatches (those use a
// different matcher name in that same position, e.g.
// "expect(locator).toHaveCount(expected)"), so no separate exclusion regex is
// needed. Must run AFTER redirect_not_followed (below) so a genuine
// 3xx-expected/200-received case is still claimed by that more specific,
// higher-confidence rule first — this one is the catch-all for every OTHER
// status mismatch (a 500 where 200 was expected, a 404, a 401, ...).
const RE_STATUS_CODE_ASSERTION =
  /expect\(received\)\.(?:toBe|toEqual)\(expected\)[\s\S]{0,80}?Expected:?\s*"?[1-5]\d{2}"?\b[\s\S]{0,80}?Received:?\s*"?[1-5]\d{2}"?\b/i;

// Signals that an error is fundamentally an assertion failure, even though it
// may also mention a locator (Playwright includes "waiting for locator" /
// getBy* text inside expect() timeout output). When any of these are present we
// suppress the selector rule so the assertion rule can claim the verdict.
const RE_ASSERTION_CONTEXT =
  /(expect\(|Expected:|Received:|Expected (?:string|substring|value|pattern)|Received string|toHaveText|toContainText|toBeVisible|toHaveURL|toHaveValue|toHaveCount|toHaveTitle|toMatchSnapshot)/i;

function mk(verdict: Verdict, confidence: number, rationale: string): TriageResult {
  return { verdict, confidence, rationale, verdictSource: 'rule_fallback' };
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
 *  3. codegen_defect — the generated TEST SCRIPT itself threw a Node-side
 *     runtime error (hallucinated API call, undeclared reference, unguarded
 *     null access) — not a signal about the app at all. Runs early since
 *     these phrases don't overlap with any other rule's signals.
 *  4. mock_response_incomplete — the test's own captured apiEvidence (see
 *     ExecOutcome.apiEvidence) shows Healix's OWN mock answered its API
 *     call(s), combined with a generic assertion-mismatch signature — real,
 *     captured corroboration (not a guess) that this run's mock config is
 *     what's incomplete, not the app. Must run before the generic
 *     assertion/status rules so this corroborated signal isn't swallowed by
 *     their uncorroborated, lower-confidence verdicts.
 *  5. real_api_error_evidence — apiEvidence shows the REAL backend answered
 *     with a captured 4xx/5xx, combined with the same assertion signature —
 *     concrete, observed proof of a server error, not an inference. Same
 *     ordering rationale as #4.
 *  6. suite_url_convention_mismatch — the failing test's OWN page.goto(...)
 *     target (read back from specSource) has a hash path shallower than the
 *     project's baseUrl requires (e.g. baseUrl has "#/SK/home" but the test
 *     visits bare "#/?token=..."), while the failure itself looks like
 *     "content/route never appeared". Real, checkable evidence — a hash that
 *     doesn't match a real route means the app may never even run its own
 *     bootstrap logic for that visit — so this is treated as a suite/codegen
 *     URL-construction defect rather than an app regression. Must run before
 *     the generic environment/assertion/selector rules below so this more
 *     specific, corroborated signal isn't swallowed by their generic,
 *     uncorroborated verdicts.
 *  7. environment   — a down server makes every selector lookup "fail", so it
 *     must pre-empt the selector rule.
 *  8. redirect_not_followed — expected a 3xx, observed the followed
 *     redirect's terminal 200 → the test's own request is missing
 *     `maxRedirects: 0`. Runs BEFORE the generic assertion rule so this
 *     specific, high-confidence test_is_wrong signal isn't swallowed by the
 *     lower-confidence default-ambiguous/app_is_wrong assertion bucket
 *     first (first-match wins).
 *  9. status_code_assertion — a plain toBe/toEqual mismatch where both sides
 *     look like an HTTP status code (any OTHER status mismatch besides the
 *     3xx-vs-200 case redirect_not_followed already claimed above) — leans
 *     app_is_wrong, since the app returned a status the test didn't expect.
 * 10. assertion     — expect() mismatch; content checks lean app_is_wrong,
 *     everything else is genuinely ambiguous. Runs BEFORE the selector rule
 *     because Playwright assertion-timeout output embeds locator phrases
 *     ("waiting for locator", getBy*) that would otherwise be misclassified as
 *     test_is_wrong.
 * 11. selector      — locator not found / strict-mode → the test is wrong.
 *     Suppressed when assertion signals (expect(), Expected/Received,
 *     toHaveText/toBeVisible …) are present.
 * 12. flaky         — visibility/detached/instability.
 * 13. timeout       — residual bare timeouts → environment/slowness.
 */
// Runs FIRST on a "blocked" test's error text — before it even asks "did the
// setup fixture fail, or were credentials missing" — because execute.ts's own
// checkpointEntriesToOutcome/findAuthSetupOutcome ALREADY appends the
// auth-setup fixture's own raw error (auth.setupError) after the generic
// "Tier B prerequisite not met" line. That real reason is sitting right there
// in the error text; a rule that ignores it and always presents "either X or
// Y" as equally likely is strictly less precise than the evidence it already
// has. Checked in the same specificity order the top-level rule chain itself
// uses (missing dependency, then generic environment), so a downstream
// blocked row's rationale matches what the auth-setup row's OWN triage entry
// already says instead of hedging between possibilities it could resolve.
function describeBlockedTierbCause(error: string): string {
  if (/no test credentials configured|Tier B ran without credentials/i.test(error)) {
    return 'the project has no test credentials configured, so the session ran anonymously';
  }
  if (RE_MISSING_DEPENDENCY.test(error)) {
    return "the auth setup fixture itself failed because a required local dependency (a Playwright browser binary, or a Node package) was missing in this execution environment — not a credentials gap";
  }
  if (RE_ENVIRONMENT.test(error)) {
    return 'the auth setup fixture itself failed because the app/server was unreachable (connection refused, DNS failure, or a navigation timeout) — not a credentials gap';
  }
  return 'either the auth setup fixture itself failed, or the project has no test credentials configured, so the session ran anonymously';
}

const RULES: readonly Rule[] = [
  {
    id: 'blocked_tierb_prerequisite',
    match(error) {
      if (!RE_BLOCKED_TIERB.test(error)) return null;
      return mk(
        'environment',
        0.9,
        `This test was BLOCKED, not failed: a Tier-B auth prerequisite was not met — ${describeBlockedTierbCause(error)}. Neither the app nor the test is defective.`,
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
    id: 'codegen_defect',
    match(error) {
      if (!RE_CODEGEN_DEFECT.test(error)) return null;
      return mk(
        'test_is_wrong',
        0.8,
        "The generated test script itself threw a runtime error (a nonexistent/mistyped API call, an undeclared reference, or an unguarded null/undefined access) — this is a defect in the test's own code, not a signal about the app under test.",
      );
    },
  },
  {
    id: 'mock_response_incomplete',
    match(error, _title, input) {
      // Requires BOTH signals: apiEvidence alone doesn't prove the FAILING
      // assertion was even about that call, and a generic assertion mismatch
      // alone is the pre-existing (lower-confidence) case below. Together,
      // they're real corroboration — the test's own captured evidence shows
      // Healix's mock (not the real backend) answered, so a missing/wrong
      // field is this run's mock configuration, not an app defect.
      if (!RE_ASSERTION.test(error)) return null;
      if (typeof input.apiEvidence !== 'string' || !RE_MOCK_ANSWERED.test(input.apiEvidence)) return null;
      return mk(
        'environment',
        0.65,
        "The captured evidence shows this test's own API call was answered by Healix's mock, not the real backend — the mocked response for this dependency is missing or doesn't include what this assertion needed. This is a gap in the run's mock configuration, not a defect in the app itself.",
      );
    },
  },
  {
    id: 'real_api_error_evidence',
    match(error, _title, input) {
      if (!RE_ASSERTION.test(error)) return null;
      if (typeof input.apiEvidence !== 'string') return null;
      const m = RE_REAL_ERROR_STATUS.exec(input.apiEvidence);
      if (!m) return null;
      return mk(
        'app_is_wrong',
        0.8,
        `The captured evidence shows the REAL backend answered this test's own API call with a ${m[1]} status — a concrete, observed server-side error, not an inference from the assertion text alone.`,
      );
    },
  },
  {
    id: 'suite_url_convention_mismatch',
    match(error, _title, input) {
      // Only worth checking when the failure itself looks like "content/route
      // never appeared" (an assertion or unresolved-selector symptom) — not a
      // connection/navigation-level failure, which environment_unreachable
      // below already owns.
      if (!RE_ASSERTION_CONTEXT.test(error) && !RE_SELECTOR_NOT_FOUND.test(error)) return null;
      if (typeof input.baseUrl !== 'string' || typeof input.specSource !== 'string') return null;

      const basePath = extractHashPath(input.baseUrl);
      // Nothing to compare against unless the app's own baseUrl itself
      // requires a real path beyond the hash root (e.g. a locale/route
      // segment like "/SK/home") — a bare "#/" baseUrl has no convention a
      // test could omit.
      if (!basePath || hashPathDepth(basePath) < 2) return null;

      const gotoUrls = [...input.specSource.matchAll(RE_GOTO_CALL)].map((m) => m[1]);
      // Only goto calls that both use the hash router AND carry query params
      // are relevant — those are the ones a bootstrap/deep-link test uses to
      // pass token/mobile/lang/route-style params, and where a missing path
      // segment silently sends the app to a URL its router won't recognize.
      const withParams = gotoUrls.filter((u) => u.includes('#') && u.includes('?'));
      if (withParams.length === 0) return null;

      const shallow = withParams.find((u) => {
        const p = extractHashPath(u);
        return p !== null && hashPathDepth(p) < hashPathDepth(basePath);
      });
      if (!shallow) return null;

      return mk(
        'test_is_wrong',
        0.6,
        `This test navigates via page.goto('${shallow}'), whose hash path omits the route/locale segment(s) the app's own base URL requires (baseUrl "${input.baseUrl}" has hash path "${basePath}"). A hash that doesn't match a real route very plausibly means the app never even runs its param-bootstrap logic for this visit — the "params ignored"/"content never appeared" symptom this test observed is consistent with a suite/codegen URL-construction defect (the generated test omitted a required path segment), not necessarily an app regression. Recommended fix: rebuild this test's goto target to match the working convention used elsewhere in this suite (e.g. "#${basePath}?token=...") before concluding the app itself is broken.`,
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
    id: 'status_code_assertion',
    match(error) {
      if (!RE_STATUS_CODE_ASSERTION.test(error)) return null;
      return mk(
        'app_is_wrong',
        0.6,
        'The test asserted a specific HTTP status code and received a different one — the API/app responded with an unexpected status, which is normally a real defect rather than a stale test expectation. (If the test itself is hitting the wrong endpoint or method, this may instead be a test defect — review the request setup.)',
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
        // timeout is escalated to AI review EARLY (orchestrator/index.ts's
        // aiCandidates sorts ascending by confidence, so a low score here
        // means this gets reviewed before higher-confidence rivals if a run
        // is ever cancelled or budget-limited mid-triage — every failure is
        // eventually escalated regardless, but order still matters for a
        // partial run). classifyByRules() only ever sees ONE
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
