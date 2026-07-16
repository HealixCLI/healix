import type { File, JSXAttribute, JSXOpeningElement } from '@babel/types';
import { isBooleanLiteral, isJSXExpressionContainer, isJSXIdentifier, isStringLiteral } from '@babel/types';
import { parseModule } from './parse.js';
import { traverse } from './traverse.js';

export interface FormField {
  /** Best-effort identity, in priority order: `name` attr > `label` string > `data-testid` > a positional fallback. */
  name: string;
  type: string;
  required: boolean;
  testId?: string;
}

export interface FormInfo {
  file: string;
  fields: FormField[];
  /** Best-effort submit control text, when a single static text child was found. */
  submitLabel?: string;
}

const NATIVE_INPUT_TAGS = new Set(['input', 'select', 'textarea']);
/** Common input `type` values, used to recognize a custom input-like component (e.g. MUI's TextField, a design system's MatInput) that carries one. */
const KNOWN_INPUT_TYPES = new Set([
  'text',
  'email',
  'password',
  'number',
  'tel',
  'date',
  'checkbox',
  'radio',
  'search',
  'url',
]);
/** Custom component name shapes commonly used for form inputs, when no recognized `type` value is present either. */
const INPUT_COMPONENT_NAME_RE = /(Input|Field)$/;
const SUBMIT_COMPONENT_NAME_RE = /Button$/;

function attrString(el: JSXOpeningElement, name: string): string | undefined {
  const attr = el.attributes.find(
    (a): a is JSXAttribute => a.type === 'JSXAttribute' && isJSXIdentifier(a.name) && a.name.name === name,
  );
  if (!attr) return undefined;
  const value = attr.value;
  if (isStringLiteral(value)) return value.value;
  if (isJSXExpressionContainer(value) && isStringLiteral(value.expression)) return value.expression.value;
  return undefined;
}

function hasTruthyAttr(el: JSXOpeningElement, name: string): boolean {
  const attr = el.attributes.find(
    (a): a is JSXAttribute => a.type === 'JSXAttribute' && isJSXIdentifier(a.name) && a.name.name === name,
  );
  if (!attr) return false;
  if (attr.value === null) return true; // bare `required` shorthand.
  if (isJSXExpressionContainer(attr.value) && isBooleanLiteral(attr.value.expression)) {
    return attr.value.expression.value;
  }
  return false;
}

function isSubmitControl(el: JSXOpeningElement, tagName: string): boolean {
  const type = attrString(el, 'type');
  if (tagName === 'button') return type === 'submit';
  return SUBMIT_COMPONENT_NAME_RE.test(tagName) && type === 'submit';
}

function fieldFrom(el: JSXOpeningElement, tagName: string, fallbackIndex: number): FormField | null {
  const isNative = NATIVE_INPUT_TAGS.has(tagName);
  const declaredType = attrString(el, 'type');
  const isInputLike =
    isNative ||
    (declaredType && KNOWN_INPUT_TYPES.has(declaredType)) ||
    INPUT_COMPONENT_NAME_RE.test(tagName);
  if (!isInputLike) return null;

  const testId = attrString(el, 'data-testid');
  const name =
    attrString(el, 'name') ??
    attrString(el, 'label') ??
    testId ??
    attrString(el, 'id') ??
    `field-${fallbackIndex}`;
  const type =
    declaredType ?? (tagName === 'select' ? 'select' : tagName === 'textarea' ? 'textarea' : 'text');
  const required = hasTruthyAttr(el, 'required');

  return { name, type, required, ...(testId ? { testId } : {}) };
}

/**
 * AST-based form extraction: walks each `<form>` element's descendants for native
 * `<input>/<select>/<textarea>` fields AND custom input-like components (a `type` attribute
 * matching a known HTML input type, or a component name ending in Input/Field — covers common
 * design-system components like MUI's TextField or a bespoke MatInput that wrap a native input
 * with no native tag of their own). Returns null on parse failure so callers can skip the file
 * rather than crash the whole repo scan (there is no regex fallback for this new capability).
 */
export function extractFormsAst(rel: string, source: string): FormInfo[] | null {
  const ast: File | null = parseModule(source, rel);
  if (!ast) return null;
  return extractFormsFromAst(rel, ast);
}

/**
 * Same as extractFormsAst, but takes an already-parsed AST — for callers (source-index.ts) that
 * parse each file once and share the AST across every AST-based extractor.
 */
export function extractFormsFromAst(rel: string, ast: File): FormInfo[] {
  const forms: FormInfo[] = [];

  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const name = opening.name;
      if (!isJSXIdentifier(name) || name.name !== 'form') return;

      const fields: FormField[] = [];
      let submitLabel: string | undefined;

      path.traverse({
        JSXOpeningElement(inner) {
          const innerName = inner.node.name;
          if (!isJSXIdentifier(innerName)) return;
          const tagName = innerName.name;

          if (isSubmitControl(inner.node, tagName)) {
            const children = inner.parentPath.isJSXElement() ? inner.parentPath.node.children : [];
            const textChild = children.find((c) => c.type === 'JSXText' && c.value.trim().length > 0);
            if (textChild && textChild.type === 'JSXText') submitLabel = textChild.value.trim();
            return;
          }

          const field = fieldFrom(inner.node, tagName, fields.length + 1);
          if (field) fields.push(field);
        },
      });

      if (fields.length > 0 || submitLabel) {
        forms.push({ file: rel, fields, ...(submitLabel ? { submitLabel } : {}) });
      }
    },
  });

  return forms;
}
