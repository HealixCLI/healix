import path from 'node:path';
import type { FunctionalityUnit } from '../functionality-index.js';

function unit(method: string, routePath: string, file: string): FunctionalityUnit {
  return { key: `endpoint:${method} ${routePath}`, kind: 'endpoint', label: `${method} ${routePath}`, file };
}

/** Flask (`@app.route(...)`, `@app.get/post/...(...)`) and FastAPI (`@app.get/post/...(...)`) decorators. */
function extractPython(rel: string, source: string): FunctionalityUnit[] {
  const units: FunctionalityUnit[] = [];

  const routeRe = /@\w+\.route\(\s*(["'])(.*?)\1(?:\s*,\s*methods\s*=\s*\[([^\]]*)\])?\s*\)/g;
  for (const m of source.matchAll(routeRe)) {
    const routePath = m[2];
    const methods = m[3] ? [...m[3].matchAll(/["'](\w+)["']/g)].map((mm) => mm[1].toUpperCase()) : ['GET'];
    for (const method of methods) units.push(unit(method, routePath, rel));
  }

  const shorthandRe = /@\w+\.(get|post|put|patch|delete|options)\(\s*(["'])(.*?)\2/gi;
  for (const m of source.matchAll(shorthandRe)) {
    units.push(unit(m[1].toUpperCase(), m[3], rel));
  }

  return units;
}

/** Django `urls.py`: `path('...', view)` / `re_path('...', view)`. Method is unknown from routing alone (view-dependent). */
export function extractDjango(rel: string, source: string): FunctionalityUnit[] {
  const units: FunctionalityUnit[] = [];
  const re = /\b(?:path|re_path)\(\s*(["'])(.*?)\1/g;
  for (const m of source.matchAll(re)) {
    units.push(unit('GET', `/${m[2].replace(/^\/+/, '')}`, rel));
  }
  return units;
}

/** Go net/http (`http.HandleFunc`) and common router libraries (gin/chi/echo/gorilla-style `router.METHOD(...)`). */
function extractGo(rel: string, source: string): FunctionalityUnit[] {
  const units: FunctionalityUnit[] = [];

  const handleFuncRe = /\bhttp\.HandleFunc\(\s*(["'`])(.*?)\1/g;
  for (const m of source.matchAll(handleFuncRe)) {
    units.push(unit('GET', m[2], rel));
  }

  const routerMethodRe = /\b\w+\.(GET|POST|PUT|PATCH|DELETE|OPTIONS)\(\s*(["'`])(.*?)\2/g;
  for (const m of source.matchAll(routerMethodRe)) {
    units.push(unit(m[1].toUpperCase(), m[3], rel));
  }

  return units;
}

/** Ruby Rails `config/routes.rb` (`get '/path', to: '...'`) and Sinatra (`get '/path' do`). */
function extractRuby(rel: string, source: string): FunctionalityUnit[] {
  const units: FunctionalityUnit[] = [];
  const re = /\b(get|post|put|patch|delete)\s+(["'])(.*?)\2/gi;
  for (const m of source.matchAll(re)) {
    units.push(unit(m[1].toUpperCase(), m[3], rel));
  }
  return units;
}

/** PHP Laravel (`Route::get('/path', ...)`). */
function extractPhp(rel: string, source: string): FunctionalityUnit[] {
  const units: FunctionalityUnit[] = [];
  const re = /\bRoute::(get|post|put|patch|delete|options)\(\s*(["'])(.*?)\2/gi;
  for (const m of source.matchAll(re)) {
    units.push(unit(m[1].toUpperCase(), m[3], rel));
  }
  return units;
}

/**
 * Regex-based endpoint extraction for non-JS backends (Python/Go/Ruby/PHP), gated by file
 * extension. No AST parser is used here (Babel only understands JS/TS) — this mirrors the
 * regex-only approach of the original functionality-index.ts, scoped to languages that codebase
 * never had AST coverage for in the first place. Returns [] for unrecognized extensions.
 */
export function extractMultiLangEndpoints(rel: string, source: string): FunctionalityUnit[] {
  switch (path.extname(rel).toLowerCase()) {
    case '.py':
      // Both Flask/FastAPI decorators and Django's urls.py path()/re_path() calls are valid
      // shapes within a .py file; neither pattern matches the other's syntax, so running both
      // is safe (no double-reporting) and avoids needing a framework-detection gate here.
      return [...extractPython(rel, source), ...extractDjango(rel, source)];
    case '.go':
      return extractGo(rel, source);
    case '.rb':
      return extractRuby(rel, source);
    case '.php':
      return extractPhp(rel, source);
    default:
      return [];
  }
}
