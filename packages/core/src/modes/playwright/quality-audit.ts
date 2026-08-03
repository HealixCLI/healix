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
import { DESTRUCTIVE_ACTION_TEXT_RE } from '../../browser/crawler.js';
export type { QualityFinding } from '../types.js';

export interface TestBlock {
  title: string;
  /** Start offset of the `test(`/`test.only(`/etc. token. */
  start: number;
  /** End offset (exclusive), just past the block's closing `)` (and a trailing `;` / blank line if present). */
  end: number;
  /**
   * End offset (exclusive) just past the closing quote of the block's title literal — i.e. the
   * insertion point for a second argument. Absent when the block's first argument isn't a
   * string literal at all. Exposed so a caller can splice a `TestDetails` object in after the
   * title without re-parsing: the title may contain escaped quotes (real generated titles do,
   * e.g. `'... the user\'s email ...'`), which TITLE_RE already handles correctly and a naive
   * regex in the caller would not.
   */
  titleEnd?: number;
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
      // TITLE_RE is `^`-anchored, so titleMatch[0] spans from argsText's start (including any
      // leading whitespace) through the closing quote.
      titleEnd: titleMatch ? openParenIndex + 1 + titleMatch[0].length : undefined,
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
/** Non-global existence check for "does this block fill anything at all" — kept separate from FILL_LITERAL_RE so `.test()` here never disturbs that regex's shared `lastIndex` (it's iterated via matchAll elsewhere in this same function). */
const HAS_FILL_RE = /\.fill\(/;
const EMAIL_LITERAL_RE = /^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/;
/** Obviously-fake placeholder domains a model is expected to use for invented test data — not a real, potentially-sensitive credential. */
const PLACEHOLDER_EMAIL_RE = /@(example\.(com|org|net)|test\.(com|dev)|invalid|localhost)$/i;
const NEGATIVE_TITLE_HINT_RE = /\b(invalid|error|unauthoriz|denied|fails?|incorrect|wrong)\b/i;
const ENABLED_ASSERTION_RE = /\.(?:not\.toBeDisabled|toBeEnabled)\(\s*\)/;
/** Asserts a control STAYS disabled — the correct pattern for a negative/invalid-input scenario, so its presence rules out the click-race check below. */
const DISABLED_ASSERTION_RE = /(?<!\.not)\.toBeDisabled\(\s*\)/;
/** A `.click(...)` call whose own line/statement mentions a submit-ish hint (testid, name, role, or button label) — English + a few observed Slovak equivalents. Not a full parser; matches the shape actual generated specs use (`locator('button[data-testid="login-submit"]').click()`). */
const SUBMIT_CLICK_RE =
  /[^\n;]*(?:submit|login|log-in|sign-?in|register|continue|confirm|save|pokra[cč]ova|odosla|prihl[aá]s|zaregistruj)[^\n;]*\.click\(\s*\)/i;

/**
 * A single-target interaction — real triage data across multiple runs traced repeat
 * `test_is_wrong` failures to exactly this shape: a generated locator that LOOKS grounded
 * (a real observed role/text) but happens to match more than one element on the live page,
 * so Playwright throws a strict-mode violation instead of performing the action.
 */
const SINGULAR_ACTION_LINE_RE = /\.(?:click|dblclick|check|uncheck|hover|selectOption|fill)\(/;
/** Roles that commonly repeat within a page (nav links, list buttons, table rows) — landmark roles like 'main'/'navigation' are deliberately excluded as low-risk singletons. */
const GET_BY_ROLE_REPEATABLE_NO_NAME_RE =
  /getByRole\(\s*['"](?:link|button|checkbox|radio|menuitem|tab|option|listitem|row|cell)['"]\s*\)/;
/** Short text/labels ("baz", "Edit", "Delete") are the ones observed to collide across a real page; long, sentence-length text is unlikely to duplicate, so is excluded to keep this signal precise. */
const GET_BY_TEXT_SHORT_RE = /getByText\(\s*['"]([^'"]{1,20})['"]\s*\)/;
/** A bare class or tag CSS selector (`.btn`, `button`, `a`) — as opposed to an id/data-testid/attribute selector, which is presumed unique. */
const LOCATOR_CLASS_OR_TAG_RE = /\.locator\(\s*['"](?:\.[a-zA-Z][\w-]*|[a-zA-Z][a-zA-Z0-9]*)['"]\s*\)/;
/** Any of these on the same line negates the risk: the locator is already scoped to one match. */
const AMBIGUOUS_LOCATOR_SAFETY_RE =
  /\.(?:first|last|nth)\(|\{\s*(?:name|exact)\s*:|getByTestId\(|\[(?:data-testid|id)=/;

/** A line containing a `.click(...)` call — checked against DESTRUCTIVE_ACTION_TEXT_RE below via
 * the accessible name/text it targets (see ACCESSIBLE_NAME_ON_LINE_RE), not the whole line, so an
 * unrelated CSS/testid string elsewhere on the same line can't cause a false match. */
const HAS_CLICK_RE = /\.click\(/;
/** Pulls the accessible name/text out of a getByRole({name:...})/getByText(...)/getByLabel(...)
 * call on the same line as a `.click(...)` — deliberately scoped to these accessible-name-bearing
 * locator forms (not a bare CSS/testid selector, which could contain an unrelated substring) so
 * the destructive-action match below is checked against what a user would actually read/click. */
const ACCESSIBLE_NAME_ON_LINE_RE =
  /getBy(?:Role\([^)]*\bname:\s*['"]([^'"]+)['"]|Text\(\s*['"]([^'"]+)['"]|Label\(\s*['"]([^'"]+)['"])/;
/** True when `block.body` itself is a `test.fixme(...)` call — Healix's sanctioned way to mark a
 * step it deliberately does not execute (see Cluster C's OTP/destructive-action gating). */
const IS_FIXME_BLOCK_RE = /^test\.fixme\s*\(/;

/** A `getByRole('dialog'|'alertdialog', ...)` or `[role="dialog"|"alertdialog"]` reference —
 * used both to detect "this block already knows a modal exists" and "this getByText call is
 * itself dialog-scoped" (see unscoped-modal-assertion, Cluster E). */
const DIALOG_ROLE_REF_RE = /getByRole\(\s*['"](?:alert)?dialog['"]|\[role=["'](?:alert)?dialog["']\]/;
/** A single line containing both an `expect(...)` and a `getByText(...)` call. */
const EXPECT_GET_BY_TEXT_LINE_RE = /expect\(.*getByText\(/;

/**
 * A second, independent real-data-traced false-failure shape: a tierC-api negative/error-path
 * scenario asserting a fixed "success-shaped" status code (200/201/204) with no grounding —
 * many apps correctly respond to a failed request with a redirect (3xx) or an explicit error
 * status (4xx) instead, so this is exactly as likely to be a wrong test assumption as a real bug.
 */
const SUCCESS_STATUS_ASSERTION_RE = /\.status\(\)\s*\)\.toBe\(\s*(?:200|201|204)\s*\)/;

/**
 * Audit a single spec's parse-clean source for quality findings. Returns
 * both block-scoped findings (used for Phase B pruning) and — currently
 * none, but the shape allows it — file-scoped ones.
 */
export function auditSpecQuality(source: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const blocks = splitTestBlocks(source);

  for (const block of blocks) {
    // Checked unconditionally, even for a block with no expect(...) at all — a spec that clicks
    // "Delete account"/"Pay now" without wrapping it in test.fixme(...) is dangerous regardless of
    // whether it also asserts anything (see Cluster C, discussed with the user: OTP/destructive
    // steps must never be auto-completed, so this is a genuine safety backstop independent of
    // whether the model followed generate.ts's prompt guidance).
    if (!IS_FIXME_BLOCK_RE.test(block.body)) {
      for (const line of block.body.split('\n')) {
        if (!HAS_CLICK_RE.test(line)) continue;
        const nameMatch = ACCESSIBLE_NAME_ON_LINE_RE.exec(line);
        const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
        if (!name || !DESTRUCTIVE_ACTION_TEXT_RE.test(name)) continue;
        findings.push({
          code: 'unattended-destructive-action',
          severity: 'hard',
          message: `Test "${block.title || '(untitled)'}" clicks a control named "${name}" — wording that reads as a destructive/irreversible action (delete/remove/payment) — without wrapping it in test.fixme(...). Healix never completes this kind of step automatically (it could delete real data or trigger a real payment against the app under test); mark this test test.fixme('<title> — requires a destructive/irreversible action Healix will not execute automatically; run manually', ...) instead, covering only the steps up to (not including) this click.`,
          testTitle: block.title,
          blockRange: [block.start, block.end],
        });
        break; // one finding per block is enough signal.
      }
    }

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

    // unscoped-modal-assertion (Cluster E): fires ONLY when this block already references a
    // dialog-role locator elsewhere (proving it knows a modal exists) but an expect(...)'s
    // getByText(...) isn't itself scoped to it — a purely static heuristic (no ground truth
    // available here, unlike generate.ts's F-11 check), so WARN only.
    if (DIALOG_ROLE_REF_RE.test(block.body)) {
      for (const line of block.body.split('\n')) {
        if (!EXPECT_GET_BY_TEXT_LINE_RE.test(line)) continue;
        const getByTextIdx = line.indexOf('getByText(');
        if (getByTextIdx !== -1 && DIALOG_ROLE_REF_RE.test(line.slice(0, getByTextIdx))) continue;
        findings.push({
          code: 'unscoped-modal-assertion',
          severity: 'warn',
          message: `Test "${block.title || '(untitled)'}" references a dialog/modal elsewhere but asserts on a page-level getByText(...) not scoped to that dialog — if the same text is also permanent static copy elsewhere on the page, this assertion can pass or fail without the modal actually being open. Scope it via a dialog-role container locator (e.g. page.getByRole('dialog').getByText(...)) or assert modal-exclusive text instead.`,
          testTitle: block.title,
          blockRange: [block.start, block.end],
        });
        break; // one finding per block is enough signal.
      }
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
    } else if (
      NEGATIVE_TITLE_HINT_RE.test(block.title) &&
      HAS_FILL_RE.test(block.body) &&
      SUBMIT_CLICK_RE.test(block.body) &&
      !DISABLED_ASSERTION_RE.test(block.body)
    ) {
      // The dominant real-world failure shape: fill invalid data, then click a submit-like
      // control assuming the click succeeds and a validation message appears — with no
      // assertion anywhere that the control is (or stays) disabled. If the app correctly
      // disables the control on invalid input, the click itself hangs until the Playwright
      // timeout instead of ever reaching an assertion. HARD (not the narrower WARN case
      // above) because this is provable from the block's own text: a negative scenario that
      // clicks a submit control with zero disabled/enabled awareness anywhere in the block.
      findings.push({
        code: 'disabled-button-click-race',
        severity: 'hard',
        message: `Test "${block.title}" fills invalid input then clicks a submit-like control with no assertion of its disabled/enabled state anywhere in the test — if the app correctly disables the control on invalid input, this click will hang until timeout. Assert the control stays disabled (\`toBeDisabled()\`), or assert the inline validation message without depending on the click succeeding.`,
        testTitle: block.title,
        blockRange: [block.start, block.end],
      });
    }

    for (const line of block.body.split('\n')) {
      if (!SINGULAR_ACTION_LINE_RE.test(line)) continue;
      if (AMBIGUOUS_LOCATOR_SAFETY_RE.test(line)) continue;
      if (
        GET_BY_ROLE_REPEATABLE_NO_NAME_RE.test(line) ||
        GET_BY_TEXT_SHORT_RE.test(line) ||
        LOCATOR_CLASS_OR_TAG_RE.test(line)
      ) {
        findings.push({
          code: 'ambiguous-locator-risk',
          severity: 'warn',
          message: `Test "${block.title || '(untitled)'}" performs a single-target action (click/fill/check/etc.) on a locator that isn't scoped to guarantee exactly one match — a bare role/short-text/class locator with no distinguishing { name: ... }/{ exact: true } filter, data-testid/id, or .first()/.nth()/.last(). If the real page has more than one matching element, Playwright throws a strict-mode violation at runtime instead of performing the action. Narrow the locator or chain .first()/.nth() when a specific match is intended.`,
          testTitle: block.title,
          blockRange: [block.start, block.end],
        });
        break; // one finding per block is enough signal; avoid noisy duplicates on repeat lines.
      }
    }

    if (NEGATIVE_TITLE_HINT_RE.test(block.title) && SUCCESS_STATUS_ASSERTION_RE.test(block.body)) {
      findings.push({
        code: 'unvalidated-status-code-assumption',
        severity: 'warn',
        message: `Test "${block.title}" reads as a negative/error-path scenario but asserts a fixed success-shaped status code (200/201/204) — many apps respond to a failed request with a redirect (3xx) or an explicit error status (4xx) instead. Unless this exact status is grounded in real observed/spec behavior, prefer asserting what you're sure of (e.g. \`expect(response.status()).not.toBe(200)\`, a 3xx/4xx range check, or a documented error field) rather than a guessed fixed success code.`,
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
