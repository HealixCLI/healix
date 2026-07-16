import path from 'node:path';
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
 * Extract everything one file contributes toward the Express/Fastify/Koa endpoint graph:
 * local `X.METHOD(path, ...)` registrations, `X.use(mountPath, subRouter)` mounts, whether this
 * file exports a router (`module.exports = router` / `export default router`), and its
 * require/import specifier map (for resolving mount targets to files in a second pass). Returns
 * null on parse failure so callers fall back to the regex-based extractServerRoutes for that file.
 */
export function extractExpressRouterInfo(source: string, filename: string): FileRouterInfo | null {
  const ast = parseModule(source, filename);
  if (!ast) return null;

  const routerVarNames = collectRouterVarNames(ast);
  const localEndpoints: LocalEndpoint[] = [];
  const mounts: MountCandidate[] = [];
  const importedFrom = new Map<string, string>();
  let exportsRouterVar = false;

  /** Returns the called method name (e.g. "get"/"use") iff `call` is `X.method(...)` on a known router/app identifier. */
  function routerCallMethod(call: CallExpression): string | null {
    const callee = call.callee;
    if (!isMemberExpression(callee) || !isIdentifier(callee.object) || !isIdentifier(callee.property)) return null;
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
 * Compose per-file Express/Fastify/Koa router info (see extractExpressRouterInfo) into a final
 * endpoint inventory, resolving `app.use('/mount', subRouter)` across files back to the router
 * module's own local `router.METHOD(...)` registrations — e.g. app.js's
 * `app.use('/api/users', require('./routes/userRoutes'))` plus userRoutes.js's
 * `router.get('/:id', ...)` composes to `GET /api/users/:id`. A router file never reached by any
 * mount still surfaces its endpoints unprefixed rather than being silently dropped.
 */
export function resolveExpressEndpoints(files: Array<{ rel: string; source: string }>): FunctionalityUnit[] {
  const allRelPaths = new Set(files.map((f) => f.rel));
  const perFile = new Map<string, FileRouterInfo>();

  for (const f of files) {
    const info = extractExpressRouterInfo(f.source, f.rel);
    if (info) perFile.set(f.rel, info);
  }

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
