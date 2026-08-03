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
  /** True when this state's DOM contains a visible, unfilled OTP/verification-code-shaped input
   * (see OTP_HINT_RE) — a further step exists here that Healix deliberately never advances past,
   * since a real code can't be observed or synthesized. Set independent of whether
   * `fillSafeInputs` actually ran against this exact snapshot, so a state reached at the crawl's
   * max recursion depth (where `fillSafeInputs` never runs to look one hop further — see
   * MAX_STATE_DEPTH) still correctly reports the gate (see Cluster C). */
  otpGateReached?: boolean;
  /** Accessible names of visible, enabled controls on this state whose wording reads as a
   * destructive/irreversible action (see DESTRUCTIVE_ACTION_TEXT_RE) — e.g. "Delete account",
   * "Pay now". These are already never clicked by `extractClickCandidates`'s existing
   * UNSAFE_CLICK_TEXT_RE filter; this field just makes that "saw it, deliberately skipped it"
   * fact visible to GENERATE instead of silently discarding it (see Cluster C). Absent/empty when
   * none were observed. */
  destructiveActionsSeen?: string[];
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
}

export interface CrawlOptions {
  /** Hard cap on distinct routes visited. Default 60. */
  maxRoutes?: number;
  /** Wall-clock budget for the whole crawl. Default 120s. */
  wallClockBudgetMs?: number;
  /** Extra URLs to seed the BFS queue alongside `baseUrl` (e.g. known routes from static analysis). */
  seedRoutes?: string[];
}

const DEFAULT_MAX_ROUTES = 60;
// Click-probing now also tries GAP-053's non-semantic `generic` candidates (see
// extractClickCandidates below), so a click-probe-heavy page costs noticeably more
// real navigations than before this budget was last tuned — raised alongside
// MAX_CLICKS_PER_PAGE/MAX_CLICK_PROBES_PER_CRAWL so the larger candidate pool has
// room to actually run instead of hitting budgetExhausted mid-page.
const DEFAULT_BUDGET_MS = 240_000;
/**
 * Fraction of the wall-clock budget after which a deep probe will no longer be STARTED while
 * unvisited routes are still queued. Deep-probe is enrichment (it re-discovers a state that
 * only exists behind a click); ordinary route discovery is a prerequisite for everything
 * downstream, so when the two compete for the tail of the budget, discovery has to win —
 * otherwise budget exhaustion costs whole routes instead of merely costing detail. Note this
 * gates on the BUDGET, not on the route's own element count: GAP-056's finding that every
 * route deserves deep-probe eligibility (a well-populated page can still hide an ungrounded
 * same-URL form) is untouched — probes still run on every route, just not once they'd be
 * spending time the queue still needs.
 */
const DEEP_PROBE_BUDGET_FRACTION = 0.5;
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

function sameOrigin(url: string, originUrl: string): boolean {
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
 */
const UNSAFE_CLICK_TEXT_RE =
  /delete|remove|logout|log out|sign out|submit|save|create|update|checkout|pay|purchase|add to cart|clear|cancel/i;
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
 * Total deep-probe budget across a whole crawl() call — a separate pool from
 * MAX_CLICK_PROBES_PER_CRAWL so multi-step-flow probing (click + fill + recurse, materially
 * pricier than a single discovery click) never cannibalizes ordinary route-discovery budget.
 * Deliberately NOT gated on the parent route's own element count: a live audit of the real C&A
 * app found a healthy, well-populated "My account" page (~15 elements) whose "change password"
 * button reveals a same-URL form via exactly this mechanism — gating on route-thinness alone
 * would silently keep missing it, since a page can be well-populated overall and STILL hide an
 * important modal behind one specific button. STATE_REVEAL_MIN_NEW_ELEMENTS is what keeps this
 * targeted instead (an ordinary dropdown/menu reveals too few elements to qualify), and this
 * crawl-wide cap is what keeps the cost bounded on every page, healthy or not.
 */
const MAX_STATE_PROBES_PER_CRAWL = 20;
/** A same-URL click only counts as "revealed a real state" (worth recording/recursing into),
 * not just a small dropdown/menu, when it adds at least this many interactive elements. */
const STATE_REVEAL_MIN_NEW_ELEMENTS = 5;
/** Input name/id/selector hints that read as a one-time/verification code — never auto-filled,
 * since a real OTP requires a code delivered over an external channel (email/SMS) that a crawl
 * has no way to observe or synthesize. Flows gated behind this remain a `test.fixme()` case by
 * design, not a bug in `fillSafeInputs`. */
const OTP_HINT_RE = /otp|verification.?code|one.?time|\b2fa\b|\bmfa\b/i;

/**
 * Wording that reads as a destructive/irreversible action against a real app/account — a
 * deliberately NARROW subset of UNSAFE_CLICK_TEXT_RE's wording (see Cluster C, discussed with the
 * user): only actions genuinely unsafe to actually execute (delete an account, make a payment),
 * not merely mutating/reversible ones (logout/save/submit/cancel), which remain normal, valuable
 * things for a generated test to click. A separate, narrower regex rather than reusing
 * UNSAFE_CLICK_TEXT_RE directly, since that one's broader scope exists for a different purpose
 * (click-probing safety during EXPLORE) and mixing the two would over-flag safe actions as
 * manual-only.
 */
export const DESTRUCTIVE_ACTION_TEXT_RE = /delete|remove|checkout|\bpay\b|purchase/i;

/** True when this snapshot contains a visible, unfilled OTP/verification-code-shaped input (see
 * OTP_HINT_RE) — independent of whether fillSafeInputs actually ran against this exact snapshot. */
function hasOtpGate(snapshot: DomSnapshot): boolean {
  return snapshot.interactiveElements.some(
    (el) =>
      el.role === 'textbox' &&
      !el.disabled &&
      el.inputType !== 'password' &&
      el.inputType !== 'file' &&
      (OTP_HINT_RE.test(el.name) || OTP_HINT_RE.test(el.selector)),
  );
}

/** Accessible names of visible, enabled destructive-action-shaped controls on this snapshot (see
 * DESTRUCTIVE_ACTION_TEXT_RE) — the same candidate shape `extractClickCandidates` considers, but
 * recorded rather than silently dropped, since these are exactly the ones it never clicks. */
function destructiveActionsSeen(snapshot: DomSnapshot): string[] {
  return snapshot.interactiveElements
    .filter((el) => el.role === 'button' || el.role === 'generic' || el.role === 'link')
    .filter((el) => !el.disabled)
    .filter((el) => DESTRUCTIVE_ACTION_TEXT_RE.test(el.name))
    .map((el) => el.name);
}

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
}

/** Enables the deep-probe behavior in `discoverClickRoutes` — engaged on every route (see
 * GAP-056; NOT gated on the route's own element count), bounded instead by
 * MAX_STATE_PROBES_PER_CRAWL/MAX_STATE_DEPTH and by STATE_REVEAL_MIN_NEW_ELEMENTS only ever
 * recording a click that reveals a real, materially larger state. */
interface DeepProbeOpts {
  /** This state's identity so far: the route URL plus every selector clicked to reach it. */
  stateKeyPrefix: string;
  /** How many state-levels deep this call already is (0 for the initial call on a page). */
  depth: number;
  /** The originating route's own BFS depth — carried through unchanged onto any recorded state. */
  parentDepth: number;
  /** Shared, mutable across the whole recursion tree for this page — see MAX_STATE_PROBES_PER_CRAWL. */
  budget: { remaining: number };
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
 * reveals a MATERIALLY LARGER DOM state (>= STATE_REVEAL_MIN_NEW_ELEMENTS more interactive
 * elements than a small dropdown/menu — those still fall through to the ordinary harvest-and-
 * revert branch) is instead recorded as its own `CrawledRoute` (keyed by `stateKey`, not `url`,
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
  const deepProbe = opts.deepProbe;

  for (const candidate of candidates) {
    if (deepProbe && deepProbe.budget.remaining <= 0) break;
    attempted += 1;
    if (deepProbe) deepProbe.budget.remaining -= 1;
    try {
      await browser.click(candidate.selector);
      const after = await browser.snapshot();
      if (normalizeUrl(after.url) !== normalizeUrl(originalUrl)) {
        if (sameOrigin(after.url, origin)) discoveredUrls.push(after.url);
        discoveredUrls.push(...extractLinks(after, origin));
        await browser.goto(originalUrl).catch(() => undefined);
      } else if (LOGIN_TEXT_RE.test(candidate.name) && hasPasswordField(after)) {
        loginToggleSelectors.push(candidate.selector);
        await browser.pressKey('Escape').catch(() => undefined);
      } else if (
        deepProbe &&
        after.interactiveElements.length - beforeCount >= STATE_REVEAL_MIN_NEW_ELEMENTS
      ) {
        const stateKey = `${deepProbe.stateKeyPrefix}>>${candidate.selector}`;
        const destructiveNames = destructiveActionsSeen(after);
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
          otpGateReached: hasOtpGate(after),
          ...(destructiveNames.length > 0 ? { destructiveActionsSeen: destructiveNames } : {}),
        });
        discoveredUrls.push(...extractLinks(after, origin));

        // MAX_STATE_DEPTH counts recorded hops: this candidate's reveal is hop `deepProbe.depth +
        // 1`. Only recurse (look for one more hop past it) while that count still has room —
        // e.g. MAX_STATE_DEPTH=2 records hop1 and hop2, but never explores INSIDE hop2 looking
        // for a hop3, so a hop3 candidate is simply never clicked at all.
        if (deepProbe.depth + 1 < MAX_STATE_DEPTH && deepProbe.budget.remaining > 0) {
          await fillSafeInputs(browser, after).catch(() => 0);
          const settled = await browser.snapshot().catch(() => after);
          const nested = await discoverClickRoutes(browser, settled, origin, MAX_CLICKS_PER_PAGE, {
            deepProbe: {
              stateKeyPrefix: stateKey,
              depth: deepProbe.depth + 1,
              parentDepth: deepProbe.parentDepth,
              budget: deepProbe.budget,
            },
          });
          discoveredUrls.push(...nested.discoveredUrls);
          loginToggleSelectors.push(...nested.loginToggleSelectors);
          discoveredStates.push(...nested.discoveredStates);
        }

        await browser.pressKey('Escape').catch(() => undefined);
        await browser.goto(originalUrl).catch(() => undefined);
      } else {
        // Click likely opened a menu/dropdown in place rather than navigating
        // — collect any newly revealed anchors, then close it.
        discoveredUrls.push(...extractLinks(after, origin));
        await browser.pressKey('Escape').catch(() => undefined);
      }
    } catch {
      // Dead click target or click failed — best-effort reset, keep probing the rest.
      await browser.goto(originalUrl).catch(() => undefined);
    }
  }

  return { attempted, discoveredUrls, loginToggleSelectors, discoveredStates };
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

function hasPasswordField(snapshot: DomSnapshot): boolean {
  return snapshot.interactiveElements.some((el) => el.inputType === 'password');
}

/** Recognizable "this route rendered a crash" shapes: a framework error-boundary fallback
 * (React Router's default included), a browser-reported uncaught error, or a raw stack-trace
 * line (`at fn (file:line:col)`) leaking into the accessible tree/title instead of real content. */
const CRASH_MARKER_RE =
  /unexpected application error|error boundary|uncaught (?:runtime )?error|at\s+\S+\s+\([^)]+:\d+:\d+\)/i;

/** `snapshot.axTree` (Playwright's `ariaSnapshot()`) is a YAML string when present — see
 * `browser/index.ts`'s `snapshot()`. Checked alongside the title since a crash fallback page
 * commonly carries a generic/blank title but a distinctive accessible tree (or vice versa). */
function looksCrashed(snapshot: DomSnapshot): boolean {
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
function isDegenerateUrl(url: string): boolean {
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
  // See DEEP_PROBE_BUDGET_FRACTION: past this point, enrichment yields to discovery.
  const deepProbeCutoff = Date.now() + budgetMs * DEEP_PROBE_BUDGET_FRACTION;

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
  const routes: CrawledRoute[] = [];
  let budgetExhausted = false;
  let remainingClickProbes = MAX_CLICK_PROBES_PER_CRAWL;
  let remainingStateProbes = MAX_STATE_PROBES_PER_CRAWL;

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
      snapshot = await browser.snapshot();
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

    const destructiveNames = destructiveActionsSeen(snapshot);
    routes.push({
      url: resolvedUrl,
      title: snapshot.title,
      snapshot,
      depth: item.depth,
      hasPasswordField: hasPasswordField(snapshot),
      role: 'anonymous',
      networkEvents,
      crashed: looksCrashed(snapshot),
      otpGateReached: hasOtpGate(snapshot),
      ...(destructiveNames.length > 0 ? { destructiveActionsSeen: destructiveNames } : {}),
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
    // Every route is deep-probe eligible (see GAP-056) — NOT gated on this route's own element
    // count. A live audit of the real C&A app found a healthy, well-populated "My account" page
    // whose "change password" button still reveals an un-grounded same-URL form; gating on
    // route-thinness would keep missing exactly that shape. STATE_REVEAL_MIN_NEW_ELEMENTS (only a
    // click that reveals a real, materially larger state ever gets recorded) and the separate
    // MAX_STATE_PROBES_PER_CRAWL budget below are what keep this bounded instead.
    // ...but past DEEP_PROBE_BUDGET_FRACTION of the budget, only when nothing is left to
    // discover — see that constant for why enrichment yields to discovery at the tail.
    const wantsStateProbe = remainingStateProbes > 0 && (queue.length === 0 || Date.now() < deepProbeCutoff);
    if (wantsClickProbe || wantsStateProbe) {
      const maxClicks = wantsClickProbe
        ? Math.min(MAX_CLICKS_PER_PAGE, remainingClickProbes)
        : MAX_CLICKS_PER_PAGE;
      const stateBudget = wantsStateProbe ? { remaining: remainingStateProbes } : undefined;
      const clickResult = await discoverClickRoutes(browser, snapshot, baseUrl, maxClicks, {
        deepProbe: stateBudget
          ? { stateKeyPrefix: resolvedUrl, depth: 0, parentDepth: item.depth, budget: stateBudget }
          : undefined,
      }).catch(
        (): ClickDiscoveryResult => ({
          attempted: 0,
          discoveredUrls: [],
          loginToggleSelectors: [],
          discoveredStates: [],
        }),
      );
      if (wantsClickProbe) remainingClickProbes -= clickResult.attempted;
      if (stateBudget) remainingStateProbes = stateBudget.remaining;
      if (clickResult.loginToggleSelectors.length > 0) {
        routes[routes.length - 1].loginToggleSelector = clickResult.loginToggleSelectors[0];
      }
      if (clickResult.discoveredStates.length > 0) {
        routes.push(...clickResult.discoveredStates);
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
  };
}

export interface CrawlWithAuthOptions extends CrawlOptions {
  credentials?: { username: string; password: string };
}

export interface CrawlWithAuthResult extends CrawlResult {
  /** Whether a login candidate was found and a login was actually attempted. */
  authAttempted: boolean;
  /** Whether the login was verified to have actually left the login page. */
  authVerified: boolean;
  /** Set whenever auth wasn't attempted or wasn't verified — never blocks the crawl. */
  authReason?: string;
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
  const anonymous = await crawl(browser, baseUrl, opts);

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
  const authenticatedRoutes = authCrawl.routes.map((r) => ({ ...r, role: 'authenticated' as const }));

  return {
    routes: [...anonymous.routes, ...authenticatedRoutes],
    visitedCount: anonymous.visitedCount + authenticatedRoutes.length,
    budgetExhausted: anonymous.budgetExhausted || authCrawl.budgetExhausted,
    unvisitedQueuedCount: (anonymous.unvisitedQueuedCount ?? 0) + (authCrawl.unvisitedQueuedCount ?? 0),
    redirectLoopsDetected: [...anonymous.redirectLoopsDetected, ...authCrawl.redirectLoopsDetected],
    shellCollapsed: anonymous.shellCollapsed || authCrawl.shellCollapsed,
    degenerateRedirectsSkipped: [
      ...anonymous.degenerateRedirectsSkipped,
      ...authCrawl.degenerateRedirectsSkipped,
    ],
    authAttempted: true,
    authVerified: true,
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
