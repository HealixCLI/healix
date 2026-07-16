import type { File } from '@babel/types';
import { isJSXExpressionContainer, isJSXIdentifier, isStringLiteral } from '@babel/types';
import { parseModule } from './parse.js';
import { traverse } from './traverse.js';

export type SelectorAttribute = 'data-testid' | 'data-test' | 'aria-label';

export interface SelectorHint {
  file: string;
  attribute: SelectorAttribute;
  value: string;
}

const SELECTOR_ATTRS = new Set<SelectorAttribute>(['data-testid', 'data-test', 'aria-label']);

/**
 * AST-based selector-hint extraction: collects every `data-testid`/`data-test`/`aria-label`
 * JSX attribute value in a file, so downstream test generation can prefer real, stable selectors
 * over guessed ones. Returns null on parse failure so callers can skip the file (there is no
 * regex fallback for this new capability).
 */
export function extractSelectorHintsAst(rel: string, source: string): SelectorHint[] | null {
  const ast: File | null = parseModule(source, rel);
  if (!ast) return null;
  return extractSelectorHintsFromAst(rel, ast);
}

/**
 * Same as extractSelectorHintsAst, but takes an already-parsed AST — for callers (source-index.ts)
 * that parse each file once and share the AST across every AST-based extractor.
 */
export function extractSelectorHintsFromAst(rel: string, ast: File): SelectorHint[] {
  const hints: SelectorHint[] = [];

  traverse(ast, {
    JSXAttribute(path) {
      const name = path.node.name;
      if (!isJSXIdentifier(name) || !SELECTOR_ATTRS.has(name.name as SelectorAttribute)) return;

      const value = path.node.value;
      let literal: string | undefined;
      if (isStringLiteral(value)) {
        literal = value.value;
      } else if (isJSXExpressionContainer(value) && isStringLiteral(value.expression)) {
        literal = value.expression.value;
      }
      if (literal !== undefined) {
        hints.push({ file: rel, attribute: name.name as SelectorAttribute, value: literal });
      }
    },
  });

  return hints;
}
