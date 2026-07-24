import path from 'node:path';
import type { NodePath } from '@babel/traverse';
import type { CallExpression, File } from '@babel/types';
import {
  isCallExpression,
  isIdentifier,
  isMemberExpression,
  isNewExpression,
  isStringLiteral,
  isVariableDeclarator,
} from '@babel/types';
import type { FunctionalityUnit } from '../functionality-index.js';
import { parseModule } from './parse.js';
import { traverse } from './traverse.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options']);
/** Object identifiers treated as a router/app even with no local factory-call evidence (matches legacy). */
const DEFAULT_ROUTER_NAMES = new Set(['app', 'router', 'server']);

/** One `X.METHOD(path, ...)` call found directly in a file. */
interface LocalEndpoint {
  method: string;
  pathSuffix: string;
}

/** One `X.use(mountPath, routerRefName)` mount registration found directly in a file. */
interface MountCandidate {
  mountPath: string;
  /** The identifier passed as the router argument — resolved to a file via imports/requires. */
  routerRefName: string;
}

/** Per-file extraction result, before any cross-file mount resolution. */
export interface FileRouterInfo {
  localEndpoints: LocalEndpoint[];
  mounts: MountCandidate[];
  /** relative import/require specifiers this file exports its router identifier under, e.g. `module.exports = router`. */
  exportsRouterVar: boolean;
  /** local identifier -> relative module specifier, from `require('./x')` / `import x from './x'`. */
  importedFrom: Map<string, string>;
}

/** Identifiers in this file bound to an Express/Fastify/Koa router-or-app instance. */
function collectRouterVarNames(ast: File): Set<string> {
  const names = new Set<string>(DEFAULT_ROUTER_NAMES);

  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      const init = path.node.init;
      if (!isIdentifier(id) || !init) return;

      if (isCallExpression(init)) {
        const callee = init.callee;
        // express.Router()
        if (
          isMemberExpression(callee) &&
          isIdentifier(callee.object) &&
          callee.object.name === 'express' &&
          isIdentifier(callee.property) &&
          callee.property.name === 'Router'
        ) {
          names.add(id.name);
          return;
        }
        // express() / fastify() — the app instance itself.
        if (isIdentifier(callee) && (callee.name === 'express' || /^fastify$/i.test(callee.name))) {
          names.add(id.name);
          return;
        }
      }
      // new Router() / new KoaRouter()
      if (isNewExpression(init) && isIdentifier(init.callee) && /Router$/.test(init.callee.name)) {
        names.add(id.name);
      }
    },
  });

  return names;
}

/**
 * Same as extractExpressRouterInfo, but takes an already-parsed AST — for callers (source-index.ts)
 * that parse each file once and share the AST across every AST-based extractor instead of having
 * each one re-parse the same file from source.
 */
export function extractExpressRouterInfoFromAst(ast: File): FileRouterInfo {
  const routerVarNames = collectRouterVarNames(ast);
  const localEndpoints: LocalEndpoint[] = [];
  const mounts: MountCandidate[] = [];
  const importedFrom = new Map<string, string>();
  let exportsRouterVar = false;

  /** Returns the called method name (e.g. "get"/"use") iff `call` is `X.method(...)` on a known router/app identifier. */
  function routerCallMethod(call: CallExpression): string | null {
    const callee = call.callee;
    if (!isMemberExpression(callee) || !isIdentifier(callee.object) || !isIdentifier(callee.property))
      return null;
    if (!routerVarNames.has(callee.object.name)) return null;
    return callee.property.name;
  }

  traverse(ast, {
    CallExpression(path) {
      const call = path.node;

      // require('./relPath') assigned to an identifier.
      const parent = path.parent;
      if (
        isVariableDeclarator(parent) &&
        isIdentifier(parent.id) &&
        isIdentifier(call.callee) &&
        call.callee.name === 'require' &&
        isStringLiteral(call.arguments[0])
      ) {
        importedFrom.set(parent.id.name, call.arguments[0].value);
      }

      const method = routerCallMethod(call);
      if (method === null) return;

      // X.METHOD('/path', ...handlers)
      if (HTTP_METHODS.has(method)) {
        const first = call.arguments[0];
        if (isStringLiteral(first)) {
          localEndpoints.push({ method: method.toUpperCase(), pathSuffix: first.value });
        }
        return;
      }

      // X.use('/mount', subRouter) — only the two-arg (string, identifier) mount form; X.use(fn)
      // (bare middleware) has no string first argument and is correctly ignored.
      if (method === 'use') {
        const [first, second] = call.arguments;
        if (isStringLiteral(first) && isIdentifier(second)) {
          mounts.push({ mountPath: first.value, routerRefName: second.name });
        }
      }
    },
    ImportDeclaration(path) {
      const source = path.node.source.value;
      for (const spec of path.node.specifiers) {
        if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportSpecifier') {
          importedFrom.set(spec.local.name, source);
        }
      }
    },
    AssignmentExpression(path) {
      const { left, right } = path.node;
      if (
        isMemberExpression(left) &&
        isIdentifier(left.object) &&
        left.object.name === 'module' &&
        isIdentifier(left.property) &&
        left.property.name === 'exports' &&
        isIdentifier(right) &&
        routerVarNames.has(right.name)
      ) {
        exportsRouterVar = true;
      }
    },
    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      if (isIdentifier(decl) && routerVarNames.has(decl.name)) exportsRouterVar = true;
    },
  });

  return { localEndpoints, mounts, exportsRouterVar, importedFrom };
}

/**
 * Extract everything one file contributes toward the Express/Fastify/Koa endpoint graph:
 * local `X.METHOD(path, ...)` registrations, `X.use(mountPath, subRouter)` mounts, whether this
 * file exports a router (`module.exports = router` / `export default router`), and its
 * require/import specifier map (for resolving mount targets to files in a second pass). Returns
 * null on parse failure so callers fall back to the regex-based extractServerRoutes for that file.
 */
export function extractExpressRouterInfo(source: string, filename: string): FileRouterInfo | null {
  const ast = parseModule(source, filename);
  if (!ast) return null;
  return extractExpressRouterInfoFromAst(ast);
}

/** Join a mount prefix and a route suffix into one normalized path, collapsing the `/` + `/` root case. */
function joinPath(prefix: string, suffix: string): string {
  const p = prefix.replace(/\/+$/, '');
  const s = suffix.startsWith('/') ? suffix : `/${suffix}`;
  const joined = `${p}${s === '/' ? '' : s}`;
  return joined || '/';
}

/** Resolve a require/import specifier from `fromRel` to a relative path present in `allRelPaths`. */
function resolveSpecifier(fromRel: string, spec: string, allRelPaths: Set<string>): string | null {
  if (!spec.startsWith('.')) return null; // bare package specifier — not a local file.
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  const candidates = [
    joined,
    `${joined}.js`,
    `${joined}.ts`,
    `${joined}.jsx`,
    `${joined}.tsx`,
    path.posix.join(joined, 'index.js'),
    path.posix.join(joined, 'index.ts'),
  ];
  return candidates.find((c) => allRelPaths.has(c)) ?? null;
}

function unit(method: string, routePath: string, file: string): FunctionalityUnit {
  return { key: `endpoint:${method} ${routePath}`, kind: 'endpoint', label: `${method} ${routePath}`, file };
}

/**
 * Compose already-extracted per-file Express/Fastify/Koa router info (see
 * extractExpressRouterInfoFromAst) into a final endpoint inventory, resolving
 * `app.use('/mount', subRouter)` across files back to the router module's own local
 * `router.METHOD(...)` registrations — e.g. app.js's
 * `app.use('/api/users', require('./routes/userRoutes'))` plus userRoutes.js's
 * `router.get('/:id', ...)` composes to `GET /api/users/:id`. A router file never reached by any
 * mount still surfaces its endpoints unprefixed rather than being silently dropped. Split out from
 * resolveExpressEndpoints so source-index.ts can reuse ASTs it already parsed for other
 * extractors instead of re-parsing every file again here.
 */
export function resolveExpressEndpointsFromInfo(perFile: Map<string, FileRouterInfo>): FunctionalityUnit[] {
  const allRelPaths = new Set(perFile.keys());

  // fileRel -> mount prefixes that resolve to it, from every OTHER file's mount calls.
  const prefixesForFile = new Map<string, string[]>();
  for (const [rel, info] of perFile) {
    for (const mount of info.mounts) {
      const spec = info.importedFrom.get(mount.routerRefName);
      if (!spec) continue;
      const target = resolveSpecifier(rel, spec, allRelPaths);
      if (!target) continue;
      const list = prefixesForFile.get(target) ?? [];
      list.push(mount.mountPath);
      prefixesForFile.set(target, list);
    }
  }

  const units: FunctionalityUnit[] = [];
  for (const [rel, info] of perFile) {
    if (info.localEndpoints.length === 0) continue;
    const prefixes = info.exportsRouterVar ? (prefixesForFile.get(rel) ?? ['']) : [''];
    for (const prefix of prefixes) {
      for (const ep of info.localEndpoints) {
        units.push(unit(ep.method, joinPath(prefix, ep.pathSuffix), rel));
      }
    }
  }
  return units;
}

/**
 * Locate the single `X.METHOD(pathSuffix, ...handlers)` registration in `ast` responsible for
 * `fullPath` (a unit's complete, possibly mount-prefixed route, e.g. "/api/users/:id"), for
 * callers (target/ast/handler-signals.ts) that need to scope a deeper scan to just THAT handler's
 * function body instead of the whole file — this file may register several distinct routes, and a
 * file-wide scan would conflate every handler's signals onto every unit mapped to this file.
 *
 * Reuses the exact router-variable detection and `X.method(...)` call-matching
 * extractExpressRouterInfoFromAst already does, so the two stay in lockstep — a route this
 * function fails to recognize is one extractExpressRouterInfoFromAst wouldn't have registered as
 * a unit in the first place.
 *
 * `fullPath` may carry a mount prefix this file's own registration never sees (the mount happens
 * in a DIFFERENT file — see resolveExpressEndpointsFromInfo), so a registration's own literal path
 * argument is accepted when it either equals `fullPath` exactly (the no-mount case) or is a
 * non-trivial suffix of it (the mounted case, e.g. local "/:id" for full "/api/users/:id"). A bare
 * "/" registration only matches when `fullPath` itself has no further path segments beyond the
 * mount point, since a bare "/" would otherwise trivially match every path via naive suffix
 * matching. When more than one local registration could plausibly match, the longest (most
 * specific) pathSuffix wins. Returns null when nothing matches — callers should fall back to a
 * file-level scan rather than treat null as "this file has no relevant handlers."
 */
export function findRouteHandlerPath(
  ast: File,
  method: string,
  fullPath: string,
): NodePath<CallExpression> | null {
  const routerVarNames = collectRouterVarNames(ast);
  const wantMethod = method.toLowerCase();
  const lastSegment = fullPath.slice(fullPath.lastIndexOf('/') + 1);

  const best: { path: NodePath<CallExpression> | null; suffixLen: number } = { path: null, suffixLen: -1 };

  traverse(ast, {
    CallExpression(callPath) {
      const call = callPath.node;
      const callee = call.callee;
      if (!isMemberExpression(callee) || !isIdentifier(callee.object) || !isIdentifier(callee.property))
        return;
      if (!routerVarNames.has(callee.object.name)) return;
      if (callee.property.name.toLowerCase() !== wantMethod) return;

      const first = call.arguments[0];
      if (!isStringLiteral(first)) return;
      const pathSuffix = first.value;

      const matches =
        pathSuffix === fullPath ||
        (pathSuffix !== '/' && fullPath.endsWith(pathSuffix)) ||
        (pathSuffix === '/' && lastSegment === '');
      if (!matches) return;
      if (pathSuffix.length > best.suffixLen) {
        best.path = callPath;
        best.suffixLen = pathSuffix.length;
      }
    },
  });

  return best.path;
}

/**
 * Convenience wrapper over resolveExpressEndpointsFromInfo for callers that only have raw source
 * text (e.g. tests) — parses each file once via extractExpressRouterInfo, skipping any file that
 * fails to parse (same as that function's own null-on-parse-failure contract).
 */
export function resolveExpressEndpoints(files: Array<{ rel: string; source: string }>): FunctionalityUnit[] {
  const perFile = new Map<string, FileRouterInfo>();
  for (const f of files) {
    const info = extractExpressRouterInfo(f.source, f.rel);
    if (info) perFile.set(f.rel, info);
  }
  return resolveExpressEndpointsFromInfo(perFile);
}
