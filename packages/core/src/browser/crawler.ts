import { attemptLogin } from './login.js';
import type { BrowserSurface, CapturedNetworkEvent, DomSnapshot, InteractiveElement } from './types.js';

export interface CrawledRoute {
  url: string;
  title: string;
  snapshot: DomSnapshot;
  /** BFS distance from the seed URL(s); 0 for the entry route(s). */
  depth: number;
  hasPasswordField: boolean;
  /** Whether this route was reached before or after a verified login. */
  role: 'anonymous' | 'authenticated';
  /** XHR/fetch traffic observed while this route settled (goto + snapshot). Not
   * perfectly attributed — a slow response from this route can land during the
   * next route's drain window — but sufficient as endpoint/status/body ground
   * truth (see GAP-046, `browser/network-capture.ts`). */
  networkEvents: CapturedNetworkEvent[];
}

export interface CrawlResult {
  routes: CrawledRoute[];
  visitedCount: number;
  /** True when the route/wall-clock budget was hit before the queue drained. */
  budgetExhausted: boolean;
  /** Human-readable `a <-> b` pairs for detected two-node redirect ping-pongs. */
  redirectLoopsDetected: string[];
  /** True when most visited routes render near-identical DOM (a single-shell SPA). */
  shellCollapsed: boolean;
  /** Requested URLs whose resolution was skipped as a runaway/degenerate redirect — see isDegenerateUrl. Likely an app-side routing defect, not a Healix bug; never a confirmed triage verdict. */
  degenerateRedirectsSkipped: string[];
}

export interface CrawlOptions {
  /** Hard cap on distinct routes visited. Default 25. */
  maxRoutes?: number;
  /** Wall-clock budget for the whole crawl. Default 45s. */
  wallClockBudgetMs?: number;
  /** Extra URLs to seed the BFS queue alongside `baseUrl` (e.g. known routes from static analysis). */
  seedRoutes?: string[];
}

const DEFAULT_MAX_ROUTES = 25;
const DEFAULT_BUDGET_MS = 45_000;
/** Once a DOM fingerprint has repeated this many times, stop following that page's links. */
const SHELL_REPEAT_THRESHOLD = 3;
/** Share of visited routes sharing the dominant fingerprint that counts as "collapsed". */
const SHELL_COLLAPSE_RATIO = 0.8;

interface QueueItem {
  url: string;
  depth: number;
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
 * production app unattended.
 */
const UNSAFE_CLICK_TEXT_RE =
  /delete|remove|logout|log out|sign out|submit|save|create|update|checkout|pay|purchase|register|sign up|add to cart|clear|cancel/i;
/** Cap on click candidates considered per page, before the per-visit MAX_CLICKS_PER_PAGE slice. */
const CLICK_CANDIDATES_PER_PAGE = 8;
/** Click-probe candidates actually clicked on a single page in one visit. */
const MAX_CLICKS_PER_PAGE = 4;
/** Total click-probe budget across a whole crawl() call — a fallback for link-following, not the primary discovery mechanism, so it's bounded tightly. */
const MAX_CLICK_PROBES_PER_CRAWL = 20;
/** Only click-probe a page once the link-following queue is running low — following a real link is cheaper and safer than guessing at a click target. */
const LINK_QUEUE_THIN_THRESHOLD = 3;

function extractClickCandidates(snapshot: DomSnapshot): InteractiveElement[] {
  return snapshot.interactiveElements
    .filter((el) => el.role === 'button' || (el.role === 'link' && !el.href))
    .filter((el) => !el.disabled)
    .filter((el) => el.buttonType !== 'submit')
    .filter((el) => !UNSAFE_CLICK_TEXT_RE.test(el.name))
    .slice(0, CLICK_CANDIDATES_PER_PAGE);
}

export interface ClickDiscoveryResult {
  attempted: number;
  discoveredUrls: string[];
}

/**
 * Probes a bounded number of same-page click candidates to discover routes a
 * pure `<a href>` scan can't see — common in SPAs that route their primary
 * navigation via button/onClick handlers rather than real anchors (this is
 * why a link-only crawl can stall at a single thin route on such an app; see
 * GAP-042). Never clicks anything inside a form, disabled, a submit control,
 * or with a name matching UNSAFE_CLICK_TEXT_RE. After each click, resets to
 * `originalUrl` (if the click navigated) or presses Escape (if it likely just
 * opened a menu/dropdown in place) before trying the next candidate, so the
 * page is always back in a known state for the caller.
 */
async function discoverClickRoutes(
  browser: BrowserSurface,
  snapshot: DomSnapshot,
  origin: string,
  maxClicks: number,
): Promise<ClickDiscoveryResult> {
  const originalUrl = snapshot.url;
  const candidates = extractClickCandidates(snapshot).slice(0, Math.max(0, maxClicks));
  const discoveredUrls: string[] = [];
  let attempted = 0;

  for (const candidate of candidates) {
    attempted += 1;
    try {
      await browser.click(candidate.selector);
      const after = await browser.snapshot();
      if (normalizeUrl(after.url) !== normalizeUrl(originalUrl)) {
        if (sameOrigin(after.url, origin)) discoveredUrls.push(after.url);
        discoveredUrls.push(...extractLinks(after, origin));
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

  return { attempted, discoveredUrls };
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

  const queue: QueueItem[] = [
    { url: baseUrl, depth: 0 },
    ...(opts.seedRoutes ?? []).map((url) => ({ url, depth: 0 })),
  ];
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
      await browser.goto(requestedUrl);
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

    routes.push({
      url: resolvedUrl,
      title: snapshot.title,
      snapshot,
      depth: item.depth,
      hasPasswordField: hasPasswordField(snapshot),
      role: 'anonymous',
      networkEvents,
    });

    // A fingerprint that keeps repeating is a shell page rendering nothing
    // new — stop following its links so budget goes toward real routes.
    if (fpCount > SHELL_REPEAT_THRESHOLD) continue;

    for (const link of extractLinks(snapshot, baseUrl)) {
      const norm = normalizeUrl(link);
      if (!requested.has(norm) && !queued.has(norm)) {
        queued.add(norm);
        queue.push({ url: norm, depth: item.depth + 1 });
      }
    }

    // Link-following alone stalls on SPAs that route their primary navigation
    // via button/onClick handlers rather than real `<a href>` anchors (see
    // GAP-042). Only probe once the link queue is running thin — following a
    // real link is cheaper and safer than guessing at a click target.
    if (remainingClickProbes > 0 && queue.length < LINK_QUEUE_THIN_THRESHOLD) {
      const maxClicks = Math.min(MAX_CLICKS_PER_PAGE, remainingClickProbes);
      const clickResult = await discoverClickRoutes(browser, snapshot, baseUrl, maxClicks).catch(
        (): ClickDiscoveryResult => ({ attempted: 0, discoveredUrls: [] }),
      );
      remainingClickProbes -= clickResult.attempted;
      for (const discovered of clickResult.discoveredUrls) {
        const norm = normalizeUrl(discovered);
        if (!requested.has(norm) && !queued.has(norm)) {
          queued.add(norm);
          queue.push({ url: discovered, depth: item.depth + 1 });
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

/** Matches a URL that reads as a login page — checked before the signup/register hint so a
 * route matching both (unlikely, but possible on an odd path) is still treated as login. */
const LOGIN_URL_HINT_RE = /\blogin\b|\bsign-?in\b/i;
/** Matches a URL that reads as registration — many apps expose a password field on both a
 * signup and a login page, so a route hinting at signup is a weaker login candidate than one
 * with no hint either way. */
const SIGNUP_URL_HINT_RE = /\bregister\b|\bsign-?up\b/i;

/**
 * Picks the best login candidate among password-bearing routes: a route whose
 * URL reads as login wins outright; otherwise the first route that doesn't
 * read as registration/signup; otherwise (every candidate looks like
 * signup, or none has a URL hint at all) the first one found, same as before.
 * Login and registration pages commonly both carry a password field, so
 * "has a password field" alone can't disambiguate them — the URL hint
 * exists precisely for cases like `#/login` vs `#/register` on the same app.
 */
function pickLoginCandidate(routes: CrawledRoute[]): CrawledRoute | undefined {
  const passwordBearing = routes.filter((r) => r.hasPasswordField);
  return (
    passwordBearing.find((r) => LOGIN_URL_HINT_RE.test(r.url)) ??
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

  const attempt = await attemptLogin(browser, candidate.url, creds.username, creds.password);
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

const LOGIN_TEXT_RE = /log[- ]?in|sign[- ]?in|prihl[aá]si/i;
/** Bounded last-resort fallback tried only when the crawl found no confident candidate. */
const COMMON_LOGIN_PATHS = ['/login', '/signin', '/auth/login'];
/** Minimum score treated as "confident" (crawled candidates only — see scoreLoginCandidates). */
const CONFIDENT_SCORE = 3;

/**
 * Ranks crawled routes as login candidates: highest for an actual password
 * field, plus points for URL/title text matches. Falls back to a small
 * common-paths list — reconciled against any detected hash/region prefix
 * instead of a naive path join — only when nothing crawled scores
 * confidently.
 */
export function scoreLoginCandidates(
  routes: CrawledRoute[],
  routing: RoutePrefixInfo,
  baseUrl: string,
): LoginCandidate[] {
  const candidates: LoginCandidate[] = [];
  for (const route of routes) {
    let score = 0;
    if (route.hasPasswordField) score += 3;
    if (LOGIN_TEXT_RE.test(route.url)) score += 2;
    if (LOGIN_TEXT_RE.test(route.title)) score += 1;
    if (score > 0) candidates.push({ url: route.url, score, source: 'crawled' });
  }
  candidates.sort((a, b) => b.score - a.score);

  if (!candidates.some((c) => c.score >= CONFIDENT_SCORE)) {
    for (const path of COMMON_LOGIN_PATHS) {
      const relative = routing.hashRouted ? `${routing.invariantPrefix ?? '#'}${path}` : path;
      try {
        candidates.push({ url: new URL(relative, baseUrl).toString(), score: 1, source: 'common-path' });
      } catch {
        // Malformed baseUrl — skip this fallback candidate rather than throw.
      }
    }
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
    const relative = routing.hashRouted ? `${routing.invariantPrefix ?? '#'}${path}` : path;
    try {
      out.push(new URL(relative, baseUrl).toString());
    } catch {
      // Malformed path — skip rather than throw.
    }
  }
  return out;
}
