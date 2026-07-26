import type { CallExpression, File, JSXOpeningElement, ObjectExpression } from '@babel/types';
import {
  isArrayExpression,
  isIdentifier,
  isJSXExpressionContainer,
  isJSXIdentifier,
  isObjectExpression,
  isObjectProperty,
  isStringLiteral,
} from '@babel/types';
import type { FunctionalityUnit } from '../functionality-index.js';
import { parseModule } from './parse.js';
import { traverse } from './traverse.js';

/** Router-config factory calls whose array-of-route-object argument we walk for `path`. */
const ROUTER_FACTORY_NAMES = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter']);

function unit(rel: string, routePath: string): FunctionalityUnit {
  // A root `<Route index>` (or an empty-string `path`) composes to '' (no ancestor segment at
  // all) — normalize to '/' so it reads as the real root URL instead of a bare, slash-less key.
  const normalized = routePath === '' ? '/' : routePath;
  return { key: `route:${normalized}`, kind: 'route', label: `route: ${normalized}`, file: rel };
}

/**
 * Join a nested route's own (relative) `path` onto its ancestors' already-composed path, the way
 * React Router v6 itself resolves a nested route's real URL — a naive per-`<Route>` extraction
 * (this function's previous shape) reads each `path` attribute in isolation, so `<Route
 * path="login"><Route path="resetpassword" /></Route>` wrongly yields a bare `resetpassword` unit
 * instead of the real `/login/resetpassword`. Normalizes any duplicate/missing slashes so callers
 * never have to care which side already had one.
 */
function joinRoutePath(parent: string, segment: string): string {
  if (!segment) return parent || '/';
  const trimmedParent = parent.replace(/\/+$/, '');
  const trimmedSegment = segment.replace(/^\/+/, '');
  return `${trimmedParent}/${trimmedSegment}`.replace(/\/{2,}/g, '/');
}

/**
 * Extract a route object's own `path: "..."` string property, recursing into a nested
 * `children: [...]` array of further route objects (as React Router's data-router config
 * supports arbitrarily nested children) — something the current blanket `path:` regex cannot do
 * without also matching unrelated objects. `parentPath` is the already-composed path of every
 * enclosing route object (see joinRoutePath) so a nested `children` entry's own `path` is resolved
 * to its real, full URL rather than emitted as a bare relative fragment.
 */
function walkRouteObjects(
  obj: ObjectExpression,
  rel: string,
  parentPath: string,
  out: FunctionalityUnit[],
): void {
  let ownPath: string | null = null;
  let isIndex = false;
  for (const prop of obj.properties) {
    if (!isObjectProperty(prop) || prop.computed) continue;
    const keyName = isIdentifier(prop.key)
      ? prop.key.name
      : isStringLiteral(prop.key)
        ? prop.key.value
        : null;
    if (keyName === 'path' && isStringLiteral(prop.value)) {
      ownPath = prop.value.value;
    }
    if (keyName === 'index' && prop.value.type === 'BooleanLiteral' && prop.value.value) {
      isIndex = true;
    }
  }
  // A pathless layout entry (neither `path` nor `index`) contributes no new segment — children
  // resolve directly against the current parentPath, same as a JSX `<Route element={...}>` wrapper.
  const composed = isIndex ? parentPath : ownPath !== null ? joinRoutePath(parentPath, ownPath) : parentPath;
  if (ownPath !== null || isIndex) out.push(unit(rel, composed));

  for (const prop of obj.properties) {
    if (!isObjectProperty(prop) || prop.computed) continue;
    const keyName = isIdentifier(prop.key)
      ? prop.key.name
      : isStringLiteral(prop.key)
        ? prop.key.value
        : null;
    if (keyName === 'children' && isArrayExpression(prop.value)) {
      for (const el of prop.value.elements) {
        if (el && isObjectExpression(el)) walkRouteObjects(el, rel, composed, out);
      }
    }
  }
}

/**
 * Only walk `path:` properties inside the array literal argument of a recognized router-factory
 * call (createBrowserRouter/createHashRouter/createMemoryRouter) — scoping extraction to actual
 * route configs avoids false positives from an unrelated object elsewhere in the file that
 * happens to have its own `path` property (e.g. a file-upload config), which the file-wide regex
 * scan cannot distinguish.
 */
function walkRouterFactoryCall(call: CallExpression, rel: string, out: FunctionalityUnit[]): void {
  if (!isIdentifier(call.callee) || !ROUTER_FACTORY_NAMES.has(call.callee.name)) return;
  const arg = call.arguments[0];
  if (!arg || !isArrayExpression(arg)) return;
  for (const el of arg.elements) {
    if (el && isObjectExpression(el)) walkRouteObjects(el, rel, '', out);
  }
}

function readPathAttr(opening: JSXOpeningElement): {
  hasPath: boolean;
  value: string | null;
  isIndex: boolean;
} {
  let hasPath = false;
  let value: string | null = null;
  let isIndex = false;
  for (const attr of opening.attributes) {
    if (attr.type !== 'JSXAttribute' || !isJSXIdentifier(attr.name)) continue;
    if (attr.name.name === 'path') {
      hasPath = true;
      const attrValue = attr.value;
      if (isStringLiteral(attrValue)) {
        value = attrValue.value;
      } else if (isJSXExpressionContainer(attrValue) && isStringLiteral(attrValue.expression)) {
        value = attrValue.expression.value;
      }
    } else if (attr.name.name === 'index') {
      isIndex = true;
    }
  }
  return { hasPath, value, isIndex };
}

/**
 * AST-based React Router extraction: `<Route path="...">` JSX at any nesting depth — including
 * `path={'...'}` expression-container form the regex extractor can't see — plus
 * createBrowserRouter/createHashRouter/createMemoryRouter object-literal configs (recursing into
 * nested `children` arrays). Both forms compose a nested route's path with its ancestors' (see
 * joinRoutePath) so a route nested several levels deep (e.g. a `login` wrapper's `resetpassword`
 * child) is reported as the real, full `/login/resetpassword` URL rather than a bare relative
 * fragment. Returns null when the file fails to parse so callers fall back to the regex-based
 * extractReactRouterRoutes for that one file.
 */
export function extractReactRouterRoutesAst(rel: string, source: string): FunctionalityUnit[] | null {
  const ast: File | null = parseModule(source, rel);
  if (!ast) return null;
  return extractReactRouterRoutesFromAst(rel, ast);
}

/**
 * Same as extractReactRouterRoutesAst, but takes an already-parsed AST — for callers
 * (source-index.ts) that parse each file once and share the AST across every AST-based extractor.
 */
export function extractReactRouterRoutesFromAst(rel: string, ast: File): FunctionalityUnit[] {
  const out: FunctionalityUnit[] = [];
  // Ancestor-composed path for whichever <Route> subtree is currently being visited — pushed on
  // entering a <Route> JSXElement, popped on leaving it, so a deeply-nested <Route> resolves
  // against its real enclosing path instead of being read in isolation (see joinRoutePath).
  const pathStack: string[] = [''];
  traverse(ast, {
    JSXElement: {
      enter(path) {
        const opening = path.node.openingElement;
        const name = opening.name;
        if (!isJSXIdentifier(name) || name.name !== 'Route') return;
        const parentPath = pathStack[pathStack.length - 1];
        const { hasPath, value, isIndex } = readPathAttr(opening);
        const composed = isIndex
          ? parentPath
          : value !== null
            ? joinRoutePath(parentPath, value)
            : parentPath;
        if (hasPath || isIndex) out.push(unit(rel, composed));
        pathStack.push(composed);
      },
      exit(path) {
        const opening = path.node.openingElement;
        const name = opening.name;
        if (!isJSXIdentifier(name) || name.name !== 'Route') return;
        pathStack.pop();
      },
    },
    CallExpression(path) {
      walkRouterFactoryCall(path.node, rel, out);
    },
  });

  return out;
}
