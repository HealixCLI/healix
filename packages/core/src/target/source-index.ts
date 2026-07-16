import path from 'node:path';
import type { File } from '@babel/types';
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
import { parseModule } from './ast/parse.js';
import { extractReactRouterRoutesFromAst } from './ast/routes.js';
import {
  extractExpressRouterInfoFromAst,
  resolveExpressEndpointsFromInfo,
  type FileRouterInfo,
} from './ast/endpoints.js';
import { extractFormsFromAst, type FormInfo } from './ast/forms.js';
import { extractAuthPatternsFromAst, type AuthPatternInfo } from './ast/auth-patterns.js';
import { extractSelectorHintsFromAst, type SelectorHint } from './ast/selectors.js';
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
 *
 * Each JS/TS file is parsed to an AST at most ONCE (see `parseModule` below) and that single AST
 * is shared across routes/express/forms/auth/selectors extraction — an earlier version called
 * each extractor's own source-parsing wrapper independently, re-parsing the same file up to five
 * times, which measurably slowed a real orchestrator run down (surfaced by a test regression
 * during Item E1's wiring, not a hypothetical concern).
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
  const expressInfoByFile = new Map<string, FileRouterInfo>();

  const jsFiles = files.filter((f) => JS_EXTENSIONS.has(path.extname(f.rel).toLowerCase()));

  for (const f of jsFiles) {
    const source = readSafe(f.abs);
    if (!source) continue;

    if (isNext) codeUnits.push(...extractNextRoutes(f.rel));

    // Parsed once, shared across every AST-based extractor below; null on parse failure lets
    // each concern fall back independently (route/express extractors have a regex fallback,
    // forms/auth-patterns/selector-hints do not and simply skip the file).
    const ast: File | null = parseModule(source, f.rel);

    if (wantsRouter || framework === null) {
      codeUnits.push(
        ...(ast ? extractReactRouterRoutesFromAst(f.rel, ast) : extractReactRouterRoutes(f.rel, source)),
      );
    }

    if (isServer || framework === null) {
      if (ast) {
        expressInfoByFile.set(f.rel, extractExpressRouterInfoFromAst(ast));
      } else {
        codeUnits.push(...extractServerRoutes(f.rel, source));
      }
    }

    codeUnits.push(...extractExportedHandlers(f.rel, source));

    if (ast) {
      forms.push(...extractFormsFromAst(f.rel, ast));
      const authInfo = extractAuthPatternsFromAst(f.rel, ast);
      if (authInfo.libraries.length > 0 || authInfo.routeGuards.length > 0) authPatterns.push(authInfo);
      selectorHints.push(...extractSelectorHintsFromAst(f.rel, ast));
    }
  }

  if (isServer || framework === null) {
    codeUnits.push(...resolveExpressEndpointsFromInfo(expressInfoByFile));
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
