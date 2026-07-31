import type { CrawlResult, RoutePrefixInfo } from './crawler.js';

/**
 * Regex for a plausible region/locale code token in free text (plan item titles/descriptions):
 * 2-3 uppercase letters on a word boundary. Deliberately permissive — this is a heuristic
 * last-resort fallback, not a source of truth (see `deriveRegionSeeds`'s `knownRegionCodes`
 * param for where a real, structured source — a project-config field, or static analysis of the
 * target's own i18n/locale config — should take priority once one exists).
 */
const REGION_CODE_TOKEN_RE = /\b[A-Z]{2,3}\b/g;

/**
 * Tokens that match REGION_CODE_TOKEN_RE by shape but are essentially never a region/locale code
 * in this context — filtered out of the plan-text fallback to cut down on obvious noise.
 */
const REGION_CODE_STOPWORDS = new Set([
  'ID',
  'OK',
  'URL',
  'API',
  'FAQ',
  'OTP',
  'SMS',
  'PDF',
  'CSS',
  'DOM',
  'UI',
  'UX',
]);

/**
 * Last-resort fallback when no structured region-code source is configured: scan plan item text
 * (titles, descriptions, requirement tags) for plausible region codes — e.g. a requirement that
 * literally names "CZ/HU home page copy". Heuristic and imprecise by nature; prefer a real
 * project-config field or static analysis of the target's i18n/locale config when either becomes
 * available.
 */
export function deriveRegionCodesFromText(texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(REGION_CODE_TOKEN_RE)) {
      const token = match[0];
      if (!REGION_CODE_STOPWORDS.has(token)) found.add(token);
    }
  }
  return [...found];
}

/**
 * Substitutes the detected region/locale prefix segment (e.g. `#/SK`) across every already-
 * visited route to derive candidate sibling-region URLs (e.g. `#/CZ/dashboard/vouchers`) — NOT a
 * DOM-sniffing pass. Live validation against a real target (a C&A loyalty SPA) found the only
 * region-looking DOM element was a plain link to an entirely different, off-origin domain — a
 * DOM scan would find nothing. But the sibling hash-route URLs resolve fine when navigated to
 * directly, and reuse the same authenticated session for free (same origin/page, just a
 * different hash), which is exactly what makes this substitution approach both simpler and
 * better-covering than a fresh anonymous crawl per region.
 *
 * Assumes what's normally true of an i18n SPA: the route tree mirrors 1:1 across regions, so the
 * routes already discovered for one region are a strong predictor of every sibling region's
 * shape. Returns an empty list whenever there isn't a real invariant prefix to substitute, or no
 * sibling codes to substitute in.
 */
export function deriveRegionSeeds(
  routing: RoutePrefixInfo,
  crawlResult: CrawlResult,
  knownRegionCodes: string[],
): string[] {
  if (!routing.hashRouted || !routing.invariantPrefix || knownRegionCodes.length === 0) {
    return [];
  }

  const prefixMatch = /^#\/([^/]+)/.exec(routing.invariantPrefix);
  const currentCode = prefixMatch?.[1];
  if (!currentCode) return [];

  const siblingCodes = knownRegionCodes.filter((code) => code !== currentCode);
  if (siblingCodes.length === 0) return [];

  const seeds = new Set<string>();
  for (const route of crawlResult.routes) {
    let url: URL;
    try {
      url = new URL(route.url);
    } catch {
      continue;
    }
    if (!url.hash.startsWith(routing.invariantPrefix)) continue;
    const rest = url.hash.slice(routing.invariantPrefix.length); // e.g. "/dashboard/vouchers"
    for (const code of siblingCodes) {
      const sibling = new URL(url.toString());
      sibling.hash = `#/${code}${rest}`;
      seeds.add(sibling.toString());
    }
  }
  return [...seeds];
}

/** Region code embedded in a hash-routed sibling-seed URL's first segment, e.g. "CZ" from
 * `https://x/#/CZ/dashboard` — used only to label a crawled route's provenance for diagnostics
 * (`CrawledRoute.seedLabel`), never for identity/dedup. */
export function regionCodeOf(url: string): string | undefined {
  try {
    return /^#\/([^/]+)/.exec(new URL(url).hash)?.[1];
  } catch {
    return undefined;
  }
}
