import {
  crawlWithAuth,
  detectRoutePrefix,
  scoreLoginCandidates,
  type CrawlOptions,
  type CrawlWithAuthResult,
} from '../browser/crawler.js';
import type { BrowserSurface } from '../browser/types.js';
import type { ExplorationArtifact } from '../modes/types.js';
import type { OrchestratorEvent } from './types.js';

export interface ExploreInput {
  browser: BrowserSurface;
  baseUrl: string;
  credentials?: { username: string; password: string };
  crawlOptions?: CrawlOptions;
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void;
  onFrame?: (png: Buffer) => void;
}

/** Bounded best-effort wait for the frame mirror's first capture before teardown. */
const FIRST_FRAME_WAIT_MS = 600;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A login-only or near-empty single route is explicitly NOT "useful context"
 * — generation would be no better grounded than with no exploration at all.
 * Never blocks the run; callers surface the reason as a breadcrumb instead.
 */
export function assessExplorationUsefulness(result: CrawlWithAuthResult): { useful: boolean; reason?: string } {
  if (result.routes.length === 0) {
    return { useful: false, reason: 'exploration crawled zero routes' };
  }
  const totalElements = result.routes.reduce((sum, r) => sum + r.snapshot.interactiveElements.length, 0);
  if (result.routes.length <= 1 && totalElements < 5) {
    return { useful: false, reason: 'only a single thin route was crawled (login-only or near-empty shell)' };
  }
  if (result.shellCollapsed) {
    return { useful: false, reason: 'crawled routes render a near-identical DOM (single-shell SPA collapse)' };
  }
  return { useful: true };
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

    const crawlResult = await crawlWithAuth(browser, baseUrl, {
      ...input.crawlOptions,
      credentials: input.credentials,
    });

    const routing = detectRoutePrefix(baseUrl, crawlResult.routes);
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

    if (!quality.useful) {
      // Breadcrumb only — thin/empty context must never abort the run, it
      // just means GENERATE will lean more on guessing than grounding.
      emit('explore', 'warn', `Exploration produced thin context: ${quality.reason}`, {
        visitedCount: crawlResult.visitedCount,
        shellCollapsed: crawlResult.shellCollapsed,
      });
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
