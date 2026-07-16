import { attemptLogin } from './login.js';
import type { BrowserSurface, DomSnapshot } from './types.js';

export interface CrawledRoute {
  url: string;
  title: string;
  snapshot: DomSnapshot;
  /** BFS distance from the seed URL(s); 0 for the entry route(s). */
  depth: number;
  hasPasswordField: boolean;
  /** Whether this route was reached before or after a verified login. */
  role: 'anonymous' | 'authenticated';
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
  const fingerprintCounts = new Map<string, number>();
  const routes: CrawledRoute[] = [];
  let budgetExhausted = false;

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
      // Dead link or navigation failure — skip this node, keep the crawl alive.
      continue;
    }

    const resolvedUrl = normalizeUrl(snapshot.url || requestedUrl);

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
  }

  const dominant = fingerprintCounts.size > 0 ? Math.max(...fingerprintCounts.values()) : 0;
  const shellCollapsed = routes.length > 1 && dominant / routes.length >= SHELL_COLLAPSE_RATIO;

  return {
    routes,
    visitedCount: routes.length,
    budgetExhausted,
    redirectLoopsDetected,
    shellCollapsed,
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
 * Anonymous-only routes can never reach pages gated behind login, which are
 * exactly the pages Tier B generation needs grounded. Runs the anonymous
 * `crawl()` first (also how a login candidate route is found — any visited
 * route with a password field), then, only if credentials are supplied and a
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

  const candidate = anonymous.routes.find((r) => r.hasPasswordField);
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
    authAttempted: true,
    authVerified: true,
  };
}
