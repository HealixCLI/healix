/**
 * Static extraction of a target app's own supported region/locale codes from its source, so
 * exploration's region-seed fan-out (browser/seed-discovery.ts's `deriveRegionSeeds`) has a real
 * source of truth instead of relying solely on `deriveRegionCodesFromText`'s free-text scan of
 * plan-item titles (orchestrator/index.ts).
 *
 * Root cause this addresses (§6.3 of docs/c-and-a-exploration-gap-analysis.md): a PRD/plan whose
 * text only ever literally names the region under test (e.g. "SK") never surfaces sibling region
 * codes the app genuinely supports (CZ/HU/HR/...), even though the app's own i18n config lists
 * them plainly. Confirmed via direct source read that no such extraction exists anywhere under
 * `packages/core/src/target/` today.
 *
 * Deliberately a lightweight scan over raw source text, matching this codebase's existing
 * heuristic-extractor style (functionality-index.ts's `extractReactRouterRoutes`,
 * `deriveRegionCodesFromText` itself) rather than a full AST walk. A plain regex window was tried
 * first and rejected: a real region registry commonly nests per-region metadata
 * (`SK: { currency: 'EUR', locale: 'sk-SK' }`), and a blind window match picks up "EUR" as a false
 * region code too. Bracket-depth tracking (below) is the minimum needed to stay at the top level of
 * the declared container without a real parser.
 */

/**
 * Matches an exported identifier that looks like a region/locale registry — e.g.
 * `export const REGIONS = {`, `export const SUPPORTED_REGIONS = [`, `export enum RegionCode {`.
 */
const REGION_REGISTRY_DECL_RE =
  /export\s+(?:const|enum)\s+\w*(?:REGIONS?|REGION_CODES?|LOCALES?|SUPPORTED_REGIONS?)\w*\b/gi;

/**
 * A quoted or bare 2-3 letter uppercase token — the shape a region/locale code takes as an object
 * key (`SK:`), array element (`'SK'`), or enum member (`SK =`). The `\b` word-boundary on BOTH
 * sides is load-bearing: matched against the FULL source string (never a substring/slice — `\b`
 * has no notion of "before position i" when applied to `str.slice(i, ...)`, since the engine sees
 * only what's inside the slice), it's what stops "REG"/"ION"/"CON"/"FIG" from being read out of a
 * longer SCREAMING_SNAKE_CASE identifier like `REGION_CONFIG` sitting in the same scanned window —
 * confirmed live: an earlier version of this regex had no boundary check at all and fragmented
 * exactly that shape of identifier into spurious 2-3 letter "codes".
 */
const REGION_TOKEN_RE = /['"]?\b([A-Z]{2,3})\b['"]?/g;

/** Same stopword rationale as `deriveRegionCodesFromText` in browser/seed-discovery.ts — shapes
 * that match by pattern but are essentially never a region/locale code in this context. */
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

/** How far past a registry declaration to look for its opening bracket, and how far past that to
 * scan its body — generous enough for a real region list (dozens of entries) without risking
 * runaway work on a large file. */
const DECL_TO_OPEN_WINDOW_CHARS = 200;
const BODY_SCAN_WINDOW_CHARS = 4000;

/**
 * Extracts top-level entry names from a `{...}`/`[...]` body (already stripped of its own
 * enclosing brackets), skipping anything nested inside a deeper `{[(`...`)]}` — that's what keeps
 * a region's own nested metadata (currency/locale codes) from being misread as sibling regions.
 *
 * Two independent passes over `body`, then joined by position: a bracket-depth map (what nesting
 * level each character sits at) and a `\b`-bounded token scan (see `REGION_TOKEN_RE`'s doc comment
 * for why this must run against the whole string, not a per-position slice) — a match only counts
 * when its start position sits at depth 0.
 */
function extractTopLevelTokens(body: string): string[] {
  const depthAt = new Array<number>(body.length);
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    depthAt[i] = depth;
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
  }

  const found: string[] = [];
  for (const m of body.matchAll(REGION_TOKEN_RE)) {
    if (depthAt[m.index] === 0) found.push(m[1]);
  }
  return found;
}

/**
 * Scans one source file's text for a region/locale registry declaration and extracts its top-level
 * member codes. Returns an empty array when the file doesn't look like an i18n/region config —
 * callers should accumulate across every file in the repo and dedupe, exactly like `codeUnits`
 * accumulates across files in source-index.ts's `indexSource`.
 */
export function detectStaticRegionCodes(source: string): string[] {
  const found = new Set<string>();
  for (const declMatch of source.matchAll(REGION_REGISTRY_DECL_RE)) {
    const afterDecl = declMatch.index + declMatch[0].length;
    const lookahead = source.slice(afterDecl, afterDecl + DECL_TO_OPEN_WINDOW_CHARS);
    const openMatch = /[{[]/.exec(lookahead);
    if (!openMatch) continue; // a type-only declaration or one that never opens a container
    const openIdx = afterDecl + openMatch.index;
    const body = source.slice(openIdx + 1, openIdx + 1 + BODY_SCAN_WINDOW_CHARS);
    for (const token of extractTopLevelTokens(body)) {
      if (!REGION_CODE_STOPWORDS.has(token)) found.add(token);
    }
  }
  return [...found];
}
