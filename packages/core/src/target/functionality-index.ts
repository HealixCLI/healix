import fs from 'node:fs';
import path from 'node:path';
import { detect } from './detector.js';

export type FunctionalityUnitKind = 'route' | 'endpoint' | 'component';

export interface FunctionalityUnit {
  /** Stable identity for coverage matching, e.g. "route:/checkout" or "endpoint:POST /api/orders". */
  key: string;
  kind: FunctionalityUnitKind;
  /** Human-readable label for prompts/UIs, e.g. "GET /api/orders" or "page: /checkout". */
  label: string;
  file: string;
}

export interface FunctionalityIndex {
  units: FunctionalityUnit[];
  truncated: boolean;
  /** Short natural-language summary for prompt grounding. */
  summary: string;
}

/** Hard cap on extracted units — mirrors indexRepo's maxFiles bound; a huge repo shouldn't blow the prompt. */
const DEFAULT_MAX_UNITS = 300;

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

interface WalkFile {
  abs: string;
  rel: string;
}

/** Iterative BFS walk collecting source files, same traversal shape as repo-index.ts's walk(). */
function walkSourceFiles(root: string, hardCap: number): { files: WalkFile[]; truncated: boolean } {
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
      if (!SOURCE_EXT.has(ext)) continue;

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

function readSafe(abs: string): string {
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return '';
  }
}

/** Next.js file-based routing: pages/**\/*.tsx (excluding _app/_document/api) and app/**\/page.tsx, plus app/**\/route.ts as endpoints. */
function extractNextRoutes(rel: string): FunctionalityUnit[] {
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

/** React Router: <Route path="..."> JSX and createBrowserRouter/createRoutesFromElements object literals. */
function extractReactRouterRoutes(rel: string, source: string): FunctionalityUnit[] {
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

/** Express/Fastify/Koa: app.get/post/... and router.get/post/... registrations. */
function extractServerRoutes(rel: string, source: string): FunctionalityUnit[] {
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

/** Exported Next.js-style route handlers: `export function GET(...)` / `export default async function handler(...)`. */
function extractExportedHandlers(rel: string, source: string): FunctionalityUnit[] {
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

const RELEVANT_FRAMEWORKS_FOR_ROUTER = new Set(['react', 'cra', 'vite', 'vue', 'svelte', 'angular', 'remix']);
const SERVER_FRAMEWORKS = new Set(['express', 'fastify', 'koa', 'nest']);

/**
 * Extract a bounded inventory of testable functionality units (routes/endpoints)
 * from the repo via lightweight regex patterns — no AST dependency. Framework
 * detection from detect() gates which patterns run so unrelated regexes don't
 * fire noise on repos that don't use that framework.
 *
 * Best-effort and additive: returns an empty (not null) index when nothing
 * matches or the repo can't be read, so callers can fall back to the plain
 * file-path summary without special-casing failure.
 */
export async function indexFunctionality(
  repoPath: string,
  opts?: { maxUnits?: number },
): Promise<FunctionalityIndex> {
  const root = path.resolve(repoPath);
  const maxUnits = opts?.maxUnits ?? DEFAULT_MAX_UNITS;

  let framework: string | null = null;
  try {
    framework = (await detect(root)).framework;
  } catch {
    framework = null;
  }

  const { files, truncated: filesTruncated } = walkSourceFiles(root, 5000);

  const seen = new Set<string>();
  const units: FunctionalityUnit[] = [];
  let truncated = filesTruncated;

  const isNext = framework === 'next';
  const wantsRouter = framework !== null && RELEVANT_FRAMEWORKS_FOR_ROUTER.has(framework);
  const isServer = framework !== null && SERVER_FRAMEWORKS.has(framework);

  for (const f of files) {
    if (units.length >= maxUnits) {
      truncated = true;
      break;
    }

    let extracted: FunctionalityUnit[] = [];
    if (isNext) {
      extracted = extractNextRoutes(f.rel);
    }
    if (extracted.length === 0 && (wantsRouter || isServer || framework === null)) {
      const source = readSafe(f.abs);
      if (!source) continue;
      if (wantsRouter || framework === null) extracted.push(...extractReactRouterRoutes(f.rel, source));
      if (isServer || framework === null) extracted.push(...extractServerRoutes(f.rel, source));
      extracted.push(...extractExportedHandlers(f.rel, source));
    }

    for (const unit of extracted) {
      if (seen.has(unit.key)) continue;
      seen.add(unit.key);
      units.push(unit);
      if (units.length >= maxUnits) {
        truncated = true;
        break;
      }
    }
  }

  const routeCount = units.filter((u) => u.kind === 'route').length;
  const endpointCount = units.filter((u) => u.kind === 'endpoint').length;
  const summary =
    units.length === 0
      ? ''
      : `Detected functionality: ${routeCount} route(s), ${endpointCount} endpoint(s)${
          truncated ? ` (capped at ${maxUnits})` : ''
        }.`;

  return { units, truncated, summary };
}
