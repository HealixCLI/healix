import { parse } from '@babel/parser';
import type { File } from '@babel/types';

/**
 * Parse one source file into a Babel AST for structural extraction (routes,
 * endpoints, forms, auth patterns, selectors). Returns null on any parse
 * failure — malformed/unusual syntax in one file must never abort the whole
 * repo scan; callers fall back to a regex pass for that file instead (same
 * defensive posture as the rest of target/*.ts).
 */
export function parseModule(source: string, filename: string): File | null {
  try {
    return parse(source, {
      sourceFilename: filename,
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      // Keep parsing best-effort even past small syntax hiccups (e.g. a stray
      // top-level return) rather than failing the whole file over one issue.
      errorRecovery: true,
    });
  } catch {
    return null;
  }
}
