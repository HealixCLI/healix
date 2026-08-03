/**
 * Unit tests for the PURE selector helpers in `selectors.ts`.
 *
 * WHY THESE HELPERS ARE MIRRORED, NOT IMPORTED
 * --------------------------------------------
 * `selectors.ts` exports exactly one symbol: `collectInteractiveElements`, and
 * that function takes a live Playwright `Page` and runs its real logic INSIDE
 * `page.evaluate(...)` — i.e. inside a browser. The pure helpers we want to
 * pin (the `cssEscape` fallback, the accessible-name `clamp`, and the
 * `selectorFor` `#id` builder) are private closures declared within that
 * `evaluate` callback; they are NOT exported and there is no browserless entry
 * point that reaches them.
 *
 * Per the task constraints we must NOT import 'playwright' and must stay
 * deterministic + fully offline (vitest runs in the `node` environment, so
 * there is no DOM, no `CSS.escape`, no `document`). Driving the real export
 * would require both a browser and the forbidden import. The next-best,
 * fully-offline thing is to pin the documented CONTRACTS of those helpers by
 * re-stating their pure logic here, copied byte-for-byte from `selectors.ts`,
 * and asserting the behaviours the task calls out:
 *
 *   1. an id beginning with a digit is escaped to a VALID CSS selector
 *      (`#123` is invalid; the leading digit must be unicode-escaped), and
 *   2. accessible-name sources are whitespace-collapsed and clamped to <=200
 *      chars.
 *
 * If `selectors.ts` ever exports these helpers (or a browserless variant), this
 * file should import them directly instead of mirroring. The mirrored copies
 * below are intentionally identical to the source so a drift in the real impl
 * is a signal to revisit this test — they are a contract spec, not a fork.
 */
import { describe, expect, it } from 'vitest';

// --- Mirrored helpers (verbatim from selectors.ts `page.evaluate` callback) ---

/** Minimal structural view used by the mirrored `cssEscape` fallback. */
interface CssGlobal {
  CSS?: { escape?: (value: string) => string };
}

/**
 * Fallback escaper, copied verbatim from `selectorFor`'s `cssEscape` closure.
 * `win` is the page's `globalThis`; in the node test env `CSS` is absent, so the
 * fallback branch always runs — which is precisely the branch we want to pin.
 */
function cssEscape(win: CssGlobal, value: string): string {
  if (win.CSS && typeof win.CSS.escape === 'function') {
    return win.CSS.escape(value);
  }
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    if (i === 0 && ch >= '0' && ch <= '9') {
      result += `\\${ch.charCodeAt(0).toString(16)} `;
    } else if (/[a-zA-Z0-9_-]/.test(ch)) {
      result += ch;
    } else {
      result += `\\${ch}`;
    }
  }
  return result;
}

/**
 * Accessible-name normalizer, copied verbatim from the `clamp` closure used by
 * every name source in `accessibleName`.
 */
function clamp(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 200).trim();
}

/** A node global with no `CSS` defined — the real shape under the node test env. */
const NO_CSS: CssGlobal = {};

/**
 * `buttonType` inference, copied verbatim from the `page.evaluate` callback's
 * per-element loop. An untyped `<button>` inside a `<form>` implicitly
 * submits per HTML spec — this must be reflected as `buttonType: 'submit'`
 * even when no literal `type` attribute is present, or `findLoginSubmitButton`
 * (login.ts) silently loses its most reliable, locale-agnostic detection tier.
 */
function inferButtonType(rawType: string, inForm: boolean): string {
  return rawType || (inForm ? 'submit' : '');
}

/**
 * Dynamic-id filter, copied verbatim from `selectorFor`'s `isLikelyDynamicId` in
 * selectors.ts. These id shapes are reassigned per render tree (React's useId(), MUI's mui-N) or
 * generated/enumerated per record (UUIDs, hash-based ids, alpha+long-digit ids) rather than
 * persisted across page loads, so a selector built from one resolves against a different
 * element (or nothing) on the next load.
 */
const FRAMEWORK_ID_RE = /^_r_[0-9a-z]+_$|^:r[0-9a-z]+:$|^mui-\d+$|^:[a-z0-9]+:$/i;
const UUID_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RUN_RE = /^[0-9a-f]{10,}$/i;
const SHORT_ALPHA_LONG_DIGIT_RE = /^[a-z]{1,8}[-_:]?\d{5,}$/i;

function isLikelyDynamicId(id: string): boolean {
  return (
    FRAMEWORK_ID_RE.test(id) ||
    UUID_ID_RE.test(id) ||
    LONG_HEX_RUN_RE.test(id) ||
    SHORT_ALPHA_LONG_DIGIT_RE.test(id)
  );
}

describe('selectors.isLikelyDynamicId (dynamic id detection)', () => {
  it('flags React useId() shapes as unstable', () => {
    expect(isLikelyDynamicId('_r_4_')).toBe(true);
    expect(isLikelyDynamicId('_r_6_')).toBe(true);
    expect(isLikelyDynamicId(':r4:')).toBe(true);
    expect(isLikelyDynamicId(':r4h:')).toBe(true);
  });

  it('flags MUI-style generated ids as unstable', () => {
    expect(isLikelyDynamicId('mui-3')).toBe(true);
    expect(isLikelyDynamicId('mui-42')).toBe(true);
  });

  it('flags a UUID-shaped id', () => {
    expect(isLikelyDynamicId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('flags a long unbroken hex run (e.g. a Mongo ObjectId or hash-based id)', () => {
    expect(isLikelyDynamicId('507f1f77bcf86cd799439011')).toBe(true);
    expect(isLikelyDynamicId('0123456789abcdef')).toBe(true);
  });

  it('flags a short alpha prefix followed by a long digit run', () => {
    expect(isLikelyDynamicId('item-48213')).toBe(true);
    expect(isLikelyDynamicId('row_910284')).toBe(true);
    expect(isLikelyDynamicId('r12345')).toBe(true);
  });

  it('does not flag stable, developer-authored ids', () => {
    expect(isLikelyDynamicId('login-email')).toBe(false);
    expect(isLikelyDynamicId('submit-btn_1')).toBe(false);
    expect(isLikelyDynamicId('password')).toBe(false);
  });

  it('does not flag a short alpha+digit id below the 5-digit threshold (avoids false positives)', () => {
    expect(isLikelyDynamicId('section-1')).toBe(false);
    expect(isLikelyDynamicId('step2')).toBe(false);
    expect(isLikelyDynamicId('field-42')).toBe(false);
  });

  it('does not flag a bare numeric id (a small numeric id is plausibly a stable DB record id)', () => {
    expect(isLikelyDynamicId('123')).toBe(false);
    expect(isLikelyDynamicId('42')).toBe(false);
  });
});

describe('selectors.buttonType inference (implicit HTML submit semantics)', () => {
  it('treats an untyped <button> inside a <form> as submit', () => {
    expect(inferButtonType('', true)).toBe('submit');
  });

  it('leaves an untyped <button> with no enclosing <form> as non-submit', () => {
    expect(inferButtonType('', false)).toBe('');
  });

  it('never overrides an explicit type attribute, in or out of a form', () => {
    expect(inferButtonType('button', true)).toBe('button');
    expect(inferButtonType('reset', false)).toBe('reset');
  });
});

describe('selectors.cssEscape (fallback escaper)', () => {
  it('escapes an id beginning with a digit into a VALID CSS selector', () => {
    // `#123abc` is NOT a valid selector. The first digit must be written as a
    // unicode code point so `#<escaped>` is parseable.
    const escaped = cssEscape(NO_CSS, '123abc');
    const selector = `#${escaped}`;

    // The leading '1' (U+0031 -> hex 31) becomes "\31 " (note the trailing
    // space terminating the hex escape); the rest are identifier chars.
    expect(escaped).toBe('\\31 23abc');
    expect(selector).toBe('#\\31 23abc');

    // It must not be the raw invalid form, and the digit must not survive as a
    // literal leading digit right after the escape sequence.
    expect(selector).not.toBe('#123abc');
    expect(escaped.startsWith('\\31 ')).toBe(true);

    // Sanity-check validity against a real parser when one is available
    // (jsdom/browser). In the bare node env there is no `document`, so we skip
    // rather than fail — the assertion stays deterministic + offline.
    assertParsesIfPossible(selector);
  });

  it('escapes a single digit id (the minimal digit-leading case)', () => {
    // '9' -> U+0039 -> hex 39 -> "\39 ".
    expect(cssEscape(NO_CSS, '9')).toBe('\\39 ');
    expect(`#${cssEscape(NO_CSS, '0')}`).toBe('#\\30 ');
  });

  it('leaves a plain identifier untouched', () => {
    expect(cssEscape(NO_CSS, 'submit-btn_1')).toBe('submit-btn_1');
  });

  it('escapes non-identifier characters individually (not the first char)', () => {
    // A space and a dot are not in [a-zA-Z0-9_-]; each is backslash-escaped.
    expect(cssEscape(NO_CSS, 'a b.c')).toBe('a\\ b\\.c');
    // A colon (e.g. an Angular/Tailwind-style id) is escaped too.
    expect(cssEscape(NO_CSS, 'menu:item')).toBe('menu\\:item');
  });

  it('only the FIRST char gets unicode-escaped when it is a digit; later digits are literal', () => {
    // The digit rule is positional (i === 0). 'a1' keeps its later digit raw.
    expect(cssEscape(NO_CSS, 'a1')).toBe('a1');
    // But a leading digit followed by a non-id char escapes both ways.
    expect(cssEscape(NO_CSS, '1.2')).toBe('\\31 \\.2');
  });

  it('prefers the native CSS.escape when the page provides one', () => {
    // When running in a real browser, `win.CSS.escape` exists and is used
    // verbatim. We assert the delegation branch is taken.
    const calls: string[] = [];
    const withNative: CssGlobal = {
      CSS: {
        escape: (v: string) => {
          calls.push(v);
          return `NATIVE(${v})`;
        },
      },
    };
    expect(cssEscape(withNative, '123abc')).toBe('NATIVE(123abc)');
    expect(calls).toEqual(['123abc']);
  });
});

describe('selectors.clamp (accessible-name normalizer)', () => {
  it('clamps an over-long name source to exactly 200 chars', () => {
    const long = 'x'.repeat(500);
    const out = clamp(long);
    expect(out).toHaveLength(200);
    expect(out).toBe('x'.repeat(200));
  });

  it('keeps a short name source at its natural length (<=200 passes through)', () => {
    const exact = 'y'.repeat(200);
    expect(clamp(exact)).toHaveLength(200);
    expect(clamp(exact)).toBe(exact);

    const under = 'z'.repeat(199);
    expect(clamp(under)).toHaveLength(199);
  });

  it('collapses internal whitespace runs to single spaces', () => {
    expect(clamp('hello     world')).toBe('hello world');
    // Tabs and newlines are whitespace too and collapse to one space.
    expect(clamp('a\t\tb\n\nc')).toBe('a b c');
  });

  it('trims leading and trailing whitespace', () => {
    expect(clamp('   padded label   ')).toBe('padded label');
    expect(clamp('\n\t mixed \t\n')).toBe('mixed');
  });

  it('collapses THEN clamps so the 200-char cap is on the collapsed text', () => {
    // 250 single chars separated by big whitespace runs. After collapse this is
    // "c c c ..." (one space between each); the cap then bites on that result,
    // never on the pre-collapse length.
    const noisy = Array.from({ length: 250 }, () => 'c').join('     \n\t  ');
    const out = clamp(noisy);
    // The cap bites on the COLLAPSED text (~499 chars), never the pre-collapse
    // length, so the result lands at the 200-char window. When the cut falls on
    // a separator the trailing space is dropped, so the length is <=200 (199
    // here) — the point is the cap is on the collapsed form, not that it is
    // exactly 200 every time.
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.length).toBeGreaterThanOrEqual(199);
    // No double spaces survived the collapse within the clamped window.
    expect(out).not.toMatch(/\s{2,}/);
    // And no leading/trailing whitespace remains.
    expect(out).toBe(out.trim());
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(clamp('   \n\t  ')).toBe('');
    expect(clamp('')).toBe('');
  });
});

/**
 * Assert a selector is parseable IF a DOM parser is reachable, otherwise no-op.
 *
 * The core package's vitest config uses the `node` environment, so `document`
 * is normally undefined and this is a deterministic skip. If the suite is ever
 * run under jsdom/happy-dom, we get a real validity check for free. We never
 * fail merely because no parser exists — that would make the test
 * environment-dependent.
 */
/**
 * Role+name ambiguity post-pass, copied verbatim (as plain-array logic, no DOM
 * dependency) from the tail of `collectInteractiveElements`'s `page.evaluate`
 * callback — flags every element whose (role, name) pair is shared by another
 * visible element on the same page, since a generated `getByRole(role, {
 * name })` locator would strict-mode-violate against either one.
 */
interface AmbiguityCheckItem {
  role: string;
  name: string;
  ambiguousMatch?: boolean;
}

function flagAmbiguousMatches(out: AmbiguityCheckItem[]): void {
  const roleNameCounts = new Map<string, number>();
  for (const item of out) {
    if (!item.name) continue;
    const key = `${item.role} ${item.name}`;
    roleNameCounts.set(key, (roleNameCounts.get(key) ?? 0) + 1);
  }
  for (const item of out) {
    if (!item.name) continue;
    const key = `${item.role} ${item.name}`;
    if ((roleNameCounts.get(key) ?? 0) > 1) {
      item.ambiguousMatch = true;
    }
  }
}

describe('selectors.flagAmbiguousMatches (role+name duplicate detection)', () => {
  it('flags two elements sharing the same role and name', () => {
    const out: AmbiguityCheckItem[] = [
      { role: 'link', name: 'foo' },
      { role: 'link', name: 'foo' },
    ];
    flagAmbiguousMatches(out);
    expect(out[0].ambiguousMatch).toBe(true);
    expect(out[1].ambiguousMatch).toBe(true);
  });

  it('does not flag elements with the same name but different roles', () => {
    const out: AmbiguityCheckItem[] = [
      { role: 'link', name: 'foo' },
      { role: 'button', name: 'foo' },
    ];
    flagAmbiguousMatches(out);
    expect(out[0].ambiguousMatch).toBeUndefined();
    expect(out[1].ambiguousMatch).toBeUndefined();
  });

  it('does not flag a unique role+name pair', () => {
    const out: AmbiguityCheckItem[] = [
      { role: 'link', name: 'foo' },
      { role: 'link', name: 'bar' },
    ];
    flagAmbiguousMatches(out);
    expect(out[0].ambiguousMatch).toBeUndefined();
    expect(out[1].ambiguousMatch).toBeUndefined();
  });

  it('ignores elements with an empty accessible name (nothing for getByRole name-matching to collide on)', () => {
    const out: AmbiguityCheckItem[] = [
      { role: 'generic', name: '' },
      { role: 'generic', name: '' },
    ];
    flagAmbiguousMatches(out);
    expect(out[0].ambiguousMatch).toBeUndefined();
    expect(out[1].ambiguousMatch).toBeUndefined();
  });

  it('flags all members when three or more elements collide', () => {
    const out: AmbiguityCheckItem[] = [
      { role: 'row', name: 'Edit' },
      { role: 'row', name: 'Edit' },
      { role: 'row', name: 'Edit' },
    ];
    flagAmbiguousMatches(out);
    expect(out.every((o) => o.ambiguousMatch === true)).toBe(true);
  });
});

function assertParsesIfPossible(selector: string): void {
  const maybeDoc = (globalThis as { document?: { querySelector?(s: string): unknown } }).document;
  if (!maybeDoc || typeof maybeDoc.querySelector !== 'function') {
    return;
  }
  // A valid selector that matches nothing returns null without throwing; an
  // invalid one throws a SyntaxError. So "does not throw" == "is valid".
  expect(() => maybeDoc.querySelector?.(selector)).not.toThrow();
}

// --- Mirrored selectorFor() tier/repeatedRowText harness ---
//
// selectorFor() itself needs a real DOM (querySelectorAll uniqueness checks, parentElement
// walks), so this mirrors its exact branch structure over a minimal fake element tree built from
// plain objects, rather than a real `document`. Kept in sync with selectors.ts's `selectorFor`;
// a drift in the real impl is a signal to revisit this mirror, same convention as the rest of
// this file.

interface FakeEl {
  id: string;
  tagName: string;
  textContent: string | null;
  nodeType: number;
  parentElement: FakeEl | null;
  children: FakeEl[];
  attrs: Record<string, string>;
  /** Simulated `getComputedStyle(el).cursor` — only relevant to the GAP-053 mirror below. */
  cursor?: string;
  /** Simulated visibility gate — only relevant to the GAP-053 mirror below. */
  hidden?: boolean;
}

function fakeEl(
  tag: string,
  opts: Partial<Pick<FakeEl, 'id' | 'textContent' | 'attrs' | 'cursor' | 'hidden'>> = {},
): FakeEl {
  return {
    id: opts.id ?? '',
    tagName: tag,
    textContent: opts.textContent ?? null,
    nodeType: 1,
    parentElement: null,
    children: [],
    attrs: opts.attrs ?? {},
    cursor: opts.cursor,
    hidden: opts.hidden,
  };
}

function appendChild(parent: FakeEl, child: FakeEl): void {
  child.parentElement = parent;
  parent.children.push(child);
}

/** A tiny querySelectorAll sufficient for selectorFor's uniqueness checks: #id and tag[attr="val"]. */
function fakeQuerySelectorAll(root: FakeEl[], selector: string): FakeEl[] {
  const all: FakeEl[] = [];
  const visit = (el: FakeEl) => {
    all.push(el);
    el.children.forEach(visit);
  };
  root.forEach(visit);

  const idMatch = /^#(.+)$/.exec(selector);
  if (idMatch) {
    // Selector-escaped ids (e.g. "\31 23abc") never match a plain fake id in these tests, so a
    // literal comparison against the unescaped id is sufficient here.
    return all.filter((el) => el.id === idMatch[1]);
  }
  const attrMatch = /^([a-z0-9]+)\[([a-z-]+)="([^"]*)"\]$/i.exec(selector);
  if (attrMatch) {
    const [, tag, attr, val] = attrMatch;
    return all.filter((el) => el.tagName === tag && el.attrs[attr!] === val);
  }
  return [];
}

function isLikelyDynamicIdMirror(id: string): boolean {
  return isLikelyDynamicId(id);
}

interface SelectorResult {
  selector: string;
  tier: 1 | 2 | 3 | 4;
  repeatedRowText?: string;
}

/** Verbatim port of selectors.ts's `selectorFor`, over the fake tree instead of a real DOM. */
function selectorForMirror(root: FakeEl[], el: FakeEl): SelectorResult {
  const qsa = (selector: string) => fakeQuerySelectorAll(root, selector);

  if (el.id && !isLikelyDynamicIdMirror(el.id)) {
    const idCandidate = `#${el.id}`;
    if (qsa(idCandidate).length === 1) {
      return { selector: idCandidate, tier: 3 };
    }
  }

  const tag = el.tagName.toLowerCase();
  const testIdAttrs = ['data-testid', 'data-test'];
  const nameAttrs = ['name', 'aria-label'];
  for (const attr of [...testIdAttrs, ...nameAttrs]) {
    const val = el.attrs[attr];
    if (val) {
      const candidate = `${tag}[${attr}="${val.replace(/"/g, '\\"')}"]`;
      if (qsa(candidate).length === 1) {
        return { selector: candidate, tier: testIdAttrs.includes(attr) ? 1 : 2 };
      }
    }
  }

  if (tag === 'a') {
    const href = el.attrs['href'];
    if (href) {
      const candidate = `a[href="${href.replace(/"/g, '\\"')}"]`;
      if (qsa(candidate).length === 1) {
        return { selector: candidate, tier: 2 };
      }
    }
  }

  const parts: string[] = [];
  let repeatedRowText: string | undefined;
  let node: FakeEl | null = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    const current: FakeEl = node;
    let part = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (parent) {
      const siblings = parent.children;
      const sameTag = siblings.filter((c) => c.tagName === current.tagName);
      if (sameTag.length > 1) {
        const index = sameTag.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
        // Overwritten (not set-once) on every repeated-sibling level — the OUTERMOST collision
        // found while climbing wins, since real markup often nests a shallow repeated wrapper
        // (e.g. a button-column div shared verbatim by every row) inside the actual repeated
        // row/card whose text is the row's real identifying content.
        repeatedRowText = clamp(current.textContent ?? '');
      }
    }
    parts.unshift(part);
    if (current.id && !isLikelyDynamicIdMirror(current.id) && qsa(`#${current.id}`).length === 1) {
      parts[0] = `#${current.id}`;
      break;
    }
    node = parent;
  }
  return { selector: parts.join(' > '), tier: 4, ...(repeatedRowText ? { repeatedRowText } : {}) };
}

describe('selectors.selectorFor tiering + repeatedRowText (mirrored)', () => {
  it('returns tier 1 for a data-testid/data-test match', () => {
    const btn = fakeEl('button', { attrs: { 'data-testid': 'submit-btn' } });
    const result = selectorForMirror([btn], btn);
    expect(result.tier).toBe(1);
    expect(result.selector).toBe('button[data-testid="submit-btn"]');
  });

  it('returns tier 2 for a name/aria-label match', () => {
    const input = fakeEl('input', { attrs: { name: 'email' } });
    const result = selectorForMirror([input], input);
    expect(result.tier).toBe(2);
    expect(result.selector).toBe('input[name="email"]');
  });

  it('returns tier 3 for a unique, stable #id', () => {
    const el = fakeEl('div', { id: 'login-email' });
    const result = selectorForMirror([el], el);
    expect(result.tier).toBe(3);
    expect(result.selector).toBe('#login-email');
  });

  it('falls through a dynamic id to the positional fallback (tier 4)', () => {
    const el = fakeEl('div', { id: 'mui-3' });
    const result = selectorForMirror([el], el);
    expect(result.tier).toBe(4);
  });

  it('returns tier 4 with repeatedRowText when the element sits among repeated siblings', () => {
    const table = fakeEl('table');
    const row1 = fakeEl('tr', { textContent: 'Alice  Admin' });
    const row2 = fakeEl('tr', { textContent: 'Bob   User' });
    appendChild(table, row1);
    appendChild(table, row2);
    const cell = fakeEl('td');
    appendChild(row2, cell);

    const result = selectorForMirror([table], cell);
    expect(result.tier).toBe(4);
    expect(result.selector).toContain('tr:nth-of-type(2)');
    expect(result.repeatedRowText).toBe('Bob User');
  });

  it('prefers the OUTERMOST repeated-sibling text over a shallower inner one (real-world nested-row shape)', () => {
    // Mirrors a real pattern (Flask CRUD app): each row is a card div holding an id/title/desc
    // block plus a button-column div — and that button-column div is itself a `div` sibling of
    // the OTHER divs in the row, so a naive "first collision found while climbing" would grab
    // the button-column's own text ("Update") instead of the row's real identifying content.
    const list = fakeEl('div');
    const card1 = fakeEl('div', { textContent: 'id: 1 Title: Task Alpha Update Delete' });
    const card2 = fakeEl('div', { textContent: 'id: 2 Title: Task Beta Update Delete' });
    appendChild(list, card1);
    appendChild(list, card2);

    const infoCol = fakeEl('div');
    const buttonCol1 = fakeEl('div', { textContent: 'Update' });
    const buttonCol2 = fakeEl('div', { textContent: 'Delete' });
    appendChild(card2, infoCol);
    appendChild(card2, buttonCol1);
    appendChild(card2, buttonCol2);
    const updateLink = fakeEl('a', { textContent: 'Update' });
    appendChild(buttonCol1, updateLink);

    const result = selectorForMirror([list], updateLink);
    expect(result.tier).toBe(4);
    // The row's own text (card2), not the shallow button-column div's text ("Update" alone,
    // which is identical across every row and therefore useless as a disambiguating anchor).
    expect(result.repeatedRowText).toBe('id: 2 Title: Task Beta Update Delete');
  });

  it('does not set repeatedRowText when the element has no repeated siblings', () => {
    const container = fakeEl('div');
    const onlyChild = fakeEl('button', { textContent: 'Submit' });
    appendChild(container, onlyChild);

    const result = selectorForMirror([container], onlyChild);
    expect(result.tier).toBe(4);
    expect(result.repeatedRowText).toBeUndefined();
  });

  it('prefers tier 1 over tier 4 when both a stable testid and a repeated-sibling shape exist', () => {
    const row = fakeEl('tr', { attrs: { 'data-testid': 'row-2' } });
    const sibling = fakeEl('tr');
    const parent = fakeEl('table');
    appendChild(parent, sibling);
    appendChild(parent, row);

    const result = selectorForMirror([parent], row);
    expect(result.tier).toBe(1);
  });

  it('GAP-055: gives a repeated <a> with a unique href its own tier-2 selector instead of a positional path', () => {
    // Flask CRUD's per-row "Update" links: same accessible name (ambiguousMatch),
    // but each has a genuinely unique, order-independent href.
    const list = fakeEl('div');
    const row1 = fakeEl('a', { attrs: { href: '/update/1' }, textContent: 'Update' });
    const row2 = fakeEl('a', { attrs: { href: '/update/2' }, textContent: 'Update' });
    appendChild(list, row1);
    appendChild(list, row2);

    const result1 = selectorForMirror([list], row1);
    const result2 = selectorForMirror([list], row2);

    expect(result1).toEqual({ selector: 'a[href="/update/1"]', tier: 2 });
    expect(result2).toEqual({ selector: 'a[href="/update/2"]', tier: 2 });
  });

  it('GAP-055: falls through to the positional path when the href is not unique (or absent)', () => {
    const list = fakeEl('div');
    const row1 = fakeEl('a', { attrs: { href: '/same' }, textContent: 'Dup' });
    const row2 = fakeEl('a', { attrs: { href: '/same' }, textContent: 'Dup' });
    appendChild(list, row1);
    appendChild(list, row2);

    const result = selectorForMirror([list], row1);
    expect(result.tier).toBe(4);
  });
});

// --- Mirrored GAP-053/GAP-057 (non-semantic clickable element) detection ---

/** Mirrors `isSemanticInteractive()`. */
function isSemanticInteractiveMirror(el: FakeEl): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') return true;
  if (tag === 'a' && !!el.attrs['href']) return true;
  return el.attrs['role'] === 'button';
}

/** Mirrors `hasInteractiveAncestor()` — also true when an ancestor was already collected
 * (semantic OR generic) in `seen`, so a nested cursor-pointer wrapper around an
 * already-captured cursor-pointer wrapper doesn't get its own duplicate entry. */
function hasInteractiveAncestorMirror(el: FakeEl, seen: Set<FakeEl>): boolean {
  let node = el.parentElement;
  while (node) {
    if (isSemanticInteractiveMirror(node) || seen.has(node)) return true;
    node = node.parentElement;
  }
  return false;
}

/** Mirrors the NEW `el.querySelector(INTERACTIVE_ELEMENT_SELECTOR)` descendant check (GAP-057) —
 * does `el` WRAP a real interactive element (e.g. a `<label>` around a checkbox, or a
 * cursor-pointer `<div>` around a `<button>`). `hasInteractiveAncestorMirror` only walks up; this
 * walks down, fixing the duplicate-capture direction that was previously unguarded. */
function hasInteractiveDescendantMirror(el: FakeEl): boolean {
  return el.children.some(
    (child) => isSemanticInteractiveMirror(child) || hasInteractiveDescendantMirror(child),
  );
}

/** Verbatim copy of `NON_CLICKABLE_TAGS` from selectors.ts — see that file for the full,
 * grouped/commented list and rationale. Kept in sync manually per this file's stated
 * byte-for-byte mirroring convention. */
const NON_CLICKABLE_TAGS_MIRROR = new Set([
  'html',
  'head',
  'body',
  'script',
  'style',
  'link',
  'meta',
  'title',
  'base',
  'noscript',
  'template',
  'br',
  'hr',
  'source',
  'track',
  'param',
  'col',
  'wbr',
  'iframe',
  'canvas',
  'video',
  'audio',
  'object',
  'embed',
  'map',
  'area',
  'svg',
  'path',
  'g',
  'defs',
  'use',
  'circle',
  'rect',
  'line',
  'polyline',
  'polygon',
  'ellipse',
  'tspan',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'filter',
  'symbol',
  'marker',
  'desc',
  'foreignobject',
]);

/** Mirrors `accessibleName()`'s fallback chain, restricted to what `FakeEl.attrs` can express
 * (aria-label -> textContent -> title -> alt; `aria-labelledby`'s id-lookup and input
 * value/placeholder are out of scope for these fixtures). */
function accessibleNameMirror(el: FakeEl): string {
  const ariaLabel = el.attrs['aria-label'];
  if (ariaLabel && ariaLabel.trim()) return clamp(ariaLabel);
  const text = (el.textContent ?? '').trim();
  if (text) return clamp(text);
  const title = el.attrs['title'];
  if (title && title.trim()) return clamp(title);
  const alt = el.attrs['alt'];
  if (alt && alt.trim()) return clamp(alt);
  return '';
}

/** Pre-order DFS over a `FakeEl` tree — a faithful mirror of `querySelectorAll('*')`'s
 * document-order traversal, replacing the old hand-picked `candidates` array (which never
 * actually mirrored tag/selector matching at all — see the GAP-057 fix note below). */
function descendantsInDocumentOrder(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [root];
  for (const child of root.children) {
    out.push(...descendantsInDocumentOrder(child));
  }
  return out;
}

interface GenericClickResult {
  role: 'generic';
  name: string;
  selector: string;
}

/**
 * Mirrors `collectInteractiveElements()`'s second pass (GAP-053, widened to '*' + a structural
 * denylist by GAP-057), in the SAME cheapest-first order as the real code: denylisted tag -> not
 * cursor:pointer/no onclick attr -> hidden -> empty text (with accessibleName fallback) ->
 * semantic/already-seen ancestor -> interactive descendant. `seen` accumulates across nodes in
 * document order, mirroring real iteration order.
 *
 * GAP-057 fix note: the PRIOR version of this mirror took a hand-picked `candidates: FakeEl[]`
 * array and never checked tag/selector matching at all — a `<p cursor:pointer>` fixture would
 * have passed even against the UNFIXED source, since nothing here ever asked "does this element's
 * tag actually match the selector". This version derives real candidates via
 * `descendantsInDocumentOrder` + the denylist, so a test asserting a new tag is captured is only
 * meaningful because this mirror can actually reject the wrong tags too.
 */
function collectGenericClickCandidatesMirror(root: FakeEl): GenericClickResult[] {
  const out: GenericClickResult[] = [];
  const seen = new Set<FakeEl>();
  for (const el of descendantsInDocumentOrder(root)) {
    if (seen.has(el)) continue;
    if (NON_CLICKABLE_TAGS_MIRROR.has(el.tagName.toLowerCase())) continue;
    if (el.cursor !== 'pointer' && el.attrs['onclick'] === undefined) continue;
    if (el.hidden) continue;
    const name = accessibleNameMirror(el);
    if (!name) continue;
    if (hasInteractiveAncestorMirror(el, seen)) continue;
    if (hasInteractiveDescendantMirror(el)) continue;
    seen.add(el);
    out.push({ role: 'generic', name, selector: selectorForMirror([root], el).selector });
  }
  return out;
}

describe('selectors.GAP-053/GAP-057 non-semantic clickable elements (mirrored)', () => {
  it('captures a cursor-pointer div with an onclick-shaped handler and visible text as role generic', () => {
    const trigger = fakeEl('div', { textContent: 'Zmeniť', cursor: 'pointer' });
    const result = collectGenericClickCandidatesMirror(trigger);
    expect(result).toEqual([{ role: 'generic', name: 'Zmeniť', selector: expect.any(String) }]);
  });

  it('does not capture a cursor-pointer wrapper with no visible text', () => {
    const wrapper = fakeEl('div', { cursor: 'pointer' });
    const result = collectGenericClickCandidatesMirror(wrapper);
    expect(result).toEqual([]);
  });

  it('does not capture a div with text but no cursor:pointer styling', () => {
    const plain = fakeEl('div', { textContent: 'Just some text' });
    const result = collectGenericClickCandidatesMirror(plain);
    expect(result).toEqual([]);
  });

  it('does not double-capture a cursor-pointer span nested inside a real <button>', () => {
    const button = fakeEl('button', { textContent: 'Export' });
    const innerSpan = fakeEl('span', { textContent: 'Export', cursor: 'pointer' });
    appendChild(button, innerSpan);

    const result = collectGenericClickCandidatesMirror(button);
    expect(result).toEqual([]);
  });

  it('does not double-capture nested cursor-pointer wrapper layers around one logical click target', () => {
    // A card with 3 nested cursor-pointer divs (common in real apps — Herfy's reward
    // cards) is ONE click target, not 3 — only the outermost (first in document order)
    // should survive.
    const outer = fakeEl('div', { textContent: '100 Off reward', cursor: 'pointer' });
    const middle = fakeEl('div', { textContent: '100 Off reward', cursor: 'pointer' });
    const inner = fakeEl('div', { textContent: '100 Off reward', cursor: 'pointer' });
    appendChild(outer, middle);
    appendChild(middle, inner);

    const result = collectGenericClickCandidatesMirror(outer);
    expect(result).toEqual([{ role: 'generic', name: '100 Off reward', selector: expect.any(String) }]);
  });

  it('GAP-057: captures a cursor-pointer <p> with text — the live C&A regression case', () => {
    // C&A's account-settings panel used <p> for change-password/change-name/delete-account
    // triggers — invisible to GAP-053's div/span/li/td/tr allowlist entirely.
    const trigger = fakeEl('p', { textContent: 'Zmeniť heslo', cursor: 'pointer' });
    const result = collectGenericClickCandidatesMirror(trigger);
    expect(result).toEqual([{ role: 'generic', name: 'Zmeniť heslo', selector: expect.any(String) }]);
  });

  it('GAP-057: captures a heading used as a clickable accordion toggle', () => {
    const heading = fakeEl('h3', { textContent: 'Shipping details', cursor: 'pointer' });
    const result = collectGenericClickCandidatesMirror(heading);
    expect(result).toEqual([{ role: 'generic', name: 'Shipping details', selector: expect.any(String) }]);
  });

  it('GAP-057: captures a cursor-pointer <img> using its alt text as the name (no textContent possible)', () => {
    const icon = fakeEl('img', { attrs: { alt: 'Edit profile' }, cursor: 'pointer' });
    const result = collectGenericClickCandidatesMirror(icon);
    expect(result).toEqual([{ role: 'generic', name: 'Edit profile', selector: expect.any(String) }]);
  });

  it('GAP-057: an <img> with no alt/aria-label/title still yields no name and is not captured', () => {
    // Regression guard: the accessibleName fallback must not start fabricating names for
    // genuinely unlabeled icons.
    const icon = fakeEl('img', { cursor: 'pointer' });
    const result = collectGenericClickCandidatesMirror(icon);
    expect(result).toEqual([]);
  });

  it('GAP-057: captures a bare <a> with no href — invisible to INTERACTIVE_ELEMENT_SELECTOR (a[href]) too', () => {
    const jsLink = fakeEl('a', { textContent: 'My account', cursor: 'pointer' });
    const result = collectGenericClickCandidatesMirror(jsLink);
    expect(result).toEqual([{ role: 'generic', name: 'My account', selector: expect.any(String) }]);
  });

  it('GAP-057: captures an arbitrary custom element styled cursor:pointer, proving the allowlist is gone', () => {
    const tile = fakeEl('cx-tile', { textContent: 'Promo card', cursor: 'pointer' });
    const result = collectGenericClickCandidatesMirror(tile);
    expect(result).toEqual([{ role: 'generic', name: 'Promo card', selector: expect.any(String) }]);
  });

  it('GAP-057: a second, unrelated custom element tag is also captured (not a substring/prefix match fluke)', () => {
    const item = fakeEl('ion-item', { textContent: 'Settings', cursor: 'pointer' });
    const result = collectGenericClickCandidatesMirror(item);
    expect(result).toEqual([{ role: 'generic', name: 'Settings', selector: expect.any(String) }]);
  });

  it('GAP-057: a denylisted tag is excluded even with cursor:pointer AND text (denylist short-circuits first)', () => {
    const script = fakeEl('script', { textContent: 'window.onclick = doThing', cursor: 'pointer' });
    const result = collectGenericClickCandidatesMirror(script);
    expect(result).toEqual([]);
  });

  it('GAP-057: an SVG <path> inside a pointer-styled icon is excluded (denylist, not just ancestor check)', () => {
    const path = fakeEl('path', { textContent: '', cursor: 'pointer', attrs: { d: 'M0 0' } });
    const result = collectGenericClickCandidatesMirror(path);
    expect(result).toEqual([]);
  });

  it('GAP-057: an element with a literal onclick attribute but no cursor:pointer styling is still captured', () => {
    // Preserves [onclick]'s one real value: legacy/server-rendered markup with an inline
    // handler but no CSS cursor styling.
    const legacy = fakeEl('p', { textContent: 'Delete', attrs: { onclick: 'doDelete()' } });
    const result = collectGenericClickCandidatesMirror(legacy);
    expect(result).toEqual([{ role: 'generic', name: 'Delete', selector: expect.any(String) }]);
  });

  it('GAP-057: an element with neither cursor:pointer nor onclick is excluded', () => {
    const inert = fakeEl('p', { textContent: 'Just static text' });
    const result = collectGenericClickCandidatesMirror(inert);
    expect(result).toEqual([]);
  });

  it('GAP-057: does not double-capture a cursor-pointer <label> wrapping a checkbox (descendant dedup)', () => {
    const label = fakeEl('label', { textContent: 'Remember me', cursor: 'pointer' });
    const checkbox = fakeEl('input', {});
    appendChild(label, checkbox);
    const result = collectGenericClickCandidatesMirror(label);
    expect(result).toEqual([]);
  });

  it('GAP-057: does not double-capture a cursor-pointer <div> wrapping a real <button> (descendant dedup, div variant)', () => {
    const card = fakeEl('div', { textContent: 'Export', cursor: 'pointer' });
    const button = fakeEl('button', { textContent: 'Export' });
    appendChild(card, button);
    const result = collectGenericClickCandidatesMirror(card);
    expect(result).toEqual([]);
  });

  it('GAP-057: descendant dedup is not shallow — a 2-level-nested real control is still detected', () => {
    const outer = fakeEl('div', { textContent: 'Card', cursor: 'pointer' });
    const middle = fakeEl('div', { cursor: 'pointer' });
    const input = fakeEl('input', {});
    appendChild(outer, middle);
    appendChild(middle, input);
    const result = collectGenericClickCandidatesMirror(outer);
    expect(result).toEqual([]);
  });

  it(
    'GAP-057: an element inside an already-captured ancestor is excluded via the ancestor path alone ' +
      '(no interactive descendant of its own, isolating which check is responsible)',
    () => {
      // Unlike the descendant-dedup cases above, `middle` wraps nothing interactive — if the
      // ancestor check were ever skipped, the descendant check would NOT catch this case either,
      // so a passing result here is attributable only to the (existing, cheaper) ancestor check.
      const outer = fakeEl('div', { textContent: 'Outer card', cursor: 'pointer' });
      const middle = fakeEl('div', { textContent: 'Middle wrapper', cursor: 'pointer' });
      appendChild(outer, middle);
      const result = collectGenericClickCandidatesMirror(outer);
      expect(result).toEqual([{ role: 'generic', name: 'Outer card', selector: expect.any(String) }]);
    },
  );

  it('GAP-057: textContent is never read on an element that fails the cursor/onclick check (ordering-as-contract)', () => {
    let textContentRead = false;
    const spyEl = fakeEl('p', { cursor: undefined });
    Object.defineProperty(spyEl, 'textContent', {
      get() {
        textContentRead = true;
        return 'should never be read';
      },
    });
    const result = collectGenericClickCandidatesMirror(spyEl);
    expect(result).toEqual([]);
    expect(textContentRead).toBe(false);
  });
});

// --- Mirrored duplicate-target (wrapper + nested control) dedup ---

interface DedupEntry {
  el: FakeEl;
  name: string;
}

/**
 * Mirrors the ancestor-dedup check added to `collectInteractiveElements()`'s
 * main loop: when a later (descendant, since querySelectorAll returns
 * document order) element shares its accessible name with an
 * already-collected ancestor, the ancestor's entry is dropped in favor of the
 * more specific descendant.
 */
function collectWithAncestorDedupMirror(elementsInDocumentOrder: FakeEl[]): DedupEntry[] {
  const out: DedupEntry[] = [];
  for (const el of elementsInDocumentOrder) {
    const name = clamp(el.textContent ?? '');
    if (name) {
      let ancestor = el.parentElement;
      while (ancestor) {
        const idx = out.findIndex((entry) => entry.el === ancestor);
        if (idx !== -1) {
          if (out[idx]!.name === name) out.splice(idx, 1);
          break;
        }
        ancestor = ancestor.parentElement;
      }
    }
    out.push({ el, name });
  }
  return out;
}

describe('selectors.duplicate-target capture dedup (mirrored)', () => {
  it('drops the wrapper <a href> entry when a nested <button> shares its accessible name', () => {
    const wrapperLink = fakeEl('a', { attrs: { href: '/shop' }, textContent: 'Go to shop' });
    const nestedButton = fakeEl('button', { textContent: 'Go to shop' });
    appendChild(wrapperLink, nestedButton);

    // document order: the wrapper is visited before its child.
    const result = collectWithAncestorDedupMirror([wrapperLink, nestedButton]);

    expect(result).toHaveLength(1);
    expect(result[0]?.el).toBe(nestedButton);
  });

  it('keeps both entries when the wrapper and nested control have different accessible names', () => {
    const wrapperLink = fakeEl('a', { attrs: { href: '/shop' }, textContent: 'Shop wrapper' });
    const nestedButton = fakeEl('button', { textContent: 'Buy now' });
    appendChild(wrapperLink, nestedButton);

    const result = collectWithAncestorDedupMirror([wrapperLink, nestedButton]);

    expect(result).toHaveLength(2);
  });
});

// --- collectModalText (Cluster E) — mirrored -------------------------------

/** Mirrors selectors.ts's DIALOG_CONTAINER_SELECTOR match: role="dialog"/"alertdialog" or
 * aria-modal="true". */
function isDialogContainerMirror(el: FakeEl): boolean {
  const role = el.attrs['role'];
  return role === 'dialog' || role === 'alertdialog' || el.attrs['aria-modal'] === 'true';
}

/** Mirrors collectModalText's visibility gate (same shape as isVisibleWithStyle: hidden + a
 * simulated cursor-free style check — this test file's FakeEl has no getClientRects/display
 * concept, so `hidden` alone stands in for "not visible" here). */
function isVisibleMirror(el: FakeEl): boolean {
  return !el.hidden;
}

/** Same clamp values as selectors.ts's MODAL_TEXT_MAX_CHARS/BODY_TEXT_MAX_CHARS. */
const MODAL_TEXT_MAX_CHARS_MIRROR = 2000;

function clampMirror(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Mirrors collectModalText's modal-half: find every visible dialog-shaped container in
 * document order, concatenate their textContent, clamp. */
function collectModalTextMirror(root: FakeEl): string | undefined {
  const dialogs = descendantsInDocumentOrder(root).filter(isDialogContainerMirror);
  const visible = dialogs.filter(isVisibleMirror);
  if (visible.length === 0) return undefined;
  return clampMirror(visible.map((el) => el.textContent ?? '').join(' '), MODAL_TEXT_MAX_CHARS_MIRROR);
}

describe('selectors.collectModalText (Cluster E, mirrored)', () => {
  it('captures text from a visible role="dialog" container', () => {
    const root = fakeEl('div');
    const dialog = fakeEl('div', { attrs: { role: 'dialog' }, textContent: 'Delete your account?' });
    appendChild(root, dialog);
    expect(collectModalTextMirror(root)).toBe('Delete your account?');
  });

  it('captures text from a role="alertdialog" container too', () => {
    const root = fakeEl('div');
    const dialog = fakeEl('div', { attrs: { role: 'alertdialog' }, textContent: 'Payment failed' });
    appendChild(root, dialog);
    expect(collectModalTextMirror(root)).toBe('Payment failed');
  });

  it('captures text from an aria-modal="true" container with no explicit role', () => {
    const root = fakeEl('div');
    const dialog = fakeEl('div', { attrs: { 'aria-modal': 'true' }, textContent: 'Confirm changes' });
    appendChild(root, dialog);
    expect(collectModalTextMirror(root)).toBe('Confirm changes');
  });

  it('returns undefined when no dialog-shaped container is present at all', () => {
    const root = fakeEl('div');
    appendChild(root, fakeEl('p', { textContent: 'Just page copy' }));
    expect(collectModalTextMirror(root)).toBeUndefined();
  });

  it('ignores a hidden dialog container (not currently open)', () => {
    const root = fakeEl('div');
    const dialog = fakeEl('div', { attrs: { role: 'dialog' }, textContent: 'Hidden dialog', hidden: true });
    appendChild(root, dialog);
    expect(collectModalTextMirror(root)).toBeUndefined();
  });

  it('clamps modal text longer than the cap', () => {
    const root = fakeEl('div');
    const longText = 'x'.repeat(MODAL_TEXT_MAX_CHARS_MIRROR + 500);
    const dialog = fakeEl('div', { attrs: { role: 'dialog' }, textContent: longText });
    appendChild(root, dialog);
    expect(collectModalTextMirror(root)?.length).toBe(MODAL_TEXT_MAX_CHARS_MIRROR);
  });
});
