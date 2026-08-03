import {
  crawl,
  crawlManySeeds,
  crawlWithAuth,
  detectRoutePrefix,
  mergeCrawlResults,
  normalizeUrl,
  reconcileStaticRoutePaths,
  scoreLoginCandidates,
  type CrawlOptions,
  type CrawlWithAuthResult,
} from '../browser/crawler.js';
import type { BrowserSurface } from '../browser/types.js';
import { collectObservedEndpoints } from '../browser/network-capture.js';
import { deriveRegionSeeds, regionCodeOf } from '../browser/seed-discovery.js';
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
  /**
   * Sibling region/locale codes (e.g. `["CZ", "HU", "SI"]`) known to exist for this target,
   * beyond whichever one the primary crawl happened to land in. Used to derive same-origin
   * sibling-region seed URLs (see `browser/seed-discovery.ts`'s `deriveRegionSeeds`) which reuse
   * the already-authenticated session for free — no separate browser process or login needed.
   * Absent/empty simply skips this enrichment step.
   */
  knownRegionCodes?: string[];
  /**
   * Extra config-driven seed URLs to union in alongside any derived region seeds (e.g. a project
   * setting listing known deep-link routes with no in-app link at all). A seed sharing the
   * primary crawl's origin joins the same-context injection above; a seed on a DIFFERENT origin
   * (a genuinely separate deployment per region/section, unlike this app) instead goes through
   * the `crawlManySeeds` fallback below — which needs `browserFactory` to spin up its own
   * independent sessions, since separate origins can't share one `BrowserContext`.
   */
  extraSeedUrls?: string[];
  /** Factory for a fresh `BrowserSurface` (own Chromium process), used only by the separate-
   * origin seed fan-out fallback. Absent simply skips that fallback (the common same-origin
   * case above doesn't need it at all). */
  browserFactory?: () => BrowserSurface;
  /**
   * Called with `browser` right before this phase tears it down (its `finally` always calls
   * `browser.stop()`, which destroys the session). A caller that wants to reuse the just-
   * established authenticated session afterwards — e.g. the gap-fill pass, which runs in
   * `orchestrator/index.ts` AFTER this phase returns and therefore starts a brand-new browser —
   * should export `browser.exportStorageState()` here and hold onto it in memory. Deliberately
   * NOT threaded through the returned `ExplorationArtifact`: that gets persisted to the on-disk
   * exploration cache for up to 24h, and a live session's cookies have no business sitting in a
   * cache file on the caller's behalf.
   */
  onBeforeStop?: (browser: BrowserSurface) => Promise<void> | void;
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void;
  onFrame?: (png: Buffer) => void;
}

/** Bounds for the small follow-up crawl seeded from static-analysis routes. */
const STATIC_SEED_MAX_ROUTES = 15;
const STATIC_SEED_BUDGET_MS = 20_000;

/**
 * Multiplier applied to the calibrated `avgMsPerRoute` when sizing the region-seed fan-out's
 * per-region time budget — a fresh region has cold caches and no warm auth-session shortcuts, so
 * its first visits typically run slower than the primary crawl's steady-state average.
 */
const REGION_SEED_SAFETY_FACTOR = 1.5;
/** Absolute floor so a primary crawl with very few routes (a tiny/fast target) still gets a
 * workable region-seed budget rather than one rounded down to near-zero. */
const REGION_SEED_MIN_BUDGET_MS = 5_000;
/** Absolute ceiling regardless of the dynamic calculation — "dynamic" means computed from the
 * target's measured behavior within a bounded envelope, never literally unbounded. */
const REGION_SEED_MAX_TOTAL_BUDGET_MS = 180_000;
/** Per-seed route cap for the separate-origin fallback fan-out — deliberately small; this is
 * enrichment on top of an already-complete primary crawl, not a full crawl of another site. */
const DEFAULT_CROSS_ORIGIN_SEED_MAX_ROUTES = 8;

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

    const primaryStart = Date.now();
    let crawlResult = await crawlWithAuth(browser, baseUrl, {
      ...input.crawlOptions,
      credentials: input.credentials,
    });
    // Calibration signal for every dynamically-sized budget below: this target's own measured
    // per-route cost (network speed, render cost, auth flow cost) predicts its future behavior
    // far better than any fixed constant could.
    const avgMsPerRoute = (Date.now() - primaryStart) / Math.max(1, crawlResult.visitedCount);

    const routing = detectRoutePrefix(baseUrl, crawlResult.routes);

    const seedsCrawled: { url: string; label?: string; routeCount: number }[] = [];

    const baseOrigin = (() => {
      try {
        return new URL(baseUrl).origin;
      } catch {
        return undefined;
      }
    })();
    const isSameOrigin = (url: string): boolean => {
      try {
        return new URL(url).origin === baseOrigin;
      } catch {
        return false;
      }
    };
    const sameOriginExtraSeeds = (input.extraSeedUrls ?? []).filter(isSameOrigin);
    const crossOriginExtraSeeds = (input.extraSeedUrls ?? []).filter((url) => !isSameOrigin(url));

    if ((input.knownRegionCodes && input.knownRegionCodes.length > 0) || sameOriginExtraSeeds.length > 0) {
      try {
        const derived = deriveRegionSeeds(routing, crawlResult, input.knownRegionCodes ?? []);
        const alreadyVisited = new Set(crawlResult.routes.map((r) => normalizeUrl(r.url)));
        const candidateSeeds = [...new Set([...derived, ...sameOriginExtraSeeds])].filter(
          (url) => !alreadyVisited.has(normalizeUrl(url)),
        );

        if (candidateSeeds.length > 0) {
          // perRegionMaxRoutes approximates "how many pages exist per locale" from how many
          // primary-region routes were actually crawled — an i18n SPA's route tree normally
          // mirrors 1:1 across regions, so this is a much better predictor than a flat constant.
          const primaryPrefixRouteCount = routing.invariantPrefix
            ? crawlResult.routes.filter((r) => r.url.includes(routing.invariantPrefix as string)).length
            : crawlResult.routes.length;
          const perRegionMaxRoutes = Math.max(1, primaryPrefixRouteCount);
          const perRegionBudgetMs = Math.max(
            REGION_SEED_MIN_BUDGET_MS,
            perRegionMaxRoutes * avgMsPerRoute * REGION_SEED_SAFETY_FACTOR,
          );
          const regionLabels = new Set(candidateSeeds.map((s) => regionCodeOf(s)).filter(Boolean));
          const regionCount = Math.max(1, regionLabels.size);
          const totalBudgetMs = Math.min(perRegionBudgetMs * regionCount, REGION_SEED_MAX_TOTAL_BUDGET_MS);

          const [firstSeed, ...restSeeds] = candidateSeeds;
          const regionCrawl = await crawl(browser, firstSeed, {
            seedRoutes: restSeeds,
            maxRoutes: perRegionMaxRoutes * regionCount + 1,
            wallClockBudgetMs: totalBudgetMs,
          });
          const role: 'anonymous' | 'authenticated' = crawlResult.authVerified
            ? 'authenticated'
            : 'anonymous';
          const labeledRoutes = regionCrawl.routes.map((r) => ({ ...r, seedLabel: regionCodeOf(r.url) }));
          crawlResult = {
            ...mergeCrawlResults(crawlResult, { ...regionCrawl, routes: labeledRoutes }, role),
            authAttempted: crawlResult.authAttempted,
            authVerified: crawlResult.authVerified,
            authReason: crawlResult.authReason,
            verifiedLogin: crawlResult.verifiedLogin,
          };

          const routeCountByLabel = new Map<string, number>();
          for (const r of labeledRoutes) {
            const label = r.seedLabel ?? 'unknown';
            routeCountByLabel.set(label, (routeCountByLabel.get(label) ?? 0) + 1);
          }
          for (const [label, routeCount] of routeCountByLabel) {
            seedsCrawled.push({ url: `${routing.invariantPrefix ?? ''}/${label}`, label, routeCount });
          }
          if (labeledRoutes.length > 0) {
            emit(
              'explore',
              'debug',
              `Region-seed fan-out found ${labeledRoutes.length} additional route(s) across ${routeCountByLabel.size} region(s) not reachable by link-following.`,
              {
                regions: [...routeCountByLabel.keys()],
                totalBudgetMs,
                budgetExhausted: regionCrawl.budgetExhausted,
              },
            );
          }
        }
      } catch (err) {
        emit('explore', 'debug', `Region-seed fan-out failed (continuing): ${errMsg(err)}`);
      }
    }

    if (crossOriginExtraSeeds.length > 0 && input.browserFactory) {
      try {
        const alreadyVisited = new Set(crawlResult.routes.map((r) => normalizeUrl(r.url)));
        const unvisited = crossOriginExtraSeeds.filter((url) => !alreadyVisited.has(normalizeUrl(url)));
        if (unvisited.length > 0) {
          // Pre-authenticates every fan-out seed from THIS session's cookies/localStorage
          // (Playwright's own recommended pattern for parallel-authenticated sessions) rather
          // than each seed running its own anonymous crawl and login attempt.
          const storageState = await browser.exportStorageState().catch(() => undefined);
          const fanOut = await crawlManySeeds(unvisited, input.browserFactory, storageState, {
            perSeedBudgetMs: Math.max(
              REGION_SEED_MIN_BUDGET_MS,
              DEFAULT_CROSS_ORIGIN_SEED_MAX_ROUTES * avgMsPerRoute * REGION_SEED_SAFETY_FACTOR,
            ),
            perSeedMaxRoutes: DEFAULT_CROSS_ORIGIN_SEED_MAX_ROUTES,
          });
          const role: 'anonymous' | 'authenticated' = crawlResult.authVerified
            ? 'authenticated'
            : 'anonymous';
          crawlResult = {
            ...mergeCrawlResults(crawlResult, fanOut, role),
            authAttempted: crawlResult.authAttempted,
            authVerified: crawlResult.authVerified,
            authReason: crawlResult.authReason,
            verifiedLogin: crawlResult.verifiedLogin,
          };

          const routeCountByOrigin = new Map<string, number>();
          for (const r of fanOut.routes) {
            const label = r.seedLabel ?? 'unknown';
            routeCountByOrigin.set(label, (routeCountByOrigin.get(label) ?? 0) + 1);
          }
          for (const [label, routeCount] of routeCountByOrigin) {
            seedsCrawled.push({ url: label, label, routeCount });
          }
          if (fanOut.routes.length > 0) {
            emit(
              'explore',
              'debug',
              `Separate-origin seed fan-out found ${fanOut.routes.length} additional route(s) across ${routeCountByOrigin.size} origin(s).`,
              { origins: [...routeCountByOrigin.keys()], budgetExhausted: fanOut.budgetExhausted },
            );
          }
        }
      } catch (err) {
        emit('explore', 'debug', `Separate-origin seed fan-out failed (continuing): ${errMsg(err)}`);
      }
    }

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
          const staticRouteCount = staticCrawl.routes.length;
          crawlResult = {
            ...mergeCrawlResults(crawlResult, staticCrawl, role),
            authAttempted: crawlResult.authAttempted,
            authVerified: crawlResult.authVerified,
            authReason: crawlResult.authReason,
            verifiedLogin: crawlResult.verifiedLogin,
          };
          if (staticRouteCount > 0) {
            emit(
              'explore',
              'debug',
              `Static-analysis route seeding found ${staticRouteCount} additional route(s) not reachable by link-following.`,
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
        unvisitedQueuedCount: crawlResult.unvisitedQueuedCount,
        shellCollapsed: crawlResult.shellCollapsed,
        redirectLoopsDetected: crawlResult.redirectLoopsDetected,
        routing,
      },
    );

    // A crawl that stopped while still holding known-but-unvisited routes has silently
    // truncated the inventory GENERATE grounds against — the difference between "explored
    // everything" and "explored what fit" is invisible in the route list alone, and a real run
    // shipped every Tier B spec as an ungrounded `test.fixme` with no indication why.
    const unvisitedQueuedCount = crawlResult.unvisitedQueuedCount ?? 0;
    if (unvisitedQueuedCount > 0) {
      emit(
        'explore',
        'warn',
        `Exploration budget ran out with ${unvisitedQueuedCount} discovered route(s) never visited — the inventory is incomplete, so generated tests may fall back to ungrounded placeholders. Raise the crawl budget (--crawl-budget-ms) to explore further.`,
        { unvisitedQueuedCount },
      );
    }

    // A route that couldn't be reliably reset after a click (see resetAfterProbe in crawler.ts /
    // docs/click-probe-reset-corruption.md) stops click-probing early on that route — distinct
    // from budgetExhausted/unvisitedQueuedCount, this means candidates were left unattempted
    // because the page got stuck, not because time ran out.
    const resetFailures = crawlResult.resetFailures ?? 0;
    if (resetFailures > 0) {
      emit(
        'explore',
        'warn',
        `Click-probing stopped early on ${resetFailures} route(s) because the page couldn't be reliably reset after a click — remaining candidates on those routes went unattempted.`,
        { resetFailures },
      );
    }

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
      seedsCrawled: seedsCrawled.length > 0 ? seedsCrawled : undefined,
    };
  } finally {
    if (unsubFrames) {
      try {
        unsubFrames();
      } catch {
        /* never let unsubscribe crash the run */
      }
    }
    if (input.onBeforeStop) {
      try {
        await input.onBeforeStop(browser);
      } catch (err) {
        emit('explore', 'debug', `onBeforeStop hook failed (continuing): ${errMsg(err)}`);
      }
    }
    await browser.stop().catch(() => undefined);
  }
}
