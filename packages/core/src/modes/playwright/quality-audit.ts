/**
 * Static quality audit over a generated (and already parse-clean) spec's
 * source text — closes the gap identified comparing this codebase's
 * validator against the legacy TestBot_MCP validator's
 * `auditGeneratedTestQuality`: `validate.ts`'s parse-check gate proves a spec
 * is syntactically valid Playwright, but says nothing about whether it's a
 * genuinely useless or unsafe test (a block with no real assertion, a
 * hardcoded credential, an assertion racing a deliberately-disabled button).
 *
 * Deliberately narrower than legacy's ~50-check audit: every HARD check here
 * is provable from the spec's own text alone (no ground-truth/exploration
 * dependency), so this can't become a false-positive machine the way a
 * broader heuristic set risks becoming. Anything fuzzier is WARN-only,
 * mirroring the severity-split philosophy already used by
 * generate.ts's findUngroundedReferences.
 */

import type { QualityFinding } from '../types.js';
export type { QualityFinding } from '../types.js';

export interface TestBlock {
  title: string;
  /** Start offset of the `test(`/`test.only(`/etc. token. */
  start: number;
  /** End offset (exclusive), just past the block's closing `)` (and a trailing `;` / blank line if present). */
  end: number;
  body: string;
}

const TEST_CALL_OPEN_RE = /\btest(?:\.(?:only|skip|fixme))?\s*\(/g;
const TITLE_RE = /^\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/;

/**
 * From the index of an opening '(' in `source`, scan forward tracking
 * string/template-literal/comment state and paren/brace/bracket depth to
 * find the offset just past the matching ')'. Same bounded-tokenizer
 * approach as attemptBracketRepair (validate.ts), but scanning to a target
 * depth of zero rather than repairing at EOF. Returns null if the source
 * ends before the paren closes (malformed input — caller should skip it).
 */
function findMatchingParenEnd(source: string, openParenIndex: number): number | null {
  const CLOSER: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  let inLineComment = false;
  let inBlockComment = false;
  let stringChar: string | null = null;
  let escaped = false;

  for (let i = openParenIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (stringChar) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === stringChar) stringChar = null;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      stringChar = ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      const top = stack[stack.length - 1];
      if (top && CLOSER[top] === ch) {
        stack.pop();
        if (stack.length === 0) return i + 1;
      }
      continue;
    }
  }
  return null;
}

/**
 * Marks each character offset as "live code" (1) vs. inside a string,
 * template literal, or comment (0) — used to ignore a `test(...)`-shaped
 * token that only appears inside a comment or string literal rather than as
 * a real call.
 */
function computeCodeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  let inLineComment = false;
  let inBlockComment = false;
  let stringChar: string | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (stringChar) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === stringChar) stringChar = null;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      stringChar = ch;
      continue;
    }
    mask[i] = 1;
  }
  return mask;
}

/**
 * Structural split of top-level test(...)/test.only/skip/fixme(...) call
 * blocks (never test.describe wrappers — those are containers, not
 * assertable units). Bounded, not a real parser: malformed input that never
 * closes its opening paren is simply skipped rather than throwing.
 */
export function splitTestBlocks(source: string): TestBlock[] {
  const blocks: TestBlock[] = [];
  const codeMask = computeCodeMask(source);
  TEST_CALL_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEST_CALL_OPEN_RE.exec(source)) !== null) {
    if (codeMask[m.index] !== 1) continue;
    const openParenIndex = m.index + m[0].length - 1;
    const end = findMatchingParenEnd(source, openParenIndex);
    if (end === null) continue;
    // Swallow a trailing ';' and the rest of that line so pruning doesn't leave a stray semicolon.
    let realEnd = end;
    if (source[realEnd] === ';') realEnd += 1;
    if (source[realEnd] === '\n') realEnd += 1;

    const argsText = source.slice(openParenIndex + 1, end - 1);
    const titleMatch = TITLE_RE.exec(argsText);
    blocks.push({
      title: titleMatch ? titleMatch[2] : '',
      start: m.index,
      end: realEnd,
      body: source.slice(m.index, end),
    });
    TEST_CALL_OPEN_RE.lastIndex = end;
  }
  return blocks;
}

const HAS_EXPECT_RE = /\bexpect\s*\(/;
const WILDCARD_ASSERTION_RE = /to(?:HaveURL|HaveTitle)\(\s*\/\.\*\/[a-z]*\s*\)/;
const ABSOLUTE_URL_ASSERTION_RE = /toHaveURL\(\s*['"]https?:\/\/[^'"]+['"]\s*\)/;
const FILL_LITERAL_RE = /\.fill\(\s*['"]([^'"]*)['"]\s*\)/g;
const EMAIL_LITERAL_RE = /^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/;
/** Obviously-fake placeholder domains a model is expected to use for invented test data — not a real, potentially-sensitive credential. */
const PLACEHOLDER_EMAIL_RE = /@(example\.(com|org|net)|test\.(com|dev)|invalid|localhost)$/i;
const NEGATIVE_TITLE_HINT_RE = /\b(invalid|error|unauthoriz|denied|fails?|incorrect|wrong)\b/i;
const ENABLED_ASSERTION_RE = /\.(?:not\.toBeDisabled|toBeEnabled)\(\s*\)/;

/**
 * Audit a single spec's parse-clean source for quality findings. Returns
 * both block-scoped findings (used for Phase B pruning) and — currently
 * none, but the shape allows it — file-scoped ones.
 */
export function auditSpecQuality(source: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const blocks = splitTestBlocks(source);

  for (const block of blocks) {
    if (!HAS_EXPECT_RE.test(block.body)) {
      findings.push({
        code: 'empty-assertion-block',
        severity: 'hard',
        message: `Test "${block.title || '(untitled)'}" contains no expect(...) assertion — asserts nothing.`,
        testTitle: block.title,
        blockRange: [block.start, block.end],
      });
      // No assertions at all makes the other assertion-shaped checks moot for this block.
      continue;
    }

    if (WILDCARD_ASSERTION_RE.test(block.body)) {
      findings.push({
        code: 'useless-wildcard-assertion',
        severity: 'hard',
        message: `Test "${block.title || '(untitled)'}" asserts toHaveURL(/.*/ ) or toHaveTitle(/.*/ ) — a wildcard regex matches anything and verifies nothing.`,
        testTitle: block.title,
        blockRange: [block.start, block.end],
      });
    }

    if (ABSOLUTE_URL_ASSERTION_RE.test(block.body)) {
      findings.push({
        code: 'absolute-url-assertion',
        severity: 'warn',
        message: `Test "${block.title || '(untitled)'}" asserts toHaveURL(...) against a hardcoded absolute http(s) URL — fragile across hosts/ports/environments.`,
        testTitle: block.title,
        blockRange: [block.start, block.end],
      });
    }

    for (const fm of block.body.matchAll(FILL_LITERAL_RE)) {
      const value = fm[1];
      if (EMAIL_LITERAL_RE.test(value) && !PLACEHOLDER_EMAIL_RE.test(value)) {
        findings.push({
          code: 'hardcoded-credential-literal',
          severity: 'warn',
          message: `Test "${block.title || '(untitled)'}" fills a non-placeholder-looking email literal ("${value}") — prefer an obviously-fake placeholder domain (e.g. *.example.com) for invented test data.`,
          testTitle: block.title,
          blockRange: [block.start, block.end],
        });
      }
    }

    if (NEGATIVE_TITLE_HINT_RE.test(block.title) && ENABLED_ASSERTION_RE.test(block.body)) {
      findings.push({
        code: 'disabled-button-race-risk',
        severity: 'warn',
        message: `Test "${block.title}" reads as a negative-path scenario but asserts a control becomes enabled — if the app correctly keeps it disabled on invalid input, this assertion will time out. Consider asserting it stays disabled instead.`,
        testTitle: block.title,
        blockRange: [block.start, block.end],
      });
    }
  }

  return findings;
}

/**
 * Remove every HARD-finding's block range from `source`, returning the
 * pruned text (or null if there was nothing to prune). Ranges are removed
 * highest-offset-first so earlier offsets stay valid across the splice.
 * Overlapping/duplicate ranges (multiple hard findings in the same block)
 * collapse naturally since removing an already-removed range is a no-op.
 */
export function pruneHardFindings(source: string, findings: QualityFinding[]): string | null {
  const ranges = findings
    .filter(
      (f): f is QualityFinding & { blockRange: [number, number] } => f.severity === 'hard' && !!f.blockRange,
    )
    .map((f) => f.blockRange);
  if (ranges.length === 0) return null;

  const sorted = [...ranges].sort((a, b) => b[0] - a[0]);
  let result = source;
  let lastRemovedStart = Infinity;
  for (const [start, end] of sorted) {
    if (end <= lastRemovedStart) {
      result = result.slice(0, start) + result.slice(end);
      lastRemovedStart = start;
    }
  }
  return result;
}
