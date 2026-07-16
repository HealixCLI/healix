import path from 'node:path';
import { detect } from './detector.js';
import {
  extractExportedHandlers,
  extractNextRoutes,
  extractReactRouterRoutes,
  extractServerRoutes,
  RELEVANT_FRAMEWORKS_FOR_ROUTER,
  readSafe,
  SERVER_FRAMEWORKS,
  walkSourceFiles,
  type FunctionalityUnit,
} from './functionality-index.js';
import { extractReactRouterRoutesAst } from './ast/routes.js';
import { extractExpressRouterInfo, resolveExpressEndpoints } from './ast/endpoints.js';
import { extractFormsAst, type FormInfo } from './ast/forms.js';
import { extractAuthPatternsAst, type AuthPatternInfo } from './ast/auth-patterns.js';
import { extractSelectorHintsAst, type SelectorHint } from './ast/selectors.js';
import { extractMultiLangEndpoints } from './ast/multilang.js';
import { findSpecFiles, parseOpenApiSpec, parsePostmanCollection } from './spec-parser.js';
import type { SourceContext } from './source-context.js';

/** Hard cap on extracted units — mirrors functionality-index.ts's DEFAULT_MAX_UNITS. */
const DEFAULT_MAX_UNITS = 300;
const MULTILANG_EXTENSIONS = new Set(['.py', '.go', '.rb', '.php']);
const JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Build the full white-box static-analysis context for a repo: routes/endpoints (AST-based, with
 * a regex fallback per file when a file fails to parse), forms, auth patterns, and selector hints
 * from source, merged with OpenAPI/Swagger/Postman spec files (which are authoritative and
 * override a code-derived unit sharing the same key). This is the composed replacement for
 * functionality-index.ts's regex-only indexFunctionality — see that file's indexFunctionality,
 * which now delegates here for backward compatibility with existing callers.
 */
export async function indexSource(repoPath: string, opts?: { maxUnits?: number }): Promise<SourceContext> {
  const root = path.resolve(repoPath);
  const maxUnits = opts?.maxUnits ?? DEFAULT_MAX_UNITS;

  let framework: string | null = null;
  try {
    framework = (await detect(root)).framework;
  } catch {
    framework = null;
  }

  const { files, truncated: filesTruncated } = walkSourceFiles(root, 5000, {
    extraExtensions: MULTILANG_EXTENSIONS,
  });

  const isNext = framework === 'next';
  const wantsRouter = framework !== null && RELEVANT_FRAMEWORKS_FOR_ROUTER.has(framework);
  const isServer = framework !== null && SERVER_FRAMEWORKS.has(framework);

  const codeUnits: FunctionalityUnit[] = [];
  const forms: FormInfo[] = [];
  const authPatterns: AuthPatternInfo[] = [];
  const selectorHints: SelectorHint[] = [];

  const jsFiles = files.filter((f) => JS_EXTENSIONS.has(path.extname(f.rel).toLowerCase()));

  if (isServer || framework === null) {
    // Cross-file mount resolution needs every file's source up front (see ast/endpoints.ts).
    const withSource = jsFiles
      .map((f) => ({ rel: f.rel, source: readSafe(f.abs) }))
      .filter((f) => f.source.length > 0);
    codeUnits.push(...resolveExpressEndpoints(withSource));

    // Regex fallback ONLY for files resolveExpressEndpoints's AST pass couldn't parse — running
    // it unconditionally would duplicate every successfully mount-resolved endpoint under its
    // own unprefixed (and therefore wrong) key, since the two extractors produce different key
    // strings for the same route.
    for (const f of withSource) {
      if (extractExpressRouterInfo(f.source, f.rel) === null) {
        codeUnits.push(...extractServerRoutes(f.rel, f.source));
      }
    }
  }

  for (const f of jsFiles) {
    if (isNext) codeUnits.push(...extractNextRoutes(f.rel));

    const source = readSafe(f.abs);
    if (!source) continue;

    if (wantsRouter || framework === null) {
      const astRoutes = extractReactRouterRoutesAst(f.rel, source);
      codeUnits.push(...(astRoutes ?? extractReactRouterRoutes(f.rel, source)));
    }
    codeUnits.push(...extractExportedHandlers(f.rel, source));

    const formInfo = extractFormsAst(f.rel, source);
    if (formInfo) forms.push(...formInfo);

    const authInfo = extractAuthPatternsAst(f.rel, source);
    if (authInfo && (authInfo.libraries.length > 0 || authInfo.routeGuards.length > 0)) {
      authPatterns.push(authInfo);
    }

    const hints = extractSelectorHintsAst(f.rel, source);
    if (hints) selectorHints.push(...hints);
  }

  for (const f of files) {
    if (!MULTILANG_EXTENSIONS.has(path.extname(f.rel).toLowerCase())) continue;
    const source = readSafe(f.abs);
    if (!source) continue;
    codeUnits.push(...extractMultiLangEndpoints(f.rel, source));
  }

  const specUnits: FunctionalityUnit[] = [];
  const specSources: string[] = [];
  for (const specAbs of findSpecFiles(root)) {
    const rel = path.relative(root, specAbs).split(path.sep).join('/');
    const content = readSafe(specAbs);
    if (!content) continue;
    const isPostman = /\.postman_collection\.json$/i.test(rel);
    const parsed = isPostman ? parsePostmanCollection(content, rel) : parseOpenApiSpec(content, rel);
    if (parsed.length > 0) {
      specUnits.push(...parsed);
      specSources.push(rel);
    }
  }

  // Merge: code-derived units first-wins-deduped, then spec units always override — a spec is an
  // authoritative contract, not an inference, so it wins on any key collision.
  const byKey = new Map<string, FunctionalityUnit>();
  for (const u of codeUnits) if (!byKey.has(u.key)) byKey.set(u.key, u);
  for (const u of specUnits) byKey.set(u.key, u);

  let units = [...byKey.values()];
  let truncated = filesTruncated;
  if (units.length > maxUnits) {
    units = units.slice(0, maxUnits);
    truncated = true;
  }

  const routeCount = units.filter((u) => u.kind === 'route').length;
  const endpointCount = units.filter((u) => u.kind === 'endpoint').length;
  const summary =
    units.length === 0
      ? ''
      : `Detected functionality: ${routeCount} route(s), ${endpointCount} endpoint(s)${
          truncated ? ` (capped at ${maxUnits})` : ''
        }.`;

  return { units, forms, authPatterns, selectorHints, specSources, summary, truncated };
}
