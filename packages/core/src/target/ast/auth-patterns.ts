import type { File } from '@babel/types';
import { isJSXIdentifier, isStringLiteral } from '@babel/types';
import { parseModule } from './parse.js';
import { traverse } from './traverse.js';

export interface AuthPatternInfo {
  file: string;
  /** Auth library labels recognized from this file's imports (see AUTH_LIBRARY_MATCHERS), deduped. */
  libraries: string[];
  /** Distinct route-guard component names used as a JSX wrapper in this file (see ROUTE_GUARD_NAME_RE), deduped. */
  routeGuards: string[];
}

/** Recognized auth-library import specifiers, tested against the raw module specifier string. */
const AUTH_LIBRARY_MATCHERS: Array<{ label: string; test: (spec: string) => boolean }> = [
  { label: 'jsonwebtoken', test: (s) => s === 'jsonwebtoken' },
  { label: 'jose', test: (s) => s === 'jose' },
  { label: 'express-jwt', test: (s) => s === 'express-jwt' },
  { label: 'passport', test: (s) => s === 'passport' || s.startsWith('passport-') },
  { label: 'next-auth', test: (s) => s === 'next-auth' || s.startsWith('next-auth/') },
  { label: 'clerk', test: (s) => s.startsWith('@clerk/') },
  { label: 'auth0', test: (s) => s.startsWith('@auth0/') || s === 'auth0-js' },
  { label: 'supabase-auth-helpers', test: (s) => s.startsWith('@supabase/auth-helpers') },
  { label: 'firebase-auth', test: (s) => s === 'firebase/auth' },
  { label: 'cognito', test: (s) => s === 'aws-amplify' || s === 'amazon-cognito-identity-js' },
];

/** JSX element names commonly used to wrap an auth-gated route/subtree. Exported so
 * target/ast/routes.ts can correlate a route's ancestor chain against the same
 * recognized-guard list instead of duplicating/drifting it (see Cluster C, GAP-tier-guard). */
export const ROUTE_GUARD_NAME_RE = /^(ProtectedRoute|PrivateRoute|RequireAuth|AuthGuard|AuthenticatedRoute)$/;

function libraryFor(spec: string): string | null {
  return AUTH_LIBRARY_MATCHERS.find((m) => m.test(spec))?.label ?? null;
}

/**
 * AST-based auth-pattern detection: which known auth library (if any) this file imports, and
 * which route-guard components (ProtectedRoute/PrivateRoute/RequireAuth/...) it uses to wrap a
 * route element — the two signals needed to tell whether a given route/endpoint is auth-gated
 * and by what mechanism. Returns null on parse failure so callers can skip the file.
 */
export function extractAuthPatternsAst(rel: string, source: string): AuthPatternInfo | null {
  const ast: File | null = parseModule(source, rel);
  if (!ast) return null;
  return extractAuthPatternsFromAst(rel, ast);
}

/**
 * Same as extractAuthPatternsAst, but takes an already-parsed AST — for callers (source-index.ts)
 * that parse each file once and share the AST across every AST-based extractor.
 */
export function extractAuthPatternsFromAst(rel: string, ast: File): AuthPatternInfo {
  const libraries = new Set<string>();
  const routeGuards = new Set<string>();

  traverse(ast, {
    ImportDeclaration(path) {
      const lib = libraryFor(path.node.source.value);
      if (lib) libraries.add(lib);
    },
    CallExpression(path) {
      const call = path.node;
      if (
        call.callee.type === 'Identifier' &&
        call.callee.name === 'require' &&
        isStringLiteral(call.arguments[0])
      ) {
        const lib = libraryFor(call.arguments[0].value);
        if (lib) libraries.add(lib);
      }
    },
    JSXOpeningElement(path) {
      const name = path.node.name;
      if (isJSXIdentifier(name) && ROUTE_GUARD_NAME_RE.test(name.name)) {
        routeGuards.add(name.name);
      }
    },
  });

  return { file: rel, libraries: [...libraries], routeGuards: [...routeGuards] };
}
