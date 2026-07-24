import type { File } from '@babel/types';
import {
  isAssignmentExpression,
  isIdentifier,
  isMemberExpression,
  isNewExpression,
  isNumericLiteral,
  isStringLiteral,
} from '@babel/types';
import { parseModule } from './parse.js';
import { traverse } from './traverse.js';

/** Response-object identifiers a `.status(N)`/`.code(N)` call or `.status = N` assignment is trusted against — Express/Koa/Fastify's conventional parameter names. Not a certainty check (the same names could theoretically be bound to something else), just a noise reducer, same posture as endpoints.ts's DEFAULT_ROUTER_NAMES. */
const RESPONSE_OBJECT_NAMES = new Set(['res', 'response', 'reply', 'ctx']);
/** Error-class-shaped identifier: `Error` itself, or a custom subclass by naming convention (ValidationError, NotFoundError, ...). */
const ERROR_CLASS_NAME_RE = /Error$/;

export interface HandlerSignals {
  file: string;
  /** Distinct HTTP status codes this file's handler bodies explicitly set, e.g. via `res.status(404)`, `reply.code(500)` (Fastify), or `ctx.status = 401` (Koa). Ascending, deduped. */
  observedStatusCodes: number[];
  /** Distinct string-literal messages passed to a thrown `Error`/`*Error` constructor. Deduped, in first-seen order. */
  thrownErrorMessages: string[];
}

/**
 * Shallow, single-file scan for two handler-body signals `indexSource()`'s own extractors never
 * look at (route/endpoint discovery there is path+method only): explicit HTTP status codes an
 * Express/Fastify/Koa handler sets, and thrown-error messages. v1 scope is exactly those three
 * frameworks' conventional response objects; Next.js route handlers (`NextResponse.json(body, {
 * status })`) are a noted v2 follow-up, not silently mis-detected — this scan simply finds
 * nothing for those files, same as an unsupported framework finding zero routes elsewhere in this
 * package. Intentionally file-level, not per-handler-function-scoped: matches the granularity
 * AuthPatternInfo already uses elsewhere in this package, and is enough to ground GENERATE/TRIAGE
 * in what CAN happen in this file without claiming precision this shallow a pass can't back up.
 */
export function extractHandlerSignalsFromAst(rel: string, ast: File): HandlerSignals {
  const statusCodes = new Set<number>();
  const errorMessages = new Set<string>();

  traverse(ast, {
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
  });

  return {
    file: rel,
    observedStatusCodes: [...statusCodes].sort((a, b) => a - b),
    thrownErrorMessages: [...errorMessages],
  };
}

/** Convenience wrapper over extractHandlerSignalsFromAst for callers with only raw source text — parses once, returns null on parse failure (same contract as this package's other AST extractors). */
export function extractHandlerSignals(rel: string, source: string): HandlerSignals | null {
  const ast = parseModule(source, rel);
  if (!ast) return null;
  return extractHandlerSignalsFromAst(rel, ast);
}
