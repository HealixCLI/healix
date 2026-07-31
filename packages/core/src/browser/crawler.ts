import { attemptLogin, attemptLoginViaToggle } from './login.js';
import type { BrowserSurface, CapturedNetworkEvent, DomSnapshot, InteractiveElement } from './types.js';

export interface CrawledRoute {
  url: string;
  title: string;
  snapshot: DomSnapshot;
  /** BFS distance from the seed URL(s); 0 for the entry route(s). */
  depth: number;
  /**
   * Set only for a state revealed by `probeThinRouteState` (a modal/panel/wizard step that
   * opened without changing `url`) — the parent URL plus an ordered chain of click selectors
   * used to reach it (e.g. `"https://x/#/dashboard>>[data-testid=wallet-tab]"`). Absent for a
   * normal top-level route, whose identity is its `url` alone. Exists because the crawl's only
   * prior notion of "state" was the URL — a same-URL modal/tab had nowhere to be recorded once
   * discovered, so it was always discarded after a single probing click (see GAP-056).
   */
  stateKey?: string;
  hasPasswordField: boolean;
  /** Whether this route was reached before or after a verified login. */
  role: 'anonymous' | 'authenticated';
  /** A same-page click selector discovered during click-probing that reveals a
   * login-shaped view (password + username field) without changing the URL —
   * set only when the reveal happened on this route. Used by
   * `attemptLoginViaToggle` to reproduce this state without relying on
   * client-side toggle state surviving a fresh navigation. */
  loginToggleSelector?: string;
  /** XHR/fetch traffic observed while this route settled (goto + snapshot). Not
   * perfectly attributed — a slow response from this route can land during the
   * next route's drain window — but sufficient as endpoint/status/body ground
   * truth (see GAP-046, `browser/network-capture.ts`). */
  networkEvents: CapturedNetworkEvent[];
  /** True when this route's own snapshot (title/axTree) reads as an unhandled
   * app-side crash (e.g. React Router's default ErrorBoundary) rather than a
   * genuinely sparse page — see `looksCrashed()`. A real, non-Healix app bug;
   * never a triage verdict, just a signal so a crashed route can be
   * distinguished from one that's just thin. Optional so existing hand-built
   * fixtures (tests) default to "not crashed" rather than requiring the field. */
  crashed?: boolean;
  /** Diagnostic-only provenance: the region/locale code (or other seed label) this route was
   * reached through, when it came from a derived/config-driven seed rather than ordinary link
   * discovery from the primary crawl — see `browser/seed-discovery.ts`. Never used for
   * identity/dedup, which stays keyed by `url`/`stateKey` as always. */
  seedLabel?: string;
  /** Click candidates on this route that survived the safety filter but were never actually
   * attempted (budget ran out first) — see `ClickDiscoveryResult.unattemptedClickCandidates`.
   * Primary source for a gap-fill pass's "unclicked-affordance" gaps. */
  unattemptedClickCandidates?: {
    selector: string;
    name: string;
    selectorTier?: 1 | 2 | 3 | 4;
    repeatedRowText?: string;
  }[];
}

export interface CrawlResult {
  routes: CrawledRoute[];
  visitedCount: number;
  /** True when the route/wall-clock budget was hit before the queue drained. */
  budgetExhausted: boolean;
  /**
   * How many discovered-but-never-visited routes were still queued when the crawl stopped.
   * `budgetExhausted` alone can't distinguish "ran out of time with nothing left to do"
   * (harmless) from "ran out of time holding routes we already knew about" — the latter
   * silently truncates the inventory GENERATE grounds against, and produced a real run whose
   * every Tier B spec shipped as `test.fixme` with no signal that discovery had been cut
   * short. Callers surface this as a warning; see explore.ts.
   *
   * Optional (rather than a required number matching the other counters) purely so every
   * pre-existing CrawlResult literal across the codebase/tests doesn't need a mechanical
   * touch just to keep compiling — the same tradeoff, for the same reason, as
   * `ExecOutcome.skipped` in modes/types.ts. Always populated by `crawl()`; treat an absent
   * value as 0.
   */
  unvisitedQueuedCount?: number;
  /** Human-readable `a <-> b` pairs for detected two-node redirect ping-pongs. */
  redirectLoopsDetected: string[];
  /** True when most visited routes render near-identical DOM (a single-shell SPA). */
  shellCollapsed: boolean;
  /** Requested URLs whose resolution was skipped as a runaway/degenerate redirect — see isDegenerateUrl. Likely an app-side routing defect, not a Healix bug; never a confirmed triage verdict. */
  degenerateRedirectsSkipped: string[];
  /**
   * How many times click-probing gave up on a route because the page couldn't be reliably reset
   * after a click even after a forced reload — see `resetAfterProbe` and
   * docs/click-probe-reset-corruption.md. Distinct from `budgetExhausted`/`unvisitedQueuedCount`:
   * this means candidates were left unattempted because the page was stuck, not because time ran
   * out. Callers surface this as a warning; see explore.ts.
   *
   * Optional for the same reason as `unvisitedQueuedCount` above — avoids a mechanical touch to
   * every pre-existing `CrawlResult` literal. Always populated by `crawl()`; treat an absent value
   * as 0.
   */
  resetFailures?: number;
}

/**
 * Combine two `CrawlResult`s from independent `crawl()` calls into one. Every caller that
 * stitches together a second pass (auth re-crawl, static-analysis-seeded follow-up, region-seed
 * fan-out, gap-fill) needs the exact same field-by-field union — extracted once so a third/fourth
 * caller doesn't hand-write it again and risk missing a field the others already account for.
 *
 * `roleOverride`, when given, is stamped onto every route in `addition` before merging (e.g. the
 * post-login re-crawl's routes are all `'authenticated'` regardless of what `crawl()` itself set).
 */
export function mergeCrawlResults(
  base: CrawlResult,
  addition: CrawlResult,
  roleOverride?: CrawledRoute['role'],
): CrawlResult {
  const additionRoutes = roleOverride
    ? addition.routes.map((r) => ({ ...r, role: roleOverride }))
    : addition.routes;
  return {
    routes: [...base.routes, ...additionRoutes],
    visitedCount: base.visitedCount + additionRoutes.length,
    budgetExhausted: base.budgetExhausted || addition.budgetExhausted,
    unvisitedQueuedCount: (base.unvisitedQueuedCount ?? 0) + (addition.unvisitedQueuedCount ?? 0),
    redirectLoopsDetected: [...base.redirectLoopsDetected, ...addition.redirectLoopsDetected],
    shellCollapsed: base.shellCollapsed || addition.shellCollapsed,
    degenerateRedirectsSkipped: [...base.degenerateRedirectsSkipped, ...addition.degenerateRedirectsSkipped],
    resetFailures: (base.resetFailures ?? 0) + (addition.resetFailures ?? 0),
  };
}

export interface CrawlOptions {
  /** Hard cap on distinct routes visited. Default 60. */
  maxRoutes?: number;
  /** Wall-clock budget for the whole crawl. Default 120s. */
  wallClockBudgetMs?: number;
  /** Extra URLs to seed the BFS queue alongside `baseUrl` (e.g. known routes from static analysis). */
  seedRoutes?: string[];
  /** Overrides MAX_STATE_PROBES_PER_CRAWL for this call only. Defaults to it when unset, a no-op
   * for every existing caller. Lets `crawlWithAuth` give its anonymous and authenticated passes
   * different-sized deep-probe pools — each `crawl()` call already gets its own independent
   * budget (see GAP-060), so this is purely an allocation knob between the two calls, not a
   * change to how a single call spends its own budget. */
  stateProbeBudget?: number;
}

const DEFAULT_MAX_ROUTES = 60;
// Click-probing now also tries GAP-053's non-semantic `generic` candidates (see
// extractClickCandidates below), so a click-probe-heavy page costs noticeably more
// real navigations than before this budget was last tuned — raised alongside
// MAX_CLICKS_PER_PAGE/MAX_CLICK_PROBES_PER_CRAWL so the larger candidate pool has
// room to actually run instead of hitting budgetExhausted mid-page.
const DEFAULT_BUDGET_MS = 240_000;
/** Once a DOM fingerprint has repeated this many times, stop following that page's links. */
const SHELL_REPEAT_THRESHOLD = 3;
/** Share of visited routes sharing the dominant fingerprint that counts as "collapsed". */
const SHELL_COLLAPSE_RATIO = 0.8;

interface QueueItem {
  url: string;
  depth: number;
}

/**
 * Push `item` onto the BFS queue, but jump a login-looking URL ahead of every non-login
 * URL already waiting.
 *
 * The login route is the single highest-value route in the whole crawl: it's what
 * `scoreLoginCandidates` ranks, what `crawlWithAuth` logs in through, and therefore the
 * gate on the ENTIRE authenticated half of the inventory. Plain FIFO order gives it no
 * such standing — a real run discovered `#/SK/login` from the home page's sign-in button,
 * queued it behind `#/SK/register`, and then spent the whole wall-clock budget
 * click-probing the register page's date-picker, so login was never dequeued at all. Every
 * Tier B spec was then generated ungrounded (`test.fixme`) for want of one route that had
 * been sitting in the queue the entire time.
 *
 * Deliberately a reordering, not a budget change: it costs nothing, and unlike a bigger
 * budget it doesn't merely make the starvation less likely — the login route can no longer
 * be behind anything that could starve it. Relative order WITHIN each class is preserved
 * (login URLs stay FIFO among themselves, as do the rest), so this is BFS with one
 * priority tier rather than a different traversal.
 */
function enqueue(queue: QueueItem[], item: QueueItem): void {
  if (!LOGIN_URL_HINT_RE.test(item.url)) {
    queue.push(item);
    return;
  }
  const firstOrdinary = queue.findIndex((q) => !LOGIN_URL_HINT_RE.test(q.url));
  if (firstOrdinary === -1) queue.push(item);
  else queue.splice(firstOrdinary, 0, item);
}

/** Strip a trailing slash from the path (but keep a bare "/") while preserving hash/query. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function sameOrigin(url: string, originUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(originUrl).origin;
  } catch {
    return false;
  }
}

/** Same-origin `href` targets a crawler can follow, resolved against the page it was found on. */
function extractLinks(snapshot: DomSnapshot, origin: string): string[] {
  const out: string[] = [];
  for (const el of snapshot.interactiveElements) {
    if (el.role !== 'link' || !el.href) continue;
    if (/^(mailto:|tel:|javascript:)/i.test(el.href)) continue;
    // A bare "#" (a common no-op brand-link/dropdown-toggle pattern) never
    // navigates anywhere — resolving it against the current page URL produces
    // a distinct-looking string (e.g. "http://x/#") that isn't a real route,
    // duplicating the current page under a phantom URL (see GAP-054). Checked
    // against the RAW attribute, not the resolved URL, so a genuine hash-route
    // like "#/login" (content after the "#") is untouched.
    if (/^#\s*$/.test(el.href)) continue;
    let resolved: string;
    try {
      resolved = new URL(el.href, snapshot.url).toString();
    } catch {
      continue;
    }
    if (!sameOrigin(resolved, origin)) continue;
    out.push(resolved);
  }
  return out;
}

/**
 * Elements a click-probe may safely try: a real `<button>` (or a non-anchor
 * `role="link"` element, e.g. a `<span role="link">` that extractLinks() can't
 * see), visible, enabled, not a submit control, and whose accessible name
 * doesn't read as a destructive/mutating action. A non-submit button *inside*
 * a `<form>` is still allowed — it can't submit/mutate the form's data (that's
 * `buttonType === 'submit'`'s job, already excluded below), so it's no riskier
 * than any other click-probe candidate. This matters in practice: some SPAs
 * put their register<->login view toggle inside the register `<form>` (e.g. a
 * "Log in instead" button), and excluding all in-form buttons meant the
 * crawler could discover the register route but never the login route behind
 * that toggle — every login attempt then wrongly filled in the registration
 * form. This is what makes it safe to click things on a real, possibly-
 * production app unattended. Deliberately does NOT include "register"/"sign
 * up" — navigating TO a registration/signup page is a safe, non-mutating
 * click on its own (the actual account-creation mutation is a `buttonType
 * === 'submit'` click, already excluded above); blocking the nav click by
 * name too would hide a real route on any SPA whose primary "Register" entry
 * point happens to be a `<button onClick>` rather than a real `<a href>`.
 *
 * The list carries LOCALIZED terms alongside the English ones, because an
 * English-only list is not a safety filter on a localized app — it just
 * silently stops filtering. Observed live on a Slovak app: "Odhlásiť sa" (log
 * out) was the FIRST click candidate on the authenticated dashboard, so the
 * crawl's own opening click destroyed the session it had just established, and
 * every later candidate on that page — including the profile-edit triggers this
 * pass exists to find — then fired against a logged-out page and revealed
 * nothing. One row further down sat "odstrániť" (delete account), outside the
 * per-page click slice by nothing more than luck of DOM order. Same
 * locale-awareness the login matchers already have (see `LOGIN_TEXT_RE` and
 * quality-audit.ts's `SUBMIT_CLICK_RE`). Only Slovak is covered because that is
 * what has actually been observed; this stays a known gap for other locales
 * rather than a pretence of full i18n.
 *
 * Note "zmeniť" (change/edit) is deliberately NOT here: it reveals an edit form
 * rather than mutating anything, and the form's own submit is already excluded
 * by `buttonType === 'submit'`. Blocking it would re-hide exactly the states
 * GAP-060's reveal detection was added to capture.
 */
export const UNSAFE_CLICK_TEXT_RE =
  /delete|remove|logout|log out|sign out|submit|save|create|update|checkout|pay|purchase|add to cart|clear|cancel|odhl[aá]si|odstr[aá]ni|vymaza|zru[sš]i|ulo[zž]i|potvrdi|zaplati/i;
/** A logo/brand element's accessible name — clicking one is almost always a "go home"
 * navigation affordance, not a real feature, so it's low value to click-probe on its own.
 * Worse, observed live (C&A app) to actively corrupt exploration: clicking it inside a
 * deep-probed reveal resets the whole SPA view rather than undoing just that one click, which
 * `resetAfterProbe` correctly detects as an unrecoverable mismatch and gives up on — discarding
 * whatever real candidates were left in that reveal (see docs/click-probe-reset-corruption.md).
 * Filtering it out here avoids ever paying that cost. Distinct from `UNSAFE_CLICK_TEXT_RE`
 * above, which is about destructive/mutating actions, not low-value navigation chrome. */
const LOGO_CLICK_TEXT_RE = /\blogo\b/i;
/** An accessible name that reads as a login/sign-in action — used both to score crawled login
 * candidates (see `scoreLoginCandidates`) and, during click-probing, to recognize a same-URL
 * toggle that reveals a login view (see `discoverClickRoutes`). */
export const LOGIN_TEXT_RE = /log[- ]?in|sign[- ]?in|prihl[aá]si/i;
/** Matches a URL that reads as a login page — checked before the signup/register hint so a
 * route matching both (unlikely, but possible on an odd path) is still treated as login.
 * Also drives `enqueue`'s discovery priority below, not just candidate ranking. */
export const LOGIN_URL_HINT_RE = /\blogin\b|\bsign-?in\b/i;
/** Matches a URL that reads as registration — many apps expose a password field on both a
 * signup and a login page, so a route hinting at signup is a weaker login candidate than one
 * with no hint either way. Also matches a submit control's own identifier (a
 * `register-submit` testid), which login.ts uses to refuse to submit a signup form. */
export const SIGNUP_URL_HINT_RE = /\bregister\b|\bsign-?up\b/i;
/** Cap on click candidates considered per page, before the per-visit MAX_CLICKS_PER_PAGE slice. */
const CLICK_CANDIDATES_PER_PAGE = 8;
/**
 * Click-probe candidates actually clicked on a single page in one visit — equal to
 * CLICK_CANDIDATES_PER_PAGE so nothing that survived extractClickCandidates()'s filtering is
 * silently dropped here. Previously 4: on a page with several real buttons ahead of it in
 * document order, that cap could exhaust before reaching the one non-semantic (GAP-053)
 * candidate actually worth discovering (confirmed live — C&A's "Môj účet" nav item was
 * candidate #5 on its page and never got clicked at the old cap of 4).
 */
const MAX_CLICKS_PER_PAGE = 8;
/**
 * Total click-probe budget across a whole crawl() call — a fallback for link-following, not
 * the primary discovery mechanism, so still bounded, just no longer tightly enough to starve
 * every page after the first two or three now that MAX_CLICKS_PER_PAGE is 8 (was 20, which
 * exhausted after ~2-3 pages regardless of how many more remained in the crawl).
 */
const MAX_CLICK_PROBES_PER_CRAWL = 60;
/**
 * Only click-probe a page once the link-following queue is running low — following a real
 * link is cheaper and safer than guessing at a click target. Loosened from 3: a page with a
 * modest handful of real links (e.g. footer FAQ/terms/privacy links) could keep the queue
 * non-thin and skip click-probing entirely, even though the page's non-semantic (GAP-053) nav
 * elements are exactly the ones link-following can never find on its own.
 */
const LINK_QUEUE_THIN_THRESHOLD = 5;

/** How many levels deep a single revealed state (modal -> tab-inside-modal -> ...) may be chased. */
const MAX_STATE_DEPTH = 2;
/**
 * Total deep-probe CLICKS across a whole crawl() call — a separate pool from
 * MAX_CLICK_PROBES_PER_CRAWL so multi-step-flow probing (click + fill + recurse, materially
 * pricier than a single discovery click) never cannibalizes ordinary route-discovery budget.
 *
 * Held at 20 deliberately, and it is NOT enough to reach every route's states on a multi-route
 * authenticated pass — raising it was tried and made things worse. Measured on the real
 * authenticated crawl: /dashboard/vouchers and /dashboard/points each spend 8 on ordinary
 * navigation clicks, leaving /dashboard 4 — one short of its four `zmenit` profile-edit
 * triggers, which a dashboard-only probe confirmed DO record their forms (dob, newemail,
 * currentpswd/password/confirm_password) once clicks actually reach them. But at 45 the extra
 * clicks simply consumed the wall clock instead and /dashboard was never VISITED at all (route
 * coverage 8 -> 7, budgetExhausted false -> true). Charging per recorded state rather than per
 * click regressed it the same way, for the same underlying reason.
 *
 * The real constraint was structural, not a number: interleaving deep-probe with discovery let
 * the FIRST routes visited in a pass spend the whole pool before the pass's own interesting
 * route (often visited last) got a turn. Fixed by deferring deep-probe to a genuine second pass
 * over the routes discovery already collected, probed in reverse visit order so the routes that
 * were structurally starved before now go first — see GAP-060 (Fixed) and `crawl()`'s pass-2
 * loop below.
 */
const MAX_STATE_PROBES_PER_CRAWL = 20;
/** A same-URL click only counts as "revealed a real state" (worth recording/recursing into),
 * not just a small dropdown/menu, when it adds at least this many interactive elements. */
export const STATE_REVEAL_MIN_NEW_ELEMENTS = 5;
/**
 * ...OR when it brings this many previously-absent INPUT fields on screen — see
 * `revealedInputFields`. One is enough: a single input that wasn't there before is a form, and
 * a form is exactly the state worth recording.
 */
export const STATE_REVEAL_MIN_NEW_INPUTS = 1;
/** Input name/id/selector hints that read as a one-time/verification code — never auto-filled,
 * since a real OTP requires a code delivered over an external channel (email/SMS) that a crawl
 * has no way to observe or synthesize. Flows gated behind this remain a `test.fixme()` case by
 * design, not a bug in `fillSafeInputs`. */
const OTP_HINT_RE = /otp|verification.?code|one.?time|\b2fa\b|\bmfa\b/i;

/**
 * A `role: 'generic'` candidate's accessible name longer than this is almost certainly a
 * pointer-styled CONTAINER whose `textContent` swept up a whole panel/card, not a real click
 * target (a genuine non-semantic control is a short label — "Zmeniť heslo", "Export", "Môj účet").
 * GAP-057 widened generic-candidate discovery from a fixed tag allowlist to any tag (pruned by a
 * structural denylist + the `cursor:pointer` gate), which can surface more such containers; this
 * keeps them from crowding real candidates out of the fixed `CLICK_CANDIDATES_PER_PAGE` slice
 * below, without needing to raise the slice size itself (see the budget note at the top of this
 * file — that budget was already retuned once for GAP-053 and shouldn't be spent twice on
 * speculation). Semantic roles (`button`/`link`) are never subject to this cap — a long button
 * name is still a real button.
 */
const GENERIC_CANDIDATE_NAME_MAX_LENGTH = 60;

function extractClickCandidates(snapshot: DomSnapshot): InteractiveElement[] {
  return (
    snapshot.interactiveElements
      // 'generic' includes GAP-053/GAP-057's non-semantic cursor-pointer click targets —
      // eligible for the same click-probing under the same safety filters below (disabled,
      // non-submit, UNSAFE_CLICK_TEXT_RE).
      .filter((el) => el.role === 'button' || el.role === 'generic' || (el.role === 'link' && !el.href))
      .filter((el) => !el.disabled)
      .filter((el) => el.buttonType !== 'submit')
      .filter((el) => !UNSAFE_CLICK_TEXT_RE.test(el.name))
      .filter((el) => !LOGO_CLICK_TEXT_RE.test(el.name))
      .filter((el) => el.role !== 'generic' || el.name.length <= GENERIC_CANDIDATE_NAME_MAX_LENGTH)
      .slice(0, CLICK_CANDIDATES_PER_PAGE)
  );
}

export interface ClickDiscoveryResult {
  attempted: number;
  discoveredUrls: string[];
  /** Selectors of in-page candidates whose click revealed a login-shaped view
   * (matches LOGIN_TEXT_RE by name, and a password field is present afterward)
   * without navigating — see `discoverClickRoutes`. */
  loginToggleSelectors: string[];
  /** New states revealed and recorded during deep-probing (see `DeepProbeOpts`), each carrying
   * its own `stateKey` — see `CrawledRoute.stateKey`. Empty unless `opts.deepProbe` was set. */
  discoveredStates: CrawledRoute[];
  /** Click candidates that survived the safety filter (extractClickCandidates) but were never
   * actually attempted this page visit — the loop stopped early on budget exhaustion. Surfaced
   * so a later gap-fill pass can specifically target the ones ordinary discovery ran out of time
   * for, rather than a page simply looking (falsely) fully explored. */
  unattemptedClickCandidates: {
    selector: string;
    name: string;
    selectorTier?: 1 | 2 | 3 | 4;
    repeatedRowText?: string;
  }[];
  /** Number of times this call gave up on a page because `resetAfterProbe` couldn't reliably
   * restore it even after a forced reload — distinct from ordinary budget exhaustion. See
   * `CrawlResult.resetFailures`. */
  resetFailures: number;
}

/** Enables the deep-probe behavior in `discoverClickRoutes` — engaged on every route (see
 * GAP-056; NOT gated on the route's own element count), bounded instead by
 * MAX_STATE_PROBES_PER_CRAWL/MAX_STATE_DEPTH and by only ever recording a click that reveals a
 * real state: one that is materially larger (STATE_REVEAL_MIN_NEW_ELEMENTS) or brings new input
 * fields on screen (STATE_REVEAL_MIN_NEW_INPUTS — see `revealedInputFields`). */
interface DeepProbeOpts {
  /** This state's identity so far: the route URL plus every selector clicked to reach it. */
  stateKeyPrefix: string;
  /** How many state-levels deep this call already is (0 for the initial call on a page). */
  depth: number;
  /** The originating route's own BFS depth — carried through unchanged onto any recorded state. */
  parentDepth: number;
  /** Shared, mutable across the whole recursion tree for this page — see MAX_STATE_PROBES_PER_CRAWL. */
  budget: { remaining: number };
  /**
   * Shared across the WHOLE crawl (every route, not just this page's recursion tree) — keyed by
   * the reveal's route-path segment plus its post-reveal fingerprint, so a shared component (a
   * cookie-consent modal, a generic upsell dialog) that reveals identically from many different
   * routes is recognized after STATE_REPEAT_THRESHOLD occurrences instead of being re-descended
   * into on every single route it happens to appear on. Keyed with the route path INCLUDED
   * (not fingerprint alone) so two genuinely different same-shaped modals on different pages
   * (e.g. an "edit email" form and an "edit password" form that happen to render the same
   * element count/roles) are never conflated as the same repeated state.
   */
  stateFingerprints: Map<string, number>;
}

/** Once a deep-probe reveal's (route, post-reveal fingerprint) pair has recurred this many times
 * across the crawl, it's still recorded (the inventory keeps knowing it exists) but no longer
 * recursed into or charged further probe budget — see `DeepProbeOpts.stateFingerprints`. */
const STATE_REPEAT_THRESHOLD = 2;

/** The first hash-route path segment (or the pathname, for a non-hash-routed app) — used as part
 * of a deep-probe state's fingerprint key so identical-shaped reveals on DIFFERENT pages are kept
 * distinct (see `DeepProbeOpts.stateFingerprints`). */
function routePathSegment(url: string): string {
  try {
    const u = new URL(url);
    return u.hash || u.pathname;
  } catch {
    return url;
  }
}

/**
 * Probes a bounded number of same-page click candidates to discover routes a
 * pure `<a href>` scan can't see — common in SPAs that route their primary
 * navigation via button/onClick handlers rather than real anchors (this is
 * why a link-only crawl can stall at a single thin route on such an app; see
 * GAP-042). Never clicks anything disabled, a submit control, or with a name
 * matching UNSAFE_CLICK_TEXT_RE. In-form controls ARE clicked (as long as they
 * aren't the submit): excluding them, as this did until e0fcac6, hid any login
 * view reachable only through a toggle inside the register form — the submit
 * filter is what keeps an in-form click from actually submitting anything.
 * After each click, resets to
 * `originalUrl` (if the click navigated) or presses Escape (if it likely just
 * opened a menu/dropdown in place) before trying the next candidate, so the
 * page is always back in a known state for the caller. A same-URL click whose
 * candidate name reads as login (LOGIN_TEXT_RE) and reveals a password field
 * is additionally recorded as a login-toggle selector: some SPAs flip between
 * their register and login views as client-side state without changing the
 * route, so the route-changed check alone would silently discard that login
 * view (it would fall through to the "menu/dropdown" branch and get
 * Escape-reverted) — leaving every login attempt to wrongly fill in the
 * registration form instead (the exact bug this guards against).
 *
 * When `opts.deepProbe` is set (engaged on every route, see GAP-056), a same-URL click that
 * reveals a REAL STATE — either a materially larger DOM (>= STATE_REVEAL_MIN_NEW_ELEMENTS more
 * interactive elements than a small dropdown/menu) or new input fields regardless of net size
 * (>= STATE_REVEAL_MIN_NEW_INPUTS; see `revealedInputFields` for why a net-growth test alone
 * cannot see an inline-edit view swap) — is instead recorded as its own `CrawledRoute` (keyed by
 * `stateKey`, not `url`,
 * see `CrawledRoute.stateKey`) and, budget/depth permitting, probed one level deeper via a
 * recursive call after a best-effort `fillSafeInputs` pass — the one piece deliberately missing
 * from ordinary route discovery: a wallet/subscription-management modal, or a filter panel, needs
 * a second interaction to reveal its real content, and reverting immediately (the ordinary
 * behavior) never gives it the chance. Bounded by `MAX_STATE_DEPTH`/`MAX_STATE_PROBES_PER_CRAWL`
 * (shared via `opts.deepProbe.budget` across the whole recursion for one page) so this stays a
 * targeted, opt-in cost. OTP entry is deliberately out of scope for `fillSafeInputs` (see
 * OTP_HINT_RE) — a real code requires an external channel no crawl can observe, so those flows
 * correctly remain ungrounded for GENERATE's escape hatch.
 */
/** Shared `.catch()` fallback for both `crawl()` passes' `discoverClickRoutes` calls — a failed
 * click-probe attempt (page navigated away unexpectedly, browser error) should never abort the
 * whole crawl, just contribute nothing this round. */
function emptyClickDiscoveryResult(): ClickDiscoveryResult {
  return {
    attempted: 0,
    discoveredUrls: [],
    loginToggleSelectors: [],
    discoveredStates: [],
    unattemptedClickCandidates: [],
    resetFailures: 0,
  };
}

/**
 * Restore the page to `originalSnapshot`'s state after a click-probe, verifying the reset
 * actually worked instead of trusting it blindly — see docs/click-probe-reset-corruption.md.
 * `pressKey('Escape')` alone doesn't close every modal (custom in-app modals that don't listen
 * for Escape), and `goto(originalUrl)` is a silent no-op for a same-URL hash-routed SPA (Playwright
 * reports a real `Response` even though nothing actually reloaded). Left unrecovered, either
 * failure poisons every click candidate that follows on the same page.
 *
 * Escalates only as far as needed: Escape + a cheap re-snapshot resolves the common real-dropdown
 * case with no extra cost; `goto()` is skipped when we're already sitting on `originalUrl` (a
 * known no-op there) and a genuine `reload()` — the one primitive that can't suffer the same-URL
 * no-op problem — is used instead, but only when the cheaper steps didn't already succeed.
 */
async function resetAfterProbe(
  browser: BrowserSurface,
  originalSnapshot: DomSnapshot,
  originalUrl: string,
): Promise<boolean> {
  await browser.pressKey('Escape').catch(() => undefined);
  let current = await snapshotClean(browser).catch(() => undefined);
  if (current && fingerprintOf(current) === fingerprintOf(originalSnapshot)) return true;

  if (current && normalizeUrl(current.url) !== normalizeUrl(originalUrl)) {
    await browser.goto(originalUrl).catch(() => undefined);
    current = await snapshotClean(browser).catch(() => undefined);
    if (current && fingerprintOf(current) === fingerprintOf(originalSnapshot)) return true;
  }

  await browser.reload().catch(() => undefined);
  current = await snapshotClean(browser).catch(() => undefined);
  return !!current && fingerprintOf(current) === fingerprintOf(originalSnapshot);
}

async function discoverClickRoutes(
  browser: BrowserSurface,
  snapshot: DomSnapshot,
  origin: string,
  maxClicks: number,
  opts: { deepProbe?: DeepProbeOpts } = {},
): Promise<ClickDiscoveryResult> {
  const originalUrl = snapshot.url;
  const beforeCount = snapshot.interactiveElements.length;
  const candidates = extractClickCandidates(snapshot).slice(0, Math.max(0, maxClicks));
  const discoveredUrls: string[] = [];
  const loginToggleSelectors: string[] = [];
  const discoveredStates: CrawledRoute[] = [];
  let attempted = 0;
  let resetFailures = 0;
  const deepProbe = opts.deepProbe;

  for (const candidate of candidates) {
    // Charged per ATTEMPTED click, not per recorded state. That looks like a misnomer next to
    // MAX_STATE_PROBES_PER_CRAWL's name, and charging per state was tried — it starved the
    // crawl of TIME instead: with no per-click ceiling every route spent its full click slice,
    // the authenticated pass blew its wall clock, and route coverage regressed (8 routes ->
    // 7, budgetExhausted false -> true) without recording a single extra state. The per-click
    // charge is doing double duty as a cost throttle, and the fix for the starvation it caused
    // is a bigger pool (see MAX_STATE_PROBES_PER_CRAWL), not a different charging rule.
    if (deepProbe && deepProbe.budget.remaining <= 0) break;
    attempted += 1;
    if (deepProbe) deepProbe.budget.remaining -= 1;
    try {
      await browser.click(candidate.selector);
      const after = await snapshotClean(browser);
      if (normalizeUrl(after.url) !== normalizeUrl(originalUrl)) {
        if (sameOrigin(after.url, origin)) discoveredUrls.push(after.url);
        discoveredUrls.push(...extractLinks(after, origin));
        if (!(await resetAfterProbe(browser, snapshot, originalUrl))) {
          resetFailures += 1;
          break;
        }
      } else if (LOGIN_TEXT_RE.test(candidate.name) && hasPasswordField(after)) {
        loginToggleSelectors.push(candidate.selector);
        if (!(await resetAfterProbe(browser, snapshot, originalUrl))) {
          resetFailures += 1;
          break;
        }
      } else if (
        deepProbe &&
        (after.interactiveElements.length - beforeCount >= STATE_REVEAL_MIN_NEW_ELEMENTS ||
          revealedInputFields(snapshot, after) >= STATE_REVEAL_MIN_NEW_INPUTS)
      ) {
        const stateKey = `${deepProbe.stateKeyPrefix}>>${candidate.selector}`;
        const stateFingerprint = `${routePathSegment(originalUrl)}::${fingerprintOf(after)}`;
        const priorOccurrences = deepProbe.stateFingerprints.get(stateFingerprint) ?? 0;
        deepProbe.stateFingerprints.set(stateFingerprint, priorOccurrences + 1);
        const isRepeatedState = priorOccurrences >= STATE_REPEAT_THRESHOLD;

        discoveredStates.push({
          url: originalUrl,
          stateKey,
          title: after.title,
          snapshot: after,
          depth: deepProbe.parentDepth,
          hasPasswordField: hasPasswordField(after),
          role: 'anonymous',
          networkEvents: [],
          crashed: looksCrashed(after),
        });
        discoveredUrls.push(...extractLinks(after, origin));

        // MAX_STATE_DEPTH counts recorded hops: this candidate's reveal is hop `deepProbe.depth +
        // 1`. Only recurse (look for one more hop past it) while that count still has room —
        // e.g. MAX_STATE_DEPTH=2 records hop1 and hop2, but never explores INSIDE hop2 looking
        // for a hop3, so a hop3 candidate is simply never clicked at all. A reveal recognized as
        // one we've already descended into STATE_REPEAT_THRESHOLD+ times elsewhere in this crawl
        // (see `stateFingerprints`) is skipped here too — it's still recorded above, just not
        // spent budget re-exploring.
        if (!isRepeatedState && deepProbe.depth + 1 < MAX_STATE_DEPTH && deepProbe.budget.remaining > 0) {
          await fillSafeInputs(browser, after).catch(() => 0);
          const settled = await snapshotClean(browser).catch(() => after);
          const nested = await discoverClickRoutes(browser, settled, origin, MAX_CLICKS_PER_PAGE, {
            deepProbe: {
              stateKeyPrefix: stateKey,
              depth: deepProbe.depth + 1,
              parentDepth: deepProbe.parentDepth,
              budget: deepProbe.budget,
              stateFingerprints: deepProbe.stateFingerprints,
            },
          });
          discoveredUrls.push(...nested.discoveredUrls);
          loginToggleSelectors.push(...nested.loginToggleSelectors);
          discoveredStates.push(...nested.discoveredStates);
          resetFailures += nested.resetFailures;
        }

        if (!(await resetAfterProbe(browser, snapshot, originalUrl))) {
          resetFailures += 1;
          break;
        }
      } else {
        // Click likely opened a menu/dropdown in place rather than navigating
        // — collect any newly revealed anchors, then close it.
        discoveredUrls.push(...extractLinks(after, origin));
        if (!(await resetAfterProbe(browser, snapshot, originalUrl))) {
          resetFailures += 1;
          break;
        }
      }
    } catch {
      // Dead click target or click failed — best-effort reset, keep probing the rest.
      if (!(await resetAfterProbe(browser, snapshot, originalUrl))) {
        resetFailures += 1;
        break;
      }
    }
  }

  const unattemptedClickCandidates = candidates.slice(attempted).map((c) => ({
    selector: c.selector,
    name: c.name,
    selectorTier: c.selectorTier,
    repeatedRowText: c.repeatedRowText,
  }));

  return {
    attempted,
    discoveredUrls,
    loginToggleSelectors,
    discoveredStates,
    unattemptedClickCandidates,
    resetFailures,
  };
}

/**
 * Best-effort, safety-scoped fill of visible text-like inputs revealed inside a deep-probed
 * state (a filter form, a wizard step) so a bounded follow-up click can actually advance past
 * it — generalizes `login.ts`'s "fill, don't assert" pattern beyond username/password. Never
 * touches a password or file input, or anything OTP-shaped (see OTP_HINT_RE); a field this skips
 * simply stays empty, which is safe — worst case the next click no-ops on an empty filter rather
 * than mutating anything. Returns the number of fields actually filled.
 */
async function fillSafeInputs(browser: BrowserSurface, snapshot: DomSnapshot): Promise<number> {
  let filled = 0;
  for (const el of snapshot.interactiveElements) {
    if (el.role !== 'textbox' || el.disabled) continue;
    if (el.inputType === 'password' || el.inputType === 'file') continue;
    if (OTP_HINT_RE.test(el.name) || OTP_HINT_RE.test(el.selector)) continue;
    const value =
      el.inputType === 'email'
        ? 'healix-explore@example.com'
        : el.inputType === 'number'
          ? '1'
          : el.inputType === 'tel'
            ? '5555555555'
            : el.inputType === 'date' || el.inputType === 'month' || el.inputType === 'week'
              ? undefined // format varies too much to guess safely without risking a bad value
              : 'healix test';
    if (value === undefined) continue;
    try {
      await browser.type(el.selector, value);
      filled += 1;
    } catch {
      // Dead/unfillable target — skip, keep filling the rest.
    }
  }
  return filled;
}

/** A stable per-route signature used to detect a single-shell SPA (every route looks identical). */
function fingerprintOf(snapshot: DomSnapshot): string {
  return snapshot.interactiveElements
    .map((el) => `${el.role}:${el.selector}`)
    .sort()
    .join('|');
}

/**
 * Minimum size of a group of same-role, same-selector-SHAPE elements before they're collapsed to
 * one representative (see `collapseRepeatedSiblings`). Set above an ordinary small run of same-
 * shaped nav items (2-3 real, distinct controls) so genuine UI survives, while a calendar's ~30
 * day-cells or a table's many rows still collapse.
 */
const REPEATED_GROUP_MIN_SIZE = 4;

/**
 * Strips a positional `nth-of-type` index so e.g. `div:nth-of-type(3) > span` and
 * `div:nth-of-type(9) > span` compare equal — same shape, different index. Selectors that
 * already carry a stable identifier (tier 1-3: data-testid/name/aria-label/id) never contain
 * `nth-of-type` at all, so this only ever merges the already-lowest-confidence tier-4 fallback
 * selectors — a real, individually-identified form field is never at risk of collapsing into
 * a neighbor.
 */
function selectorShape(selector: string): string {
  return selector.replace(/:nth-of-type\(\d+\)/g, ':nth-of-type(*)');
}

/**
 * Collapses runs of near-identical sibling elements (grouped by role + selector shape, ignoring
 * the nth-of-type index) down to one representative plus a `repeatedGroupSize` count. A real run
 * against the C&A app captured a date-picker's 27 day-cells as 27 separate `InteractiveElement`s
 * from a single reveal — pure noise that both bloats the inventory GENERATE grounds against and
 * crowds real click candidates out of `CLICK_CANDIDATES_PER_PAGE`. Applied at snapshot time (see
 * `snapshotClean`) so every downstream consumer — click-candidate extraction, deep-probe reveal
 * sizing, the recorded route itself — sees the collapsed view uniformly, rather than patching
 * each consumer separately.
 *
 * The shape key alone isn't enough: a live run against the same app found the account page's
 * "zmeniť" (change name/DOB/email/password) x4 plus "odstrániť" (delete account) x1 — 5 `generic`
 * `<p>` elements sharing one DOM shape — collapsing into ONE entry named "zmeniť", silently
 * erasing the delete-account trigger rather than deduping it. So within a shape-group that meets
 * the threshold, elements are also split by accessible NAME first: a minority name too small to
 * be "real repetition" on its own (odstrániť x1) is never swallowed by a same-shaped majority.
 * A same-name subgroup that itself meets the threshold (zmeniť x4) is then checked against
 * `repeatedRowText` (the nearest repeated-DOM-ancestor's own text — see selectors.ts) before
 * collapsing: each "zmeniť" trigger sits in its own profile section, so their surrounding row
 * text differs even though their own name doesn't, distinguishing 4 functionally different
 * triggers from a genuinely repeated list (e.g. 50 identically-labeled "Delete" row buttons,
 * whose row text is far more likely to repeat, or not be tier-4/present at all).
 */
function collapseRepeatedSiblings(snapshot: DomSnapshot): DomSnapshot {
  const shapeGroups = new Map<string, InteractiveElement[]>();
  for (const el of snapshot.interactiveElements) {
    const key = `${el.role}:${selectorShape(el.selector)}`;
    const group = shapeGroups.get(key);
    if (group) group.push(el);
    else shapeGroups.set(key, [el]);
  }

  const collapsed: InteractiveElement[] = [];
  for (const shapeGroup of shapeGroups.values()) {
    if (shapeGroup.length < REPEATED_GROUP_MIN_SIZE) {
      collapsed.push(...shapeGroup);
      continue;
    }

    const distinctNames = new Set(shapeGroup.map((el) => el.name));
    if (distinctNames.size >= REPEATED_GROUP_MIN_SIZE) {
      // Mostly/all-unique names sharing one shape (a date-picker's day cells, an enumerated
      // list) — the name carries no distinguishing signal here, collapse as one unit.
      collapsed.push({ ...shapeGroup[0], repeatedGroupSize: shapeGroup.length });
      continue;
    }

    const nameGroups = new Map<string, InteractiveElement[]>();
    for (const el of shapeGroup) {
      const group = nameGroups.get(el.name);
      if (group) group.push(el);
      else nameGroups.set(el.name, [el]);
    }
    for (const nameGroup of nameGroups.values()) {
      if (nameGroup.length < REPEATED_GROUP_MIN_SIZE) {
        collapsed.push(...nameGroup);
        continue;
      }

      const rowTexts = nameGroup.map((el) => el.repeatedRowText);
      const distinctRowTexts = new Set(rowTexts);
      const allDistinct =
        rowTexts.every((text) => text !== undefined) && distinctRowTexts.size === nameGroup.length;
      if (allDistinct) {
        collapsed.push(...nameGroup);
      } else {
        collapsed.push({ ...nameGroup[0], repeatedGroupSize: nameGroup.length });
      }
    }
  }

  return { ...snapshot, interactiveElements: collapsed };
}

/** Every `browser.snapshot()` call site routes through here so repeated-sibling collapse (see
 * `collapseRepeatedSiblings`) applies uniformly, rather than risking a call site that forgets it. */
export async function snapshotClean(browser: BrowserSurface): Promise<DomSnapshot> {
  return collapseRepeatedSiblings(await browser.snapshot());
}

function hasPasswordField(snapshot: DomSnapshot): boolean {
  return snapshot.interactiveElements.some((el) => el.inputType === 'password');
}

function isInputField(el: InteractiveElement): boolean {
  return el.role === 'textbox' || el.inputType !== undefined;
}

/**
 * How many input fields are on screen in `after` that were not there in `before`, compared BY
 * SELECTOR.
 *
 * This exists because `STATE_REVEAL_MIN_NEW_ELEMENTS` measures NET element growth, which is
 * structurally blind to a same-URL view SWAP — and a swap is how real apps implement inline
 * editing. C&A's dashboard drives all four profile-edit flows off one `subpage` state: clicking
 * "zmeniť" REPLACES a list of ~5 edit links with a form of 3 inputs plus a submit, a net change of
 * about MINUS ONE. No value of a net-growth threshold can ever fire on that, so every one of those
 * forms was clicked, judged a dropdown, Escape-reverted and discarded — and 38 generated Tier B
 * specs then shipped as ungrounded `test.fixme` asking for precisely those fields ("the DOB
 * date-picker input revealed by this zmeniť trigger", "the password-change form fields are not in
 * the provided inventory", and so on).
 *
 * Counting inputs is what makes a swap visible: it is insensitive to whatever the swap REMOVED,
 * and "new inputs appeared" is a much truer description of "a form opened" than "the element count
 * went up" ever was. Compared by selector rather than by count for the same reason — a swap that
 * trades three inputs for three DIFFERENT inputs (name form -> DOB form) nets zero on a count and
 * must still register.
 *
 * This does not replace the element-count test, it joins it: a date-picker or a modal that piles
 * new controls on top of an intact form is still caught by the original signal even when it adds
 * no inputs at all (a calendar is buttons).
 */
export function revealedInputFields(before: DomSnapshot, after: DomSnapshot): number {
  const seen = new Set(before.interactiveElements.filter(isInputField).map((el) => el.selector));
  return after.interactiveElements.filter((el) => isInputField(el) && !seen.has(el.selector)).length;
}

/** Recognizable "this route rendered a crash" shapes: a framework error-boundary fallback
 * (React Router's default included), a browser-reported uncaught error, or a raw stack-trace
 * line (`at fn (file:line:col)`) leaking into the accessible tree/title instead of real content. */
const CRASH_MARKER_RE =
  /unexpected application error|error boundary|uncaught (?:runtime )?error|at\s+\S+\s+\([^)]+:\d+:\d+\)/i;

/** `snapshot.axTree` (Playwright's `ariaSnapshot()`) is a YAML string when present — see
 * `browser/index.ts`'s `snapshot()`. Checked alongside the title since a crash fallback page
 * commonly carries a generic/blank title but a distinctive accessible tree (or vice versa). */
export function looksCrashed(snapshot: DomSnapshot): boolean {
  const axText = typeof snapshot.axTree === 'string' ? snapshot.axTree : '';
  return CRASH_MARKER_RE.test(axText) || CRASH_MARKER_RE.test(snapshot.title);
}

const DEGENERATE_URL_MAX_LENGTH = 2000;
/** More than this many identical consecutive path/hash segments is a runaway redirect, not a real route. */
const DEGENERATE_REPEAT_SEGMENT_THRESHOLD = 4;

/**
 * True for a resolved URL that's almost certainly a runaway app-side
 * redirect rather than a real route — observed live against a real
 * hash-routed SPA whose unmatched-route fallback recursively re-appends a
 * segment to itself (e.g. `.../home/home/home/home/...`) when navigated
 * directly to an unrecognized path. `redirectLoopsDetected` only catches an
 * exact two-node A<->B ping-pong; a monotonically-growing chain like this
 * never repeats a prior URL, so it needs its own guard. Recording the
 * eventual (huge) URL as a "discovered route" would be pure garbage.
 */
export function isDegenerateUrl(url: string): boolean {
  if (url.length > DEGENERATE_URL_MAX_LENGTH) return true;
  let resolved: URL;
  try {
    resolved = new URL(url);
  } catch {
    return false;
  }
  const segments = [
    ...resolved.pathname.split('/').filter(Boolean),
    ...resolved.hash.replace(/^#\/?/, '').split('/').filter(Boolean),
  ];
  let runLength = 1;
  for (let i = 1; i < segments.length; i += 1) {
    runLength = segments[i] === segments[i - 1] ? runLength + 1 : 1;
    if (runLength > DEGENERATE_REPEAT_SEGMENT_THRESHOLD) return true;
  }
  return false;
}

/**
 * BFS crawl over same-origin routes reachable from `baseUrl`, replacing the
 * old single `goto`+`snapshot` EXPLORE pass. Bounded by `maxRoutes` and
 * `wallClockBudgetMs` so a large or slow-hash-routed app degrades to a
 * partial-but-real result (`budgetExhausted: true`) instead of hanging or an
 * all-or-nothing timeout. Never throws on a single dead link — that node is
 * skipped and the crawl continues.
 */
export async function crawl(
  browser: BrowserSurface,
  baseUrl: string,
  opts: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxRoutes = opts.maxRoutes ?? DEFAULT_MAX_ROUTES;
  const budgetMs = opts.wallClockBudgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  // baseUrl stays unconditionally first — it's the crawl root, and visiting it first is what
  // seeds link discovery and the route-prefix detection every later URL is reconciled
  // against. Only the seeds (and, below, click/link-discovered URLs) are priority-ordered.
  const queue: QueueItem[] = [{ url: baseUrl, depth: 0 }];
  for (const url of opts.seedRoutes ?? []) {
    enqueue(queue, { url, depth: 0 });
  }
  const queued = new Set<string>(queue.map((q) => normalizeUrl(q.url)));
  const requested = new Set<string>();
  const visitedResolved = new Set<string>();
  // Requested URL -> the URL it redirected to; lets us spot a two-node
  // redirect ping-pong (A -> B, then B -> A) without following it forever.
  const redirectTargetOf = new Map<string, string>();
  const redirectLoopsDetected: string[] = [];
  const degenerateRedirectsSkipped: string[] = [];
  const fingerprintCounts = new Map<string, number>();
  // Crawl-scoped (not per-route) — see DeepProbeOpts.stateFingerprints.
  const stateFingerprints = new Map<string, number>();
  const routes: CrawledRoute[] = [];
  let budgetExhausted = false;
  let remainingClickProbes = MAX_CLICK_PROBES_PER_CRAWL;
  let remainingStateProbes = opts.stateProbeBudget ?? MAX_STATE_PROBES_PER_CRAWL;
  let resetFailures = 0;

  // Discard anything buffered before this crawl started so it doesn't leak into route 0.
  browser.drainNetworkEvents();

  while (queue.length > 0) {
    if (routes.length >= maxRoutes || Date.now() >= deadline) {
      budgetExhausted = true;
      break;
    }
    const item = queue.shift();
    if (!item) break;
    const requestedUrl = normalizeUrl(item.url);
    queued.delete(requestedUrl);
    if (requested.has(requestedUrl)) continue;
    requested.add(requestedUrl);

    let snapshot: DomSnapshot;
    try {
      // Navigate with the URL as queued, NOT its normalized form — normalizeUrl()'s
      // trailing-slash strip is only meant as a dedup key. Navigating to the
      // stripped variant breaks any app hosted under a subpath that requires
      // the exact trailing-slash directory URL (e.g. Vite's `base` config) —
      // see GAP-052.
      await browser.goto(item.url);
      snapshot = await snapshotClean(browser);
    } catch {
      // Dead link or navigation failure — discard whatever traffic that attempt
      // triggered (it can't be attributed to a route we're about to record) and
      // skip this node, keeping the crawl alive.
      browser.drainNetworkEvents();
      continue;
    }
    const networkEvents = browser.drainNetworkEvents();

    const resolvedUrl = normalizeUrl(snapshot.url || requestedUrl);

    if (isDegenerateUrl(resolvedUrl)) {
      // Runaway app-side redirect (e.g. an unmatched-route fallback that
      // recursively appends itself) — skip like a dead link, never record it.
      // Recorded (not just silently dropped) so callers can surface it as a
      // breadcrumb — likely an app-side routing defect, though crawl() has no
      // way to confirm that, so this is never a triage verdict.
      degenerateRedirectsSkipped.push(requestedUrl);
      continue;
    }

    if (resolvedUrl !== requestedUrl) {
      if (redirectTargetOf.get(resolvedUrl) === requestedUrl) {
        redirectLoopsDetected.push(`${requestedUrl} <-> ${resolvedUrl}`);
        continue;
      }
      redirectTargetOf.set(requestedUrl, resolvedUrl);
    }

    if (visitedResolved.has(resolvedUrl)) continue;
    visitedResolved.add(resolvedUrl);

    const fingerprint = fingerprintOf(snapshot);
    const fpCount = (fingerprintCounts.get(fingerprint) ?? 0) + 1;
    fingerprintCounts.set(fingerprint, fpCount);

    routes.push({
      url: resolvedUrl,
      title: snapshot.title,
      snapshot,
      depth: item.depth,
      hasPasswordField: hasPasswordField(snapshot),
      role: 'anonymous',
      networkEvents,
      crashed: looksCrashed(snapshot),
    });

    // A fingerprint that keeps repeating is a shell page rendering nothing
    // new — stop following its links so budget goes toward real routes.
    if (fpCount > SHELL_REPEAT_THRESHOLD) continue;

    for (const link of extractLinks(snapshot, baseUrl)) {
      const norm = normalizeUrl(link);
      if (!requested.has(norm) && !queued.has(norm)) {
        queued.add(norm);
        // Queue the link as discovered, not its normalized form — see the
        // goto() comment above (GAP-052) for why navigating to a
        // trailing-slash-stripped URL can be wrong.
        enqueue(queue, { url: link, depth: item.depth + 1 });
      }
    }

    // Link-following alone stalls on SPAs that route their primary navigation
    // via button/onClick handlers rather than real `<a href>` anchors (see
    // GAP-042). Only probe once the link queue is running thin — following a
    // real link is cheaper and safer than guessing at a click target.
    const wantsClickProbe = remainingClickProbes > 0 && queue.length < LINK_QUEUE_THIN_THRESHOLD;
    if (wantsClickProbe) {
      const maxClicks = Math.min(MAX_CLICKS_PER_PAGE, remainingClickProbes);
      const clickResult = await discoverClickRoutes(browser, snapshot, baseUrl, maxClicks).catch(
        emptyClickDiscoveryResult,
      );
      remainingClickProbes -= clickResult.attempted;
      resetFailures += clickResult.resetFailures;
      if (clickResult.loginToggleSelectors.length > 0) {
        routes[routes.length - 1].loginToggleSelector = clickResult.loginToggleSelectors[0];
      }
      if (clickResult.unattemptedClickCandidates.length > 0) {
        routes[routes.length - 1].unattemptedClickCandidates = clickResult.unattemptedClickCandidates;
      }
      for (const discovered of clickResult.discoveredUrls) {
        const norm = normalizeUrl(discovered);
        if (!requested.has(norm) && !queued.has(norm)) {
          queued.add(norm);
          enqueue(queue, { url: discovered, depth: item.depth + 1 });
        }
      }
    }
  }

  // Deep-probe (state-reveal) pass — deliberately deferred until discovery (above) is fully
  // done, rather than interleaved with it (see GAP-060, Fixed). Interleaving let whichever
  // routes were dequeued FIRST in a pass spend the whole shared MAX_STATE_PROBES_PER_CRAWL pool
  // on their own click candidates, starving a route visited later in the same pass — on the real
  // target app, that was the authenticated dashboard itself, holding the actual edit-reveal
  // triggers the run needed. Probing pass-1's routes in REVERSE of their visit order flips that:
  // the routes structurally starved before now go first against the full pool. Bounded by the
  // same `deadline` as pass 1 — never runs past the crawl's own overall wall-clock budget.
  // Deliberately does NOT re-enqueue `discoveredUrls` from these probes: reopening BFS this late
  // would reintroduce the interleaving this restructure removes, and the common case (SPA nav via
  // onClick) is already covered by pass 1's own click-probing above.
  if (remainingStateProbes > 0) {
    const stateBudget = { remaining: remainingStateProbes };
    const pass1Routes = [...routes];
    // Tracks wherever the browser was actually left by the previous iteration (or, for the first
    // iteration, by pass 1 itself — pass 2 visits in REVERSE of pass1Routes, so its first route is
    // exactly the last route pass 1 visited). A route matching this is a same-URL no-op for
    // goto() on a hash-routed SPA (see resetAfterProbe/docs/click-probe-reset-corruption.md) —
    // force a genuine reload() instead so a stuck page can't poison this route's own
    // discoverClickRoutes call from the very first snapshot it takes.
    let lastVisitedUrl = pass1Routes[pass1Routes.length - 1]?.url;
    for (let i = pass1Routes.length - 1; i >= 0; i -= 1) {
      if (stateBudget.remaining <= 0 || Date.now() >= deadline) break;
      const route = pass1Routes[i];

      let snapshot: DomSnapshot;
      try {
        if (lastVisitedUrl !== undefined && normalizeUrl(lastVisitedUrl) === normalizeUrl(route.url)) {
          await browser.reload();
        } else {
          await browser.goto(route.url);
        }
        snapshot = await snapshotClean(browser);
      } catch {
        browser.drainNetworkEvents();
        continue;
      }
      browser.drainNetworkEvents();
      lastVisitedUrl = route.url;

      const clickResult = await discoverClickRoutes(browser, snapshot, baseUrl, MAX_CLICKS_PER_PAGE, {
        deepProbe: {
          stateKeyPrefix: route.url,
          depth: 0,
          parentDepth: route.depth,
          budget: stateBudget,
          stateFingerprints,
        },
      }).catch(emptyClickDiscoveryResult);
      resetFailures += clickResult.resetFailures;

      if (clickResult.loginToggleSelectors.length > 0) {
        route.loginToggleSelector = clickResult.loginToggleSelectors[0];
      }
      if (clickResult.unattemptedClickCandidates.length > 0) {
        route.unattemptedClickCandidates = clickResult.unattemptedClickCandidates;
      }
      if (clickResult.discoveredStates.length > 0) {
        routes.push(...clickResult.discoveredStates);
      }
    }
    remainingStateProbes = stateBudget.remaining;
  }

  const dominant = fingerprintCounts.size > 0 ? Math.max(...fingerprintCounts.values()) : 0;
  const shellCollapsed = routes.length > 1 && dominant / routes.length >= SHELL_COLLAPSE_RATIO;

  return {
    routes,
    visitedCount: routes.length,
    budgetExhausted,
    // Counts only URLs never requested at all — the loop `shift()`s before it can break, and
    // skips already-requested entries, so queue length on its own would over-report.
    unvisitedQueuedCount: queue.filter((q) => !requested.has(normalizeUrl(q.url))).length,
    redirectLoopsDetected,
    shellCollapsed,
    degenerateRedirectsSkipped,
    resetFailures,
  };
}

export interface ManySeedsOptions {
  /** Absolute ceiling on concurrent seed crawls, regardless of any dynamic sizing below — never
   * truly unbounded. Default 5. */
  maxConcurrentSeeds?: number;
  perSeedMaxRoutes?: number;
  perSeedBudgetMs?: number;
  /** Hard ceiling for the whole fan-out phase, regardless of seed count/concurrency. */
  totalBudgetMs?: number;
}

const DEFAULT_MANY_SEEDS_MAX_CONCURRENCY = 5;
const DEFAULT_PER_SEED_MAX_ROUTES = 8;
const DEFAULT_PER_SEED_BUDGET_MS = 25_000;
const DEFAULT_MANY_SEEDS_TOTAL_BUDGET_MS = 90_000;

/** Best-effort empty CrawlResult for a seed whose own browser session never got off the ground —
 * never lets one bad seed abort the rest of the fan-out. */
function emptyCrawlResult(): CrawlResult {
  return {
    routes: [],
    visitedCount: 0,
    budgetExhausted: false,
    redirectLoopsDetected: [],
    shellCollapsed: false,
    degenerateRedirectsSkipped: [],
  };
}

/**
 * Crawls multiple independent seed URLs concurrently, each in its OWN fresh `BrowserSurface` (own
 * Chromium process — separate origins can't share a `BrowserContext`), pre-authenticated from
 * `storageState` (a prior session's exported cookies/localStorage — see
 * `BrowserSurface.exportStorageState`) so no seed needs its own login attempt. This is the
 * FALLBACK path for a target whose regions/sections are genuinely separate deployments/origins.
 * Same-origin hash-route siblings should use `deriveRegionSeeds` (seed-discovery.ts) plus ordinary
 * `seedRoutes` injection into a single already-authenticated crawl instead — reusing one context
 * directly is both simpler and cheaper, and is the common case (see that module's doc comment).
 *
 * Concurrency is derived from a quick single-seed timing probe (the first seed, crawled alone)
 * rather than a flat constant: a seed that runs slow/near its own budget means this target is
 * heavy or rate-sensitive, so the rest run with LESS concurrency, not more — always clamped to
 * `maxConcurrentSeeds` (default 5) regardless of what the probe suggests, so a very fast target
 * can never trigger dozens of concurrent Chromium processes.
 */
export async function crawlManySeeds(
  seeds: string[],
  browserFactory: () => BrowserSurface,
  storageState: unknown,
  opts: ManySeedsOptions = {},
): Promise<CrawlResult> {
  if (seeds.length === 0) return emptyCrawlResult();

  const perSeedMaxRoutes = opts.perSeedMaxRoutes ?? DEFAULT_PER_SEED_MAX_ROUTES;
  const perSeedBudgetMs = opts.perSeedBudgetMs ?? DEFAULT_PER_SEED_BUDGET_MS;
  const absoluteMaxConcurrency = opts.maxConcurrentSeeds ?? DEFAULT_MANY_SEEDS_MAX_CONCURRENCY;
  const totalDeadline = Date.now() + (opts.totalBudgetMs ?? DEFAULT_MANY_SEEDS_TOTAL_BUDGET_MS);

  async function crawlOneSeed(seedUrl: string, budgetMs: number): Promise<CrawlResult> {
    const browser = browserFactory();
    try {
      await browser.start({ headless: true, baseUrl: seedUrl, storageState });
      const result = await crawl(browser, seedUrl, {
        maxRoutes: perSeedMaxRoutes,
        wallClockBudgetMs: budgetMs,
      });
      let label: string | undefined;
      try {
        label = new URL(seedUrl).origin;
      } catch {
        label = undefined;
      }
      return { ...result, routes: result.routes.map((r) => ({ ...r, seedLabel: r.seedLabel ?? label })) };
    } catch {
      // A seed whose own browser process never got off the ground (launch failure, bad URL) is
      // just an empty contribution — never lets one bad seed abort the rest of the fan-out.
      return emptyCrawlResult();
    } finally {
      await browser.stop().catch(() => undefined);
    }
  }

  // Calibration probe: crawl the first seed alone, timed, before deciding concurrency for the
  // rest.
  const probeStart = Date.now();
  const probeResult = await crawlOneSeed(seeds[0], perSeedBudgetMs);
  const probeElapsedMs = Date.now() - probeStart;

  const results: CrawlResult[] = [probeResult];
  const rest = seeds.slice(1);
  if (rest.length > 0 && Date.now() < totalDeadline) {
    const dynamicConcurrency =
      probeElapsedMs > perSeedBudgetMs * 0.8
        ? 1 // probe nearly exhausted its own budget — this target is slow/heavy, stay serial
        : probeElapsedMs < perSeedBudgetMs * 0.25
          ? absoluteMaxConcurrency // fast target — safe to use the full ceiling
          : Math.max(1, Math.floor(absoluteMaxConcurrency / 2));
    const concurrency = Math.min(dynamicConcurrency, absoluteMaxConcurrency, rest.length);

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (Date.now() >= totalDeadline) return;
        const i = nextIndex;
        nextIndex += 1;
        if (i >= rest.length) return;
        const remainingMs = Math.max(1_000, Math.min(perSeedBudgetMs, totalDeadline - Date.now()));
        results.push(await crawlOneSeed(rest[i], remainingMs));
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  return results.reduce((acc, r) => mergeCrawlResults(acc, r));
}

export interface CrawlWithAuthOptions extends CrawlOptions {
  credentials?: { username: string; password: string };
  /** Overrides the anonymous pass's own `stateProbeBudget` (see GAP-060). Defaults to
   * ANONYMOUS_STATE_PROBE_RESERVE — small on purpose: the authenticated, behind-login surface is
   * consistently the higher-value deep-probe target (measured evidence in GAP-060's gap-tracker
   * entry), so the anonymous pass gets just enough reserve to still catch an anonymous-page state
   * (e.g. a date-picker) without crowding out the budget the authenticated pass gets via its own,
   * independent `crawl()` call (`opts.stateProbeBudget` below, unaffected by this field). */
  anonymousStateProbeBudget?: number;
}

/** See `CrawlWithAuthOptions.anonymousStateProbeBudget`'s doc comment. */
const ANONYMOUS_STATE_PROBE_RESERVE = 5;

export interface CrawlWithAuthResult extends CrawlResult {
  /** Whether a login candidate was found and a login was actually attempted. */
  authAttempted: boolean;
  /** Whether the login was verified to have actually left the login page. */
  authVerified: boolean;
  /** Set whenever auth wasn't attempted or wasn't verified — never blocks the crawl. */
  authReason?: string;
  /**
   * The exact login page/selectors that were just PROVEN to work, present only when
   * `authVerified: true` — distinct from (and more authoritative than) `scoreLoginCandidates`'s
   * independently re-derived ranking, which doesn't know which route this crawl actually
   * authenticated through and can rank a toggle-gated route below a URL that never worked.
   * Downstream codegen (see modes/playwright/execute.ts) should prefer this over
   * `loginCandidates` whenever present.
   */
  verifiedLogin?: VerifiedLoginInfo;
}

export interface VerifiedLoginInfo {
  /** The exact URL the login form/toggle was on — not re-derived by scoring. */
  pageUrl: string;
  /** Present only when the login view was behind a same-URL client-side toggle. */
  toggleSelector?: string;
  identifierSelector: string;
  passwordSelector: string;
  /** Absent when submission fell back to pressing Enter (no submit button was found). */
  submitSelector?: string;
}

/**
 * Picks the best login candidate among password-bearing routes: a route whose
 * URL reads as login wins outright; otherwise a route with a discovered
 * same-URL login toggle (see `CrawledRoute.loginToggleSelector`) — stronger
 * evidence of a genuine login view than merely "doesn't look like signup",
 * which is exactly what misfires when the only password-bearing route is a
 * register page with an in-form login toggle; otherwise the first route that
 * doesn't read as registration/signup; otherwise (every candidate looks like
 * signup, or none has a URL hint at all) the first one found, same as before.
 * Login and registration pages commonly both carry a password field, so
 * "has a password field" alone can't disambiguate them — the URL hint
 * exists precisely for cases like `#/login` vs `#/register` on the same app.
 */
function pickLoginCandidate(routes: CrawledRoute[]): CrawledRoute | undefined {
  const passwordBearing = routes.filter((r) => r.hasPasswordField);
  return (
    passwordBearing.find((r) => LOGIN_URL_HINT_RE.test(r.url)) ??
    routes.find((r) => r.loginToggleSelector) ??
    passwordBearing.find((r) => !SIGNUP_URL_HINT_RE.test(r.url)) ??
    passwordBearing[0]
  );
}

/**
 * Anonymous-only routes can never reach pages gated behind login, which are
 * exactly the pages Tier B generation needs grounded. Runs the anonymous
 * `crawl()` first (also how a login candidate route is found — see
 * `pickLoginCandidate`), then, only if credentials are supplied and a
 * candidate was found, attempts a verified login and crawls again from the
 * post-login landing page. A failed or unverifiable login degrades to the
 * anonymous-only result plus a reason — it never blocks or throws.
 */
export async function crawlWithAuth(
  browser: BrowserSurface,
  baseUrl: string,
  opts: CrawlWithAuthOptions = {},
): Promise<CrawlWithAuthResult> {
  const anonymous = await crawl(browser, baseUrl, {
    ...opts,
    stateProbeBudget: opts.anonymousStateProbeBudget ?? ANONYMOUS_STATE_PROBE_RESERVE,
  });

  const creds = opts.credentials;
  if (!creds || !creds.username || !creds.password) {
    return { ...anonymous, authAttempted: false, authVerified: false };
  }

  const candidate = pickLoginCandidate(anonymous.routes);
  if (!candidate) {
    return {
      ...anonymous,
      authAttempted: false,
      authVerified: false,
      authReason: 'no password-bearing route found during anonymous crawl',
    };
  }

  const attempt = candidate.loginToggleSelector
    ? await attemptLoginViaToggle(
        browser,
        candidate.url,
        candidate.loginToggleSelector,
        creds.username,
        creds.password,
      )
    : await attemptLogin(browser, candidate.url, creds.username, creds.password);
  if (!attempt.ok) {
    return {
      ...anonymous,
      authAttempted: true,
      authVerified: false,
      authReason: attempt.reason,
    };
  }

  const authCrawl = await crawl(browser, attempt.landingUrl ?? candidate.url, opts);

  return {
    ...mergeCrawlResults(anonymous, authCrawl, 'authenticated'),
    authAttempted: true,
    authVerified: true,
    verifiedLogin: attempt.selectors
      ? {
          pageUrl: candidate.url,
          toggleSelector: candidate.loginToggleSelector,
          identifierSelector: attempt.selectors.identifier,
          passwordSelector: attempt.selectors.password,
          submitSelector: attempt.selectors.submit,
        }
      : undefined,
  };
}

export interface RoutePrefixInfo {
  hashRouted: boolean;
  /** The leading hash segment(s) shared across every visited hash-URL, e.g. "#/SK". */
  invariantPrefix?: string;
}

/**
 * Observes the app's own redirect (e.g. `/` -> `#/SK/home`) to isolate the
 * invariant locale/region segment of a hash-routed SPA, so GENERATE can be
 * told to preserve it instead of guessing a plain path. With only one
 * crawled hash route, the safest default is the FIRST segment only (the
 * common region/locale-prefix shape); with more routes, the true invariant
 * prefix is the longest common leading segment run across all of them.
 */
export function detectRoutePrefix(_requestedUrl: string, routes: CrawledRoute[]): RoutePrefixInfo {
  const hashUrls = routes.map((r) => r.url).filter((u) => u.includes('#'));
  if (hashUrls.length === 0) {
    return { hashRouted: false };
  }

  const segLists = hashUrls
    .map((u) => {
      try {
        return new URL(u).hash;
      } catch {
        return '';
      }
    })
    .map((hash) => hash.replace(/^#\/?/, '').split('/').filter(Boolean));

  const first = segLists[0];
  if (!first || first.length === 0) {
    return { hashRouted: true };
  }

  let commonLen: number;
  if (segLists.length === 1) {
    commonLen = Math.min(1, first.length);
  } else {
    commonLen = first.length;
    for (const segs of segLists.slice(1)) {
      let i = 0;
      while (i < commonLen && i < segs.length && segs[i] === first[i]) i += 1;
      commonLen = i;
    }
  }

  if (commonLen === 0) {
    return { hashRouted: true };
  }
  return { hashRouted: true, invariantPrefix: `#/${first.slice(0, commonLen).join('/')}` };
}

export interface LoginCandidate {
  url: string;
  score: number;
  source: 'crawled' | 'common-path';
}

/**
 * Join a hash/region prefix (e.g. "#/SK") and a static path into one URL-safe relative string,
 * normalizing whichever side does/doesn't already have a separating slash — a naive
 * `${prefix}${path}` concatenation silently produces a malformed "#/SKhome" the moment `path`
 * lacks its own leading slash (as every top-level static-analysis route path does; see
 * target/ast/routes.ts), rather than the real "#/SK/home".
 */
function joinHashPath(prefix: string, path: string): string {
  return `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Bounded last-resort fallback tried only when the crawl found no confident candidate. */
const COMMON_LOGIN_PATHS = ['/login', '/signin', '/auth/login'];
/** Minimum score treated as "confident" (crawled candidates only — see scoreLoginCandidates). */
const CONFIDENT_SCORE = 3;
/**
 * Score given to a COMMON_LOGIN_PATHS guess. Deliberately BELOW what a signup-penalized crawled
 * route reaches (3 for its password field, less SIGNUP_URL_PENALTY), and below CONFIDENT_SCORE so
 * a guess never counts as confidence in its own right.
 *
 * A crawled register page outranking a guessed `/login` is the point, not an oversight: we have
 * positive evidence the register page exists and carries a password field, and none whatsoever
 * that `/login` resolves to anything. On an app whose login view is only a toggle inside the
 * register form — with no `/login` route at all — preferring the guess would send the auth
 * fixture to a URL that renders the SPA's fallback, losing a login that otherwise works (the
 * fixture reveal-clicks the toggle). Since `enqueue` now guarantees a real login route is
 * visited when one is reachable, the case this ordering decides is precisely the one where the
 * guess is wrong.
 */
const COMMON_PATH_SCORE = 1;

/**
 * Penalty applied to a route whose URL reads as registration/signup. Sized to sit in the gap
 * between the two thresholds either side of it: enough that a signup route's password field
 * alone (+3) can no longer reach CONFIDENT_SCORE (so the common-path fallback still gets
 * emitted), but not so much that it drops to or below COMMON_PATH_SCORE (so a page we actually
 * crawled still outranks a URL we only guessed at). See scoreLoginCandidates.
 *
 * Concretely, with a password field's +3: 3 - 1 = 2, which is below CONFIDENT_SCORE (3) and
 * above COMMON_PATH_SCORE (1). A penalty of 2 would instead land exactly ON
 * COMMON_PATH_SCORE, leaving the register page ahead of the guess only by tie-break order —
 * true today, but by accident rather than by intent.
 */
const SIGNUP_URL_PENALTY = 1;

/**
 * Ranks crawled routes as login candidates: highest for an actual password
 * field, plus points for URL/title text matches, minus a penalty for a URL that
 * reads as registration. Falls back to a small common-paths list — reconciled
 * against any detected hash/region prefix instead of a naive path join — only
 * when nothing crawled scores confidently.
 *
 * The signup penalty is the whole reason this isn't just "has a password field". Registration
 * and login pages both carry one, so `hasPasswordField` alone can't tell them apart — and
 * scoring a register page +3 did two kinds of damage at once: it made the register page the
 * top candidate (this feeds HEALIX_TIERB_LOGIN_URL, see modes/playwright/execute.ts), AND,
 * because +3 is exactly CONFIDENT_SCORE, it suppressed the `/login` common-path fallback that
 * would otherwise have rescued the run. A real crawl that never reached `#/SK/login` therefore
 * reported `#/SK/register` as a CONFIDENT login candidate and offered no alternative. Netting
 * the signup hint out fixes both halves: the register page stays a candidate (it may genuinely
 * be the only way in, e.g. an in-form login toggle) but ranks below any real login route and no
 * longer claims a confidence that silently disables the fallback.
 *
 * Mirrors `pickLoginCandidate`'s preference order, which already used these same two regexes —
 * the two had drifted apart, and it was this one, the one feeding the generated auth fixture,
 * that lacked the logic.
 */
export function scoreLoginCandidates(
  routes: CrawledRoute[],
  routing: RoutePrefixInfo,
  baseUrl: string,
): LoginCandidate[] {
  const best = new Map<string, LoginCandidate>();
  for (const route of routes) {
    let score = 0;
    if (route.hasPasswordField) score += 3;
    if (LOGIN_TEXT_RE.test(route.url)) score += 2;
    if (LOGIN_TEXT_RE.test(route.title)) score += 1;
    // Checked after the login hints so a route reading as BOTH (an odd path like
    // "/register-or-login") keeps its login credit — same precedence as pickLoginCandidate.
    if (!LOGIN_URL_HINT_RE.test(route.url) && SIGNUP_URL_HINT_RE.test(route.url)) {
      score -= SIGNUP_URL_PENALTY;
    }
    if (score <= 0) continue;
    // Deduped by normalized URL, keeping the HIGHEST score: a route and its deep-probe states
    // (see CrawledRoute.stateKey) share one URL, so without this the same page appeared two or
    // three times in a row — pure noise for a caller that only ever reads candidates[0]. Keeping
    // the max rather than the first matters because a probed state can carry signals its base
    // route didn't (a click that reveals the password field).
    const key = normalizeUrl(route.url);
    const existing = best.get(key);
    if (!existing || score > existing.score) {
      best.set(key, { url: existing?.url ?? route.url, score, source: 'crawled' });
    }
  }
  const candidates = [...best.values()].sort((a, b) => b.score - a.score);

  if (!candidates.some((c) => c.score >= CONFIDENT_SCORE)) {
    for (const path of COMMON_LOGIN_PATHS) {
      const relative = routing.hashRouted ? joinHashPath(routing.invariantPrefix ?? '#', path) : path;
      try {
        candidates.push({
          url: new URL(relative, baseUrl).toString(),
          score: COMMON_PATH_SCORE,
          source: 'common-path',
        });
      } catch {
        // Malformed baseUrl — skip this fallback candidate rather than throw.
      }
    }
    // Re-sorted because a common-path guess deliberately outranks a signup-penalized crawled
    // route: a guessed `/login` is a better bet than a register page we know is a register page.
    // Without this the two tie in insertion order and the register page wins by being first,
    // which is the exact failure the penalty above exists to prevent.
    candidates.sort((a, b) => b.score - a.score);
  }

  return candidates;
}

const DYNAMIC_SEGMENT_RE = /[:[*]/;

/**
 * Resolves static-analysis route paths (e.g. from functionality-index.ts)
 * into crawlable URLs, reconciled against the detected hash/region prefix —
 * the same join scoreLoginCandidates already uses for its common-path
 * fallback, since a raw static path like "/checkout" is wrong on a
 * hash+region-routed app (needs "#/SK/checkout"). Paths with a dynamic
 * segment (":id", "[id]", "*") are dropped: there's no real value to crawl
 * them with, and guessing one produces noise, not signal.
 */
export function reconcileStaticRoutePaths(
  paths: string[],
  routing: RoutePrefixInfo,
  baseUrl: string,
): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (DYNAMIC_SEGMENT_RE.test(path)) continue;
    const relative = routing.hashRouted ? joinHashPath(routing.invariantPrefix ?? '#', path) : path;
    try {
      out.push(new URL(relative, baseUrl).toString());
    } catch {
      // Malformed path — skip rather than throw.
    }
  }
  return out;
}
