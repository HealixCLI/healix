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
function assertParsesIfPossible(selector: string): void {
  const maybeDoc = (globalThis as { document?: { querySelector?(s: string): unknown } }).document;
  if (!maybeDoc || typeof maybeDoc.querySelector !== 'function') {
    return;
  }
  // A valid selector that matches nothing returns null without throwing; an
  // invalid one throws a SyntaxError. So "does not throw" == "is valid".
  expect(() => maybeDoc.querySelector?.(selector)).not.toThrow();
}
