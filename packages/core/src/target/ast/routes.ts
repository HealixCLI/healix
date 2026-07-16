import type { CallExpression, File, ObjectExpression } from '@babel/types';
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
  return { key: `route:${routePath}`, kind: 'route', label: `route: ${routePath}`, file: rel };
}

/**
 * Extract a route object's own `path: "..."` string property, recursing into a nested
 * `children: [...]` array of further route objects (as React Router's data-router config
 * supports arbitrarily nested children) — something the current blanket `path:` regex cannot do
 * without also matching unrelated objects.
 */
function walkRouteObjects(obj: ObjectExpression, rel: string, out: FunctionalityUnit[]): void {
  for (const prop of obj.properties) {
    if (!isObjectProperty(prop) || prop.computed) continue;
    const keyName = isIdentifier(prop.key) ? prop.key.name : isStringLiteral(prop.key) ? prop.key.value : null;
    if (keyName === 'path' && isStringLiteral(prop.value)) {
      out.push(unit(rel, prop.value.value));
    }
    if (keyName === 'children' && isArrayExpression(prop.value)) {
      for (const el of prop.value.elements) {
        if (el && isObjectExpression(el)) walkRouteObjects(el, rel, out);
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
    if (el && isObjectExpression(el)) walkRouteObjects(el, rel, out);
  }
}

/**
 * AST-based React Router extraction: `<Route path="...">` JSX at any nesting depth — including
 * `path={'...'}` expression-container form the regex extractor can't see — plus
 * createBrowserRouter/createHashRouter/createMemoryRouter object-literal configs (recursing into
 * nested `children` arrays). Returns null when the file fails to parse so callers fall back to
 * the regex-based extractReactRouterRoutes for that one file.
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
  traverse(ast, {
    JSXOpeningElement(path) {
      const name = path.node.name;
      if (!isJSXIdentifier(name) || name.name !== 'Route') return;
      for (const attr of path.node.attributes) {
        if (attr.type !== 'JSXAttribute') continue;
        if (!isJSXIdentifier(attr.name) || attr.name.name !== 'path') continue;
        const value = attr.value;
        if (isStringLiteral(value)) {
          out.push(unit(rel, value.value));
        } else if (isJSXExpressionContainer(value) && isStringLiteral(value.expression)) {
          out.push(unit(rel, value.expression.value));
        }
      }
    },
    CallExpression(path) {
      walkRouterFactoryCall(path.node, rel, out);
    },
  });

  return out;
}
