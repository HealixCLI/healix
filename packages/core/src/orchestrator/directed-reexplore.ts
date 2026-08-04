/**
 * Directed re-exploration for fixMe/escape-hatch gaps (docs/design/retry-pass-coverage-kb-redesign.md
 * is the sibling KB/retry-pass mechanism; see docs/design/retry-pass-coverage-kb-redesign.md's
 * companion doc for this mechanism's own design notes). When GENERATE can't find a real selector
 * for something a scenario needs, it emits an escape hatch (generate.ts's ESCAPE_HATCH_MARKER),
 * demoted to `test.fixme(...)`. Today that's a permanent dead end. This module resolves which
 * route each such gap belongs to, re-crawls ONLY that route more deeply, regenerates ONLY the
 * affected item(s), and merges the richer crawl data back in — bounded, always-on, fail-open.
 *
 * Deliberately separate from gap-fill.ts's EXPLORE-phase mechanism (proactive/content-coverage,
 * runs BEFORE generate) and the KB/retry-pass/coverage-feedback-loop (recovers generation/
 * execution FAILURES). This recovers items that generated and ran fine, but only by guessing.
 */
import {
  crawl,
  normalizeUrl,
  reconcileStaticRoutePaths,
  type CrawledRoute,
  type RoutePrefixInfo,
  type VerifiedLoginInfo,
} from '../browser/crawler.js';
import type { BrowserSurface } from '../browser/types.js';
import type { ProjectCredential } from '../storage/types.js';
import type { GeneratedSpec, TestMode, TestModeContext, TestPlan, TestPlanItem } from '../modes/types.js';
import { extractEscapeHatchReasons, forgetGenerateCheckpointEntries } from '../modes/playwright/generate.js';

/** One escape-hatch marker found in a generated spec, resolved (or not) to a route to re-crawl. */
export interface EscapeHatchGap {
  id: string;
  planItemId: string;
  testTitle: string;
  reason: string;
  /** Absolute URL this gap's unitKey resolved to via reconcileStaticRoutePaths — undefined
   *  (deliberately, never "every route") when it can't be resolved. */
  targetUrl?: string;
}

export interface DirectedReexploreResult {
  /** Input specs with regenerated entries spliced in (replace, never append). */
  specs: GeneratedSpec[];
  iterations: number;
  gapsClosed: number;
  gapsRemaining: number;
}

export const DIRECTED_REEXPLORE_MAX_ITERATIONS = 3;
export const DIRECTED_REEXPLORE_MAX_ROUTES_PER_ITERATION = 5;
export const DIRECTED_REEXPLORE_PER_ROUTE_BUDGET_MS = 60_000;
// Equal to crawler.ts's MAX_STATE_PROBES_PER_CRAWL — the entire normal per-crawl deep-probe pool
// goes to this one seeded route (maxRoutes: 1 below means pass1Routes always has exactly one
// entry, so the reverse-order deep-probe pass spends its whole budget on it).
export const DIRECTED_REEXPLORE_STATE_PROBE_BUDGET = 20;

/**
 * Picks a fallback re-crawl target for an item whose unitKey isn't `route:`-prefixed (it's
 * `endpoint:`-prefixed, or absent entirely) — the common shape for a UI-tier item whose plan
 * grounding fell back to a backend endpoint (e.g. a single-page app with no client-side router,
 * so there was no distinct frontend "route" to bind it to) or wasn't grounded against a
 * functionality index at all (a black-box/URL-only project). The item's escape hatch is still
 * about a UI element that lives SOMEWHERE, and for a `tierA-public`/`tierB-auth` item that
 * somewhere is whichever page already hosts that tier's content — the anonymous landing route, or
 * the authenticated one. Deliberately narrower than gap-fill.ts's "fall back to every route":
 * exactly one candidate per tier, never a broad, noisy target list. `tierC-api` items are never
 * given a fallback — a URL re-crawl can't ground a raw API endpoint's response shape.
 */
function fallbackTargetForTier(item: TestPlanItem, crawledRoutes: CrawledRoute[]): string | undefined {
  if (item.tier === 'tierC-api') return undefined;
  const preferredRole = item.tier === 'tierB-auth' ? 'authenticated' : 'anonymous';
  return (crawledRoutes.find((r) => r.role === preferredRole) ?? crawledRoutes[0])?.url;
}

/**
 * Resolves each escape-hatched spec's plan item to a target route URL, the same way
 * gap-fill.ts's identifyUnmetContentNeeds does (reconcileStaticRoutePaths on a `route:`-prefixed
 * unitKey) — but deliberately WITHOUT that function's fallback cascade (substring match, then
 * "every route" if even that fails). When there's no `route:`-prefixed unitKey to resolve at all,
 * falls back to the item's tier's already-crawled landing route (see fallbackTargetForTier) rather
 * than dropping the gap outright — a real, common case (see that function's doc comment). Only a
 * `tierC-api` item with no resolvable target is genuinely dropped.
 */
export function resolveGapTargets(
  specs: GeneratedSpec[],
  items: TestPlanItem[],
  routing: RoutePrefixInfo,
  baseUrl: string,
  crawledRoutes: CrawledRoute[] = [],
): EscapeHatchGap[] {
  const gaps: EscapeHatchGap[] = [];
  for (const spec of specs) {
    if (!spec.planItemId) continue;
    const reasons = extractEscapeHatchReasons(spec.contents);
    if (reasons.length === 0) continue;
    const item = items.find((it) => it.id === spec.planItemId);
    if (!item) continue;

    let targetUrl: string | undefined;
    if (item.unitKey?.startsWith('route:')) {
      const path = item.unitKey.replace(/^route:/, '');
      [targetUrl] = reconcileStaticRoutePaths([path], routing, baseUrl);
    }
    if (!targetUrl) {
      targetUrl = fallbackTargetForTier(item, crawledRoutes);
    }

    reasons.forEach((r, i) => {
      gaps.push({
        id: `escape:${item.id}:${i}`,
        planItemId: item.id,
        testTitle: r.testTitle,
        reason: r.reason,
        targetUrl,
      });
    });
  }
  return gaps;
}

/** Collapses gaps resolving to the same normalized URL into one crawl target. */
export function dedupGapTargetUrls(gaps: EscapeHatchGap[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const g of gaps) {
    if (!g.targetUrl) continue;
    const key = normalizeUrl(g.targetUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(g.targetUrl);
  }
  return urls;
}

/**
 * Replays a login already PROVEN to work during EXPLORE (ctx.exploration.crawl.verifiedLogin),
 * rather than re-discovering a login candidate from scratch (crawlWithAuth's own anonymous-crawl
 * search) — cheaper, and more reliable since this exact login already succeeded once this run.
 */
async function replayVerifiedLogin(
  browser: BrowserSurface,
  login: VerifiedLoginInfo,
  credential: ProjectCredential,
): Promise<void> {
  await browser.goto(login.pageUrl);
  if (login.toggleSelector) await browser.click(login.toggleSelector);
  await browser.type(login.identifierSelector, credential.username);
  await browser.type(login.passwordSelector, credential.password);
  if (login.submitSelector) {
    await browser.click(login.submitSelector);
  } else {
    await browser.pressKey('Enter');
  }
}

/**
 * Deep-probes exactly ONE route: `maxRoutes: 1` means crawl()'s BFS visits only `targetUrl`
 * (queue.shift() dequeues it first and the loop breaks immediately after), so the reverse-order
 * deep-probe pass (crawler.ts's GAP-060 restructuring) always has a single-element pass1Routes —
 * the full stateProbeBudget necessarily goes to this one route, never starved by any other.
 */
async function reCrawlOneRoute(
  ctx: TestModeContext,
  targetUrl: string,
  needsAuth: boolean,
): Promise<CrawledRoute | undefined> {
  if (needsAuth) {
    const verifiedLogin = ctx.exploration?.crawl.verifiedLogin;
    const credential = ctx.credentials?.find((c) => c.role === null) ?? ctx.credentials?.[0];
    if (verifiedLogin && credential) {
      await replayVerifiedLogin(ctx.browser, verifiedLogin, credential);
    }
    // No verified login on record: proceed anonymously anyway (best-effort, fail-open) — the
    // deep-probe may simply find less than it would have post-login.
  }
  const result = await crawl(ctx.browser, targetUrl, {
    maxRoutes: 1,
    wallClockBudgetMs: DIRECTED_REEXPLORE_PER_ROUTE_BUDGET_MS,
    stateProbeBudget: DIRECTED_REEXPLORE_STATE_PROBE_BUDGET,
  });
  // maxRoutes: 1 means at most one route was ever visited — no need to search for it.
  return result.routes[0];
}

export interface DirectedReexploreParams {
  ctx: TestModeContext;
  mode: TestMode;
  plan: TestPlan;
  specs: GeneratedSpec[];
  routing: RoutePrefixInfo;
  baseUrl: string;
  forgetCheckpointEntries?: (projectDir: string, itemIds: ReadonlySet<string>) => Promise<void>;
  reregisterSpecRows: (spec: GeneratedSpec, items: TestPlanItem[]) => void;
  emit: (phase: string, level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns the whole bounded loop: resolve gaps -> re-crawl only the implicated route(s) -> merge ->
 * regenerate only the affected item(s) -> reregister DB rows -> re-check -> repeat until a
 * terminating condition fires. Never throws: any internal failure degrades to a warn-level emit
 * and returns `specs` as far as it got.
 */
export async function runDirectedReexplore(
  params: DirectedReexploreParams,
): Promise<DirectedReexploreResult> {
  const {
    ctx,
    mode,
    plan,
    routing,
    baseUrl,
    emit,
    reregisterSpecRows,
    forgetCheckpointEntries = forgetGenerateCheckpointEntries,
  } = params;
  let specs = params.specs;
  let iteration = 0;
  let gapsClosedTotal = 0;
  let browserStarted = false;

  try {
    for (;;) {
      if (iteration >= DIRECTED_REEXPLORE_MAX_ITERATIONS) break;

      const gaps = resolveGapTargets(specs, plan.items, routing, baseUrl, ctx.exploration?.crawl.routes);
      const targetable = gaps.filter((g): g is EscapeHatchGap & { targetUrl: string } => !!g.targetUrl);
      if (targetable.length === 0) break; // nothing left to chase (covers "no gaps" and "nothing resolvable")

      iteration += 1;
      const targetUrls = dedupGapTargetUrls(targetable).slice(0, DIRECTED_REEXPLORE_MAX_ROUTES_PER_ITERATION);
      emit(
        'generate',
        'info',
        `Directed re-exploration iteration ${iteration}/${DIRECTED_REEXPLORE_MAX_ITERATIONS}: re-crawling ${targetUrls.length} route(s) for ${targetable.length} unresolved-selector gap(s).`,
      );

      if (!browserStarted) {
        await ctx.browser.start({ headless: true, baseUrl });
        browserStarted = true;
      }

      // Only items whose gap resolved to a URL actually re-crawled THIS iteration (i.e. survived
      // the route cap AND the crawl itself succeeding) get regenerated — never the full
      // `targetable` set, which may hold more distinct routes than this iteration's cap allows.
      const mergedUrls = new Set<string>();
      for (const targetUrl of targetUrls) {
        try {
          const needsAuth = targetable.some(
            (g) =>
              normalizeUrl(g.targetUrl) === normalizeUrl(targetUrl) &&
              plan.items.find((it) => it.id === g.planItemId)?.tier === 'tierB-auth',
          );
          const rich = await reCrawlOneRoute(ctx, targetUrl, needsAuth);
          if (rich && ctx.exploration) {
            const mergedRoutes = [...ctx.exploration.crawl.routes];
            // The crawl's OWN resolved URL (rich.url, post-redirect) is the right match key — a
            // route that redirects (e.g. a trailing-slash/locale normalization) would otherwise
            // never match the pre-redirect `targetUrl`, leaving the stale thin entry in place
            // AND pushing a second, duplicate rich one alongside it. Falls back to `targetUrl`
            // itself only if no entry matches the resolved URL, so the originally-thin entry
            // that triggered this re-crawl still gets replaced rather than duplicated.
            const richKey = normalizeUrl(rich.url);
            const targetKey = normalizeUrl(targetUrl);
            let idx = mergedRoutes.findIndex((r) => normalizeUrl(r.url) === richKey);
            if (idx < 0 && richKey !== targetKey) {
              idx = mergedRoutes.findIndex((r) => normalizeUrl(r.url) === targetKey);
            }
            if (idx >= 0) mergedRoutes[idx] = rich;
            else mergedRoutes.push(rich);
            // Reassigns ctx.exploration/ctx.exploration.crawl to NEW objects, but spreads every
            // existing field (verifiedLogin/authAttempted/authReason/loginCandidates/etc.) so
            // nothing execute.ts reads later (lines 137-138: crawl.verifiedLogin, loginCandidates)
            // changes value — only `routes` is overridden.
            ctx.exploration = {
              ...ctx.exploration,
              crawl: { ...ctx.exploration.crawl, routes: mergedRoutes },
            };
            mergedUrls.add(normalizeUrl(targetUrl));
          }
        } catch (err) {
          emit(
            'generate',
            'warn',
            `Directed re-exploration crawl failed for ${targetUrl} (continuing): ${errMsg(err)}`,
          );
        }
      }
      if (mergedUrls.size === 0) break; // no forward progress possible this iteration

      const affectedIds = new Set(
        targetable.filter((g) => mergedUrls.has(normalizeUrl(g.targetUrl))).map((g) => g.planItemId),
      );
      const affectedItems = plan.items.filter((it) => affectedIds.has(it.id));
      if (affectedItems.length === 0) break;

      await forgetCheckpointEntries(ctx.projectDir, affectedIds);

      let regenerated: GeneratedSpec[];
      try {
        regenerated = await mode.generate(ctx, { ...plan, items: affectedItems });
      } catch (err) {
        emit('generate', 'warn', `Directed re-exploration regeneration failed (stopping): ${errMsg(err)}`);
        break;
      }
      if (regenerated.length === 0) break;

      const validation = mode.validate
        ? await mode.validate(ctx, regenerated)
        : { ok: regenerated, repaired: [], quarantined: [], warnings: [] };
      const contentsByPath = new Map(
        [...validation.ok, ...validation.repaired].map((s) => [s.path, s.contents]),
      );
      const accepted = regenerated.flatMap((s) =>
        contentsByPath.has(s.path) ? [{ ...s, contents: contentsByPath.get(s.path)! }] : [],
      );
      if (accepted.length === 0) {
        emit(
          'generate',
          'warn',
          'Directed re-exploration: all regenerated spec(s) failed validation; stopping.',
        );
        break;
      }

      // Replace, never append: EXECUTE runs moments later against this exact `specs` array, so a
      // duplicate entry for the same item would execute the same scenario twice.
      const byItemId = new Map(accepted.filter((s) => s.planItemId).map((s) => [s.planItemId!, s]));
      specs = specs.filter((s) => !s.planItemId || !byItemId.has(s.planItemId)).concat(accepted);

      for (const spec of accepted) {
        try {
          reregisterSpecRows(spec, affectedItems);
        } catch (err) {
          emit(
            'generate',
            'warn',
            `Directed re-exploration: failed to update DB row(s) for ${spec.path}: ${errMsg(err)}`,
          );
        }
      }

      const stillGapped = new Set(
        resolveGapTargets(accepted, affectedItems, routing, baseUrl, ctx.exploration?.crawl.routes).map(
          (g) => g.planItemId,
        ),
      );
      const closed = affectedItems.filter((it) => !stillGapped.has(it.id)).length;
      gapsClosedTotal += closed;
      emit(
        'generate',
        'info',
        `Directed re-exploration iteration ${iteration}: closed ${closed}/${affectedItems.length} gap(s).`,
      );
      if (closed === 0) break; // no forward progress — mirrors the coverage loop's own break
    }
  } catch (err) {
    emit('generate', 'warn', `Directed re-exploration failed (continuing without it): ${errMsg(err)}`);
  } finally {
    if (browserStarted) await ctx.browser.stop().catch(() => undefined);
  }

  return {
    specs,
    iterations: iteration,
    gapsClosed: gapsClosedTotal,
    gapsRemaining: resolveGapTargets(specs, plan.items, routing, baseUrl, ctx.exploration?.crawl.routes)
      .length,
  };
}
