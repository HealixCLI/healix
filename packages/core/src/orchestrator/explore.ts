import {
  crawl,
  crawlWithAuth,
  detectRoutePrefix,
  normalizeUrl,
  reconcileStaticRoutePaths,
  scoreLoginCandidates,
  type CrawlOptions,
  type CrawlWithAuthResult,
} from '../browser/crawler.js';
import type { BrowserSurface } from '../browser/types.js';
import { collectObservedEndpoints } from '../browser/network-capture.js';
import type { ExplorationArtifact } from '../modes/types.js';
import type { FunctionalityUnit } from '../target/functionality-index.js';
import type { OrchestratorEvent } from './types.js';

export interface ExploreInput {
  browser: BrowserSurface;
  baseUrl: string;
  credentials?: { username: string; password: string };
  crawlOptions?: CrawlOptions;
  /** Static-analysis route paths (e.g. functionality-index.ts units) to seed as a follow-up crawl once the hash/region prefix is known — see reconcileStaticRoutePaths. */
  staticRoutePaths?: string[];
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void;
  onFrame?: (png: Buffer) => void;
}

/** Bounds for the small follow-up crawl seeded from static-analysis routes. */
const STATIC_SEED_MAX_ROUTES = 15;
const STATIC_SEED_BUDGET_MS = 20_000;

/** Bounded best-effort wait for the frame mirror's first capture before teardown. */
const FIRST_FRAME_WAIT_MS = 600;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A route with fewer captured interactive elements than this is "thin" for the F-03/F-06 coverage ratio. */
const THIN_ROUTE_ELEMENT_THRESHOLD = 5;

/**
 * A login-only or near-empty single route is explicitly NOT "useful context"
 * — generation would be no better grounded than with no exploration at all.
 * Never blocks the run; callers surface the reason as a breadcrumb instead.
 *
 * Beyond that binary verdict, `thinRouteRatio` is a DEGRADATION signal (not a
 * hard fail) for a multi-route crawl that technically has enough total
 * elements to pass the checks above but where most individual routes still
 * captured almost nothing (e.g. 8/10 routes with 0-1 elements) — the "zero
 * components, one generic testid" collapse this was missing before (F-03/F-06).
 */
export function assessExplorationUsefulness(result: CrawlWithAuthResult): {
  useful: boolean;
  reason?: string;
  thinRouteRatio?: number;
} {
  if (result.routes.length === 0) {
    return { useful: false, reason: 'exploration crawled zero routes' };
  }
  const totalElements = result.routes.reduce((sum, r) => sum + r.snapshot.interactiveElements.length, 0);
  if (result.routes.length <= 1 && totalElements < 5) {
    return { useful: false, reason: 'only a single thin route was crawled (login-only or near-empty shell)' };
  }
  if (result.shellCollapsed) {
    return {
      useful: false,
      reason: 'crawled routes render a near-identical DOM (single-shell SPA collapse)',
    };
  }
  const thinRoutes = result.routes.filter(
    (r) => r.snapshot.interactiveElements.length < THIN_ROUTE_ELEMENT_THRESHOLD,
  ).length;
  return { useful: true, thinRouteRatio: thinRoutes / result.routes.length };
}

/** Majority of routes thin enough to warrant a degradation breadcrumb, even though the crawl overall passed. */
const THIN_ROUTE_RATIO_WARN_THRESHOLD = 0.5;

/** Cap on API-only units probed via HTTP instead of a browser crawl seed (see splitStaticUnitsForExplore). */
const MAX_ENDPOINT_PROBES = 10;

/**
 * Stable-partition `units` so any unit whose key is in `priorityKeys` comes first, preserving
 * relative order within each of the two groups — never a full re-sort, which would scramble the
 * meaningful discovery order of everything NOT prioritized. A no-op (returns `units` as-is) when
 * `priorityKeys` is absent/empty, so callers with nothing to prioritize pay no cost.
 */
function stablePartitionByPriority(
  units: FunctionalityUnit[],
  priorityKeys?: ReadonlySet<string>,
): FunctionalityUnit[] {
  if (!priorityKeys || priorityKeys.size === 0) return units;
  const priority: FunctionalityUnit[] = [];
  const rest: FunctionalityUnit[] = [];
  for (const u of units) (priorityKeys.has(u.key) ? priority : rest).push(u);
  return [...priority, ...rest];
}

/**
 * Split a static-analysis unit inventory (see target/source-index.ts) into the two shapes EXPLORE
 * needs: `route` units seed the browser crawl (they render a page), while `endpoint` (tierC, no
 * DOM route) units get a lightweight HTTP reachability probe instead — driving a browser to an
 * API-only path wastes a navigation on something that was never going to render a page. Endpoint
 * paths are capped at MAX_ENDPOINT_PROBES so a large API surface doesn't turn this into its own
 * slow crawl.
 *
 * `priorityKeys` (typically the approved plan's item.unitKey set) moves plan-selected units to
 * the front of each list BEFORE any truncation: MAX_ENDPOINT_PROBES here for endpoints, and
 * downstream crawl()'s own maxRoutes/FIFO-queue truncation for routes (crawler.ts's queue treats
 * input order as visitation priority, so putting plan-relevant routes first is enough — no
 * crawler.ts change needed). Without this, discovery order was arbitrary first-N order, so a
 * route the approved plan actually needs could silently lose the coin flip to one nothing plans
 * to test.
 */
export function splitStaticUnitsForExplore(
  units: FunctionalityUnit[],
  priorityKeys?: ReadonlySet<string>,
): {
  routePaths: string[];
  endpointPaths: string[];
} {
  const routePaths = stablePartitionByPriority(
    units.filter((u) => u.kind === 'route'),
    priorityKeys,
  ).map((u) => u.key.replace(/^route:/, ''));
  const endpointPaths = stablePartitionByPriority(
    units.filter((u) => u.kind === 'endpoint'),
    priorityKeys,
  )
    .map((u) => u.key.replace(/^endpoint:(?:[A-Z]+ )?/, ''))
    .slice(0, MAX_ENDPOINT_PROBES);
  return { routePaths, endpointPaths };
}

/**
 * Replaces the old single `goto`+`snapshot` EXPLORE pass with a bounded
 * multi-page, credential-aware crawl, plus the hash/region-prefix detection
 * and login-candidate scoring that ground GENERATE and the Tier-B auth
 * fixture. Owns the browser's start/stop and frame-mirror subscription
 * lifecycle for the whole crawl, mirroring the timing the orchestrator used
 * to manage inline: subscribe only after the browser has actually navigated,
 * so the UI never mirrors a blank page.
 */
export async function runExplorePhase(input: ExploreInput): Promise<ExplorationArtifact> {
  const { browser, baseUrl, emit } = input;
  let unsubFrames: (() => void) | null = null;
  let firstFrame: Promise<void> | null = null;

  try {
    await browser.start({ headless: true, baseUrl });
    await browser.goto(baseUrl);

    if (input.onFrame) {
      try {
        let resolveFirstFrame: () => void = () => undefined;
        firstFrame = new Promise((resolve) => {
          resolveFirstFrame = resolve;
        });
        let delivered = false;
        unsubFrames = browser.onFrame((png) => {
          input.onFrame?.(png);
          if (!delivered) {
            delivered = true;
            resolveFirstFrame();
          }
        });
      } catch (err) {
        emit('explore', 'debug', `Frame subscription failed (continuing): ${errMsg(err)}`);
      }
    }

    let crawlResult = await crawlWithAuth(browser, baseUrl, {
      ...input.crawlOptions,
      credentials: input.credentials,
    });

    const routing = detectRoutePrefix(baseUrl, crawlResult.routes);

    if (input.staticRoutePaths && input.staticRoutePaths.length > 0) {
      try {
        const reconciled = reconcileStaticRoutePaths(input.staticRoutePaths, routing, baseUrl);
        const alreadyVisited = new Set(crawlResult.routes.map((r) => normalizeUrl(r.url)));
        const unvisited = reconciled.filter((url) => !alreadyVisited.has(normalizeUrl(url)));
        if (unvisited.length > 0) {
          const [firstSeed, ...restSeeds] = unvisited;
          const staticCrawl = await crawl(browser, firstSeed, {
            seedRoutes: restSeeds,
            maxRoutes: STATIC_SEED_MAX_ROUTES,
            wallClockBudgetMs: STATIC_SEED_BUDGET_MS,
          });
          // Reuses whatever session state crawlWithAuth left the browser in
          // (its last action was on the authenticated session if login succeeded).
          const role: 'anonymous' | 'authenticated' = crawlResult.authVerified
            ? 'authenticated'
            : 'anonymous';
          const staticRoutes = staticCrawl.routes.map((r) => ({ ...r, role }));
          crawlResult = {
            ...crawlResult,
            routes: [...crawlResult.routes, ...staticRoutes],
            visitedCount: crawlResult.visitedCount + staticRoutes.length,
            budgetExhausted: crawlResult.budgetExhausted || staticCrawl.budgetExhausted,
            redirectLoopsDetected: [
              ...crawlResult.redirectLoopsDetected,
              ...staticCrawl.redirectLoopsDetected,
            ],
            shellCollapsed: crawlResult.shellCollapsed || staticCrawl.shellCollapsed,
            degenerateRedirectsSkipped: [
              ...crawlResult.degenerateRedirectsSkipped,
              ...staticCrawl.degenerateRedirectsSkipped,
            ],
          };
          if (staticRoutes.length > 0) {
            emit(
              'explore',
              'debug',
              `Static-analysis route seeding found ${staticRoutes.length} additional route(s) not reachable by link-following.`,
            );
          }
        }
      } catch (err) {
        emit('explore', 'debug', `Static route seeding failed (continuing): ${errMsg(err)}`);
      }
    }

    const loginCandidates = scoreLoginCandidates(crawlResult.routes, routing, baseUrl);
    const quality = assessExplorationUsefulness(crawlResult);

    const authenticatedCount = crawlResult.routes.filter((r) => r.role === 'authenticated').length;
    emit(
      'explore',
      'info',
      `Explored ${crawlResult.visitedCount} route(s)${authenticatedCount ? ` (${authenticatedCount} authenticated)` : ''}.`,
      {
        routes: crawlResult.routes.map((r) => ({
          url: r.url,
          role: r.role,
          interactiveElements: r.snapshot.interactiveElements.length,
        })),
        budgetExhausted: crawlResult.budgetExhausted,
        shellCollapsed: crawlResult.shellCollapsed,
        redirectLoopsDetected: crawlResult.redirectLoopsDetected,
        routing,
      },
    );

    if (crawlResult.authAttempted && !crawlResult.authVerified) {
      emit(
        'explore',
        'warn',
        `Credentials present but authenticated crawl could not be verified: ${crawlResult.authReason ?? 'unknown reason'}. Continuing with anonymous routes only.`,
      );
    }

    if (crawlResult.degenerateRedirectsSkipped.length > 0) {
      // Not a triage verdict — crawl() can't tell an app-side routing defect
      // apart from us having probed a nonsense URL. Surfaced as a breadcrumb
      // for a human to investigate, never blocks the run.
      emit(
        'explore',
        'warn',
        `Detected ${crawlResult.degenerateRedirectsSkipped.length} runaway redirect(s) while crawling; skipped as likely app-side routing defect(s).`,
        { skipped: crawlResult.degenerateRedirectsSkipped },
      );
    }

    const crashedRoutes = crawlResult.routes.filter((r) => r.crashed).map((r) => r.url);
    if (crashedRoutes.length > 0) {
      // A real app-side bug (unhandled crash rendering an error boundary),
      // distinct from a route that's merely thin — never blocks the run,
      // just a breadcrumb so it can be told apart from sparse-but-fine.
      emit(
        'explore',
        'warn',
        `${crashedRoutes.length} route(s) rendered an unhandled app-side crash instead of real content.`,
        { crashedRoutes },
      );
    }

    if (!quality.useful) {
      // Breadcrumb only — thin/empty context must never abort the run, it
      // just means GENERATE will lean more on guessing than grounding.
      emit('explore', 'warn', `Exploration produced thin context: ${quality.reason}`, {
        visitedCount: crawlResult.visitedCount,
        shellCollapsed: crawlResult.shellCollapsed,
      });
    } else if (
      quality.thinRouteRatio !== undefined &&
      quality.thinRouteRatio >= THIN_ROUTE_RATIO_WARN_THRESHOLD
    ) {
      // Crawl passed the hard useful/useless gate, but most individual routes
      // still captured almost nothing — a degradation signal (F-03/F-06), not
      // a reason to distrust the whole crawl.
      emit(
        'explore',
        'warn',
        `Exploration coverage is thin: ${Math.round(quality.thinRouteRatio * 100)}% of routes captured fewer than ${THIN_ROUTE_ELEMENT_THRESHOLD} interactive elements.`,
        { thinRouteRatio: quality.thinRouteRatio },
      );
    }

    if (firstFrame) {
      await Promise.race([firstFrame, delay(FIRST_FRAME_WAIT_MS)]);
    }

    return {
      crawl: crawlResult,
      routing,
      loginCandidates,
      useful: quality.useful,
      uselessReason: quality.reason,
      thinRouteRatio: quality.thinRouteRatio,
      observedEndpoints: collectObservedEndpoints(crawlResult),
    };
  } finally {
    if (unsubFrames) {
      try {
        unsubFrames();
      } catch {
        /* never let unsubscribe crash the run */
      }
    }
    await browser.stop().catch(() => undefined);
  }
}
