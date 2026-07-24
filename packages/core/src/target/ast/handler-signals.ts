import type { NodePath, TraverseOptions } from '@babel/traverse';
import type { File } from '@babel/types';
import {
  isFunction,
  isIdentifier,
  isMemberExpression,
  isNewExpression,
  isNumericLiteral,
  isStringLiteral,
} from '@babel/types';
import { findRouteHandlerPath } from './endpoints.js';
import { parseModule } from './parse.js';
import { traverse } from './traverse.js';

/** Response-object identifiers a `.status(N)`/`.code(N)` call or `.status = N` assignment is trusted against — Express/Koa/Fastify's conventional parameter names. Not a certainty check (the same names could theoretically be bound to something else), just a noise reducer, same posture as endpoints.ts's DEFAULT_ROUTER_NAMES. */
const RESPONSE_OBJECT_NAMES = new Set(['res', 'response', 'reply', 'ctx']);
/** Error-class-shaped identifier: `Error` itself, or a custom subclass by naming convention (ValidationError, NotFoundError, ...). */
const ERROR_CLASS_NAME_RE = /Error$/;

export interface HandlerSignals {
  file: string;
  /** Distinct HTTP status codes this scan's scope explicitly sets, e.g. via `res.status(404)`, `reply.code(500)` (Fastify), or `ctx.status = 401` (Koa). Ascending, deduped. */
  observedStatusCodes: number[];
  /** Distinct string-literal messages passed to a thrown `Error`/`*Error` constructor. Deduped, in first-seen order. */
  thrownErrorMessages: string[];
  /**
   * True when this result came from the ONE handler function body a `method`+`fullPath` match
   * resolved to; false when no specific handler could be pinned down (no method/path given, no
   * matching registration found via findRouteHandlerPath, or the registration's handler argument
   * is a reference this pass can't resolve to a function in the same file) and the scan fell back
   * to the whole file instead. Callers that care about precision (e.g. deep-dive.ts merging this
   * onto a specific unit) can use this to decide whether to trust the result at unit granularity.
   */
  scoped: boolean;
}

/** Shared visitor: collects observedStatusCodes/thrownErrorMessages into the given sets, used identically whether walking a whole file or one handler's body — so the two scopes can never drift out of sync in what they look for. */
function signalVisitor(statusCodes: Set<number>, errorMessages: Set<string>): TraverseOptions {
  return {
    CallExpression(path) {
      const call = path.node;
      if (!isMemberExpression(call.callee)) return;
      const { object, property } = call.callee;
      if (!isIdentifier(object) || !isIdentifier(property)) return;
      if (!RESPONSE_OBJECT_NAMES.has(object.name)) return;
      if (property.name !== 'status' && property.name !== 'code') return;

      const arg = call.arguments[0];
      if (isNumericLiteral(arg)) statusCodes.add(arg.value);
    },
    AssignmentExpression(path) {
      // Koa's `ctx.status = 401` — a plain assignment, not a call.
      const { left, right } = path.node;
      if (
        isMemberExpression(left) &&
        isIdentifier(left.object) &&
        RESPONSE_OBJECT_NAMES.has(left.object.name) &&
        isIdentifier(left.property) &&
        left.property.name === 'status' &&
        isNumericLiteral(right)
      ) {
        statusCodes.add(right.value);
      }
    },
    ThrowStatement(path) {
      const arg = path.node.argument;
      if (!isNewExpression(arg) || !isIdentifier(arg.callee) || !ERROR_CLASS_NAME_RE.test(arg.callee.name)) {
        return;
      }
      const first = arg.arguments[0];
      if (isStringLiteral(first)) errorMessages.add(first.value);
    },
  };
}

/**
 * Resolve a same-file named function reference (`router.get('/:id', getUser)` where `getUser` is
 * declared elsewhere in the same file) to its body's NodePath — a `function getUser(...) {...}`
 * declaration, or a `const getUser = (...) => {...}`/`function (...) {...}` assignment. Returns
 * null when the identifier isn't bound to a function in this file (imported from elsewhere,
 * dynamically constructed, etc.) — callers fall back to a whole-file scan in that case.
 */
function resolveNamedHandlerBody(ast: File, name: string): NodePath | null {
  let found: NodePath | null = null;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (found) return;
      if (isIdentifier(path.node.id) && path.node.id.name === name) {
        found = path.get('body');
        path.stop();
      }
    },
    VariableDeclarator(path) {
      if (found) return;
      const { id, init } = path.node;
      if (isIdentifier(id) && id.name === name && init && isFunction(init)) {
        found = path.get('init.body') as NodePath;
        path.stop();
      }
    },
  });
  return found;
}

/**
 * Locate the single handler function body a `method`+`fullPath` match resolves to, via
 * findRouteHandlerPath's route-registration matching. Handles the two common shapes: an inline
 * function/arrow expression as the last argument (the handler itself), and a same-file named
 * function reference resolved via resolveNamedHandlerBody. Returns null — meaning "fall back to a
 * whole-file scan" — for every other shape (handler defined in another file, spread/computed
 * arguments, dynamic route registration, etc.), which is a real precision limit worth returning
 * explicitly rather than silently pretending to have found the right scope.
 */
function resolveHandlerBody(ast: File, method: string, fullPath: string): NodePath | null {
  const callPath = findRouteHandlerPath(ast, method, fullPath);
  if (!callPath) return null;

  const args = callPath.get('arguments');
  const lastArg = args[args.length - 1];
  if (!lastArg) return null;

  if (lastArg.isFunction()) {
    return lastArg.get('body') as NodePath;
  }
  if (lastArg.isIdentifier()) {
    return resolveNamedHandlerBody(ast, lastArg.node.name);
  }
  return null;
}

/**
 * Extract two handler-body signals `indexSource()`'s own extractors never look at (route/endpoint
 * discovery there is path+method only): explicit HTTP status codes an Express/Fastify/Koa handler
 * sets, and thrown-error messages. v1 scope is exactly those three frameworks' conventional
 * response objects; Next.js route handlers (`NextResponse.json(body, { status })`) are a noted v2
 * follow-up, not silently mis-detected — this scan simply finds nothing for those files, same as
 * an unsupported framework finding zero routes elsewhere in this package.
 *
 * When `method`/`fullPath` are given, scopes the scan to just the ONE handler function body they
 * resolve to (via resolveHandlerBody) — so a file with several route handlers doesn't conflate
 * one handler's status codes/errors onto every unit mapped to that file. Falls back to a
 * whole-file scan (matching AuthPatternInfo's file-level granularity elsewhere in this package)
 * when no method/fullPath is given, or when the specific handler can't be resolved — `scoped` on
 * the result tells callers which happened.
 */
export function extractHandlerSignalsFromAst(
  rel: string,
  ast: File,
  method?: string,
  fullPath?: string,
): HandlerSignals {
  const statusCodes = new Set<number>();
  const errorMessages = new Set<string>();

  const handlerBody = method && fullPath ? resolveHandlerBody(ast, method, fullPath) : null;
  if (handlerBody) {
    handlerBody.traverse(signalVisitor(statusCodes, errorMessages));
  } else {
    traverse(ast, signalVisitor(statusCodes, errorMessages));
  }

  return {
    file: rel,
    observedStatusCodes: [...statusCodes].sort((a, b) => a - b),
    thrownErrorMessages: [...errorMessages],
    scoped: handlerBody !== null,
  };
}

/** Convenience wrapper over extractHandlerSignalsFromAst for callers with only raw source text — parses once, returns null on parse failure (same contract as this package's other AST extractors). */
export function extractHandlerSignals(
  rel: string,
  source: string,
  method?: string,
  fullPath?: string,
): HandlerSignals | null {
  const ast = parseModule(source, rel);
  if (!ast) return null;
  return extractHandlerSignalsFromAst(rel, ast, method, fullPath);
}
