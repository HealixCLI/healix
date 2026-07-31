import { redactSecrets } from '../export/sanitize.js';
import { normalizeEndpointPath } from '../target/dependencies.js';
import type { CrawlWithAuthResult } from './crawler.js';

/** One (method, path) endpoint actually observed on the wire during EXPLORE's crawl —
 * real ground truth, as opposed to `target/dependencies.ts`'s statically-inferred
 * `EndpointMock`. See GAP-046. */
export interface ObservedEndpoint {
  method: string;
  /** Normalized the same way `target/dependencies.ts` normalizes statically-extracted
   * paths, so the two sources can be matched/merged (see `normalizeEndpointPath`). */
  pathPattern: string;
  status: number;
  sampleResponseBody?: string;
  /** The request's real hostname (`URL.host`, includes port when non-default) — lets a
   * multi-dependency run attribute an observed call to the specific dependency it belongs
   * to, instead of collapsing to one dependency-wide mock (see scaffold.ts's mockRouteEntries). */
  host?: string;
  /** The response's real `content-type`, when captured — lets the runtime mock built from
   * this endpoint serve back the real content-type instead of always defaulting to
   * application/json (GAP-063 follow-up; see scaffold.ts's mergedEndpoints). */
  contentType?: string;
}

/** Mirrors `target/dependencies.ts`'s MAX_ENDPOINTS_PER_DEP — same order of magnitude,
 * same reasoning: bound prompt/storage size on a chatty app. */
const MAX_OBSERVED_ENDPOINTS = 40;

/** Path segments matching this shape are runtime values (numeric ids, UUIDs, long
 * opaque tokens), not part of the endpoint's identity — collapse them to `:param`
 * so `/customer/123/profile` and `/customer/456/profile` count as one endpoint,
 * matching the placeholder convention `normalizeEndpointPath` already uses for
 * statically-extracted template-literal paths. */
const DYNAMIC_SEGMENT_RE =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/** Reduce a captured request's full URL to a normalized, comparable path pattern:
 * strip origin/query/hash, collapse dynamic segments, then run the result through
 * `normalizeEndpointPath` for parity with the static-analysis side (harmless no-op
 * here since real URLs never contain `${...}` template syntax). */
function normalizeObservedUrl(rawUrl: string): { pathPattern: string; host: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const normalized = parsed.pathname
    .split('/')
    .map((segment) => (DYNAMIC_SEGMENT_RE.test(segment) ? ':param' : segment))
    .join('/');
  return { pathPattern: normalizeEndpointPath(normalized), host: parsed.host };
}

/**
 * Aggregate every route's captured `networkEvents` from a crawl into a deduped,
 * redacted, size-capped list of endpoints actually observed on the wire — the
 * real-traffic counterpart to `target/dependencies.ts`'s static endpoint scan.
 * Feeds `formatMockContent()`/`findUngroundedReferences()` in
 * `modes/playwright/generate.ts` as additional, higher-trust mock-endpoint ground
 * truth (see GAP-046).
 */
export function collectObservedEndpoints(crawl: CrawlWithAuthResult): ObservedEndpoint[] {
  const seen = new Set<string>();
  const observed: ObservedEndpoint[] = [];

  outer: for (const route of crawl.routes) {
    for (const event of route.networkEvents) {
      const normalized = normalizeObservedUrl(event.url);
      if (!normalized) continue;
      const { pathPattern, host } = normalized;
      const method = event.method.toUpperCase();
      const key = `${method} ${pathPattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      observed.push({
        method,
        pathPattern,
        status: event.status,
        sampleResponseBody: event.responseBody ? redactSecrets(event.responseBody) : undefined,
        host,
        contentType: event.contentType,
      });
      if (observed.length >= MAX_OBSERVED_ENDPOINTS) break outer;
    }
  }

  return observed;
}
