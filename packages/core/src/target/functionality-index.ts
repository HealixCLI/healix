import fs from 'node:fs';
import path from 'node:path';

export type FunctionalityUnitKind = 'route' | 'endpoint' | 'component';

/**
 * Where a unit's data came from — used to resolve precedence when the same key is produced by
 * more than one extractor (a spec is authoritative and wins over code-derived inference).
 */
export type FunctionalityUnitProvenance = 'code' | 'spec' | 'inferred';

export interface FunctionalityUnit {
  /** Stable identity for coverage matching, e.g. "route:/checkout" or "endpoint:POST /api/orders". */
  key: string;
  kind: FunctionalityUnitKind;
  /** Human-readable label for prompts/UIs, e.g. "GET /api/orders" or "page: /checkout". */
  label: string;
  file: string;
  /** Defaults to 'code' at every existing call site; only spec-parser.ts sets 'spec'. */
  provenance?: FunctionalityUnitProvenance;
  /** HTTP method, when known independently of `label`/`key` parsing (spec-derived units). */
  method?: string;
  /** Authoritative request schema (e.g. from an OpenAPI/Postman spec), opaque JSON-Schema-ish shape. */
  requestSchema?: unknown;
  /** Authoritative response schema, same provenance as requestSchema. */
  responseSchema?: unknown;
  /** Whether this endpoint/route requires auth, when derivable from a spec's security scheme. */
  authRequired?: boolean;
  /** Distinct HTTP status codes this unit's handler body explicitly sets — see target/ast/handler-signals.ts. Populated only by the post-approve deep-dive pass (target/deep-dive.ts), scoped to approved plan items; absent otherwise. */
  observedStatusCodes?: number[];
  /** Distinct thrown-error messages from this unit's handler body — same deep-dive-only provenance as observedStatusCodes. */
  thrownErrorMessages?: string[];
  /** Name of a detected route-guard wrapper component (ROUTE_GUARD_NAME_RE) gating this route or
   * an ancestor in its nesting chain — only ever set by target/ast/routes.ts's React Router
   * extractors (see Cluster C). Undefined for every other extractor/kind. */
  authGuardName?: string;
}

export interface FunctionalityIndex {
  units: FunctionalityUnit[];
  truncated: boolean;
  /** Short natural-language summary for prompt grounding. */
  summary: string;
}

/**
 * Rough estimate of how many scenarios a unit will contribute to a plan-generation
 * response, used by the orchestrator to size planning batches by expected output
 * volume rather than raw unit count (see PLAN_BATCH_WEIGHT_BUDGET in orchestrator/index.ts).
 * A plain route with no known schema/auth is assumed to need the fewest scenarios;
 * endpoints and spec-derived units with request/response schemas or auth requirements
 * tend to warrant more negative/edge cases (validation failures, auth failures), so
 * each such signal bumps the estimate.
 */
export function estimateUnitWeight(u: FunctionalityUnit): number {
  let w = 2;
  if (u.kind === 'endpoint') w += 1;
  if (u.requestSchema) w += 1;
  if (u.responseSchema) w += 1;
  if (u.authRequired) w += 1;
  return w;
}

const SKIP_DIRS = new Set<string>([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.cache',
  '.parcel-cache',
  '.vercel',
  '.output',
  'out',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.idea',
  '.vscode',
  'target',
  'vendor',
]);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export interface WalkFile {
  abs: string;
  rel: string;
}

/**
 * Iterative BFS walk collecting source files, same traversal shape as repo-index.ts's walk().
 * Exported for source-index.ts's composed walk, which passes `extraExtensions` to also pick up
 * non-JS backend files (.py/.go/.rb/.php) for the multi-lang regex fallback — indexFunctionality
 * itself never passes this, so its own JS/TS-only behavior is unchanged.
 */
export function walkSourceFiles(
  root: string,
  hardCap: number,
  opts?: { extraExtensions?: Set<string> },
): { files: WalkFile[]; truncated: boolean } {
  const files: WalkFile[] = [];
  let truncated = false;
  const queue: string[] = [root];

  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const subDirs: string[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (name.startsWith('.') && name !== '.github') continue;
        subDirs.push(path.join(dir, name));
        continue;
      }

      if (!entry.isFile()) continue;
      if (files.length >= hardCap) {
        truncated = true;
        break;
      }

      const ext = path.extname(name).toLowerCase();
      if (!SOURCE_EXT.has(ext) && !opts?.extraExtensions?.has(ext)) continue;

      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      files.push({ abs, rel });
    }

    if (files.length >= hardCap) {
      truncated = true;
      break;
    }
    for (const sub of subDirs) queue.push(sub);
  }

  return { files, truncated };
}

/** Exported for source-index.ts's AST-fallback path. */
export function readSafe(abs: string): string {
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return '';
  }
}

/** Next.js file-based routing: pages/**\/*.tsx (excluding _app/_document/api) and app/**\/page.tsx, plus app/**\/route.ts as endpoints. Exported: reused as-is by source-index.ts (file-convention, no AST needed). */
export function extractNextRoutes(rel: string): FunctionalityUnit[] {
  const units: FunctionalityUnit[] = [];
  const isPagesRoute =
    /^pages\//.test(rel) &&
    !/^pages\/api\//.test(rel) &&
    !/\/(_app|_document|_error)\.[jt]sx?$/.test(rel) &&
    /\.(tsx|jsx|ts|js)$/.test(rel);
  if (isPagesRoute) {
    const routePath = toNextPagesRoutePath(rel);
    units.push({ key: `route:${routePath}`, kind: 'route', label: `page: ${routePath}`, file: rel });
  }

  if (/^pages\/api\//.test(rel)) {
    const routePath = toNextPagesRoutePath(rel);
    units.push({
      key: `endpoint:${routePath}`,
      kind: 'endpoint',
      label: `api route: ${routePath}`,
      file: rel,
    });
  }

  if (/^app\//.test(rel) && /\/page\.(tsx|jsx|ts|js)$/.test(rel)) {
    const routePath = toNextAppRoutePath(rel, 'page');
    units.push({ key: `route:${routePath}`, kind: 'route', label: `page: ${routePath}`, file: rel });
  }

  if (/^app\//.test(rel) && /\/route\.(ts|js)$/.test(rel)) {
    const routePath = toNextAppRoutePath(rel, 'route');
    units.push({
      key: `endpoint:${routePath}`,
      kind: 'endpoint',
      label: `api route: ${routePath}`,
      file: rel,
    });
  }

  return units;
}

function toNextPagesRoutePath(rel: string): string {
  let p = rel.replace(/^pages\//, '/').replace(/\.(tsx|jsx|ts|js)$/, '');
  p = p.replace(/\/index$/, '') || '/';
  return p;
}

function toNextAppRoutePath(rel: string, leaf: 'page' | 'route'): string {
  let p = rel.replace(/^app\//, '/').replace(new RegExp(`/${leaf}\\.(tsx|jsx|ts|js)$`), '');
  // Strip Next.js route groups like (marketing).
  p = p
    .split('/')
    .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')')))
    .join('/');
  return p || '/';
}

/** React Router: <Route path="..."> JSX and createBrowserRouter/createRoutesFromElements object literals. Exported: source-index.ts's fallback when extractReactRouterRoutesAst fails to parse a file. */
export function extractReactRouterRoutes(rel: string, source: string): FunctionalityUnit[] {
  const units: FunctionalityUnit[] = [];
  const jsxRouteRe = /<Route\b[^>]*\bpath\s*=\s*(["'`])([^"'`]*)\1/g;
  for (const m of source.matchAll(jsxRouteRe)) {
    const routePath = m[2];
    units.push({ key: `route:${routePath}`, kind: 'route', label: `route: ${routePath}`, file: rel });
  }

  const objRouteRe = /\bpath\s*:\s*(["'`])([^"'`]*)\1/g;
  for (const m of source.matchAll(objRouteRe)) {
    const routePath = m[2];
    units.push({ key: `route:${routePath}`, kind: 'route', label: `route: ${routePath}`, file: rel });
  }

  return units;
}

/** Express/Fastify/Koa: app.get/post/... and router.get/post/... registrations. Exported: source-index.ts runs this alongside the AST-based, mount-resolving resolveExpressEndpoints as a supplementary safety net. */
export function extractServerRoutes(rel: string, source: string): FunctionalityUnit[] {
  const units: FunctionalityUnit[] = [];
  const re = /\b(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|options)\s*\(\s*(["'`])([^"'`]*)\2/gi;
  for (const m of source.matchAll(re)) {
    const method = m[1].toUpperCase();
    const routePath = m[3];
    units.push({
      key: `endpoint:${method} ${routePath}`,
      kind: 'endpoint',
      label: `${method} ${routePath}`,
      file: rel,
    });
  }
  return units;
}

/** Exported Next.js-style route handlers: `export function GET(...)` / `export default async function handler(...)`. Exported for source-index.ts's composed extraction. */
export function extractExportedHandlers(rel: string, source: string): FunctionalityUnit[] {
  const units: FunctionalityUnit[] = [];
  const methodRe = /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s*\(/g;
  for (const m of source.matchAll(methodRe)) {
    units.push({
      key: `endpoint:${m[1]} ${rel}`,
      kind: 'endpoint',
      label: `${m[1]} handler in ${rel}`,
      file: rel,
    });
  }
  return units;
}

/**
 * Exported so source-index.ts's AST-based extraction gates on the same framework sets.
 * Must be kept in sync with every frontend-router-relevant string detector.ts can actually return
 * (see its `detectFramework`) — `'vite'` alone does NOT cover `'vite-react'`/`'vite-vue'`, the two
 * most common real-world results (any Vite + React or Vite + Vue app), which detector.ts returns
 * instead of the bare `'vite'` whenever it also finds a `react`/`vue` dependency. Missing them here
 * silently skipped ALL React/Vue Router extraction for such an app — confirmed live against a real
 * Vite+React app (`detect()` returned `framework: 'vite-react'`), which meant `sourceContext.units`
 * had zero `route` units, so PLAN never had anything to resolve a plan item's `unitKey` against.
 */
export const RELEVANT_FRAMEWORKS_FOR_ROUTER = new Set([
  'react',
  'cra',
  'vite',
  'vite-react',
  'vite-vue',
  'vue',
  'svelte',
  'angular',
  'remix',
]);
export const SERVER_FRAMEWORKS = new Set(['express', 'fastify', 'koa', 'nest']);

/**
 * Extract a bounded inventory of testable functionality units (routes/endpoints) from the repo.
 * Thin wrapper over source-index.ts's indexSource(), which composes AST-based extraction (routes,
 * mount-resolved endpoints, forms, auth patterns, selector hints) with OpenAPI/Swagger/Postman
 * spec parsing — kept here, with this exact signature and return shape, so every existing caller
 * (plan.ts, orchestrator/index.ts, coverage.ts/topup.ts) keeps working unchanged.
 *
 * Best-effort and additive: returns an empty (not null) index when nothing matches or the repo
 * can't be read, so callers can fall back to the plain file-path summary without special-casing
 * failure.
 */
export async function indexFunctionality(
  repoPath: string,
  opts?: { maxUnits?: number },
): Promise<FunctionalityIndex> {
  // Lazy import avoids a static circular-import cycle at module-init time (source-index.ts
  // imports several helpers from this file); by the time indexFunctionality is actually called,
  // both modules are fully initialized, so this resolves safely.
  const { indexSource } = await import('./source-index.js');
  const ctx = await indexSource(repoPath, opts);
  return { units: ctx.units, truncated: ctx.truncated, summary: ctx.summary };
}
