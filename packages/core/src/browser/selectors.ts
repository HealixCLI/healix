import type { Page } from 'playwright';
import type { InteractiveElement } from './types.js';

/*
 * NOTE ON TYPING
 * --------------
 * The callback passed to `page.evaluate` runs inside the browser, but this
 * package is compiled WITHOUT the TypeScript "DOM" lib (tsconfig `lib` is
 * ES-only, `types` is just "node"). That means `document`, `window`,
 * `HTMLElement`, etc. are not declared at compile time. Rather than widen the
 * whole package's lib, we model only the tiny DOM surface we touch with local
 * structural interfaces and reach the page globals through a single typed
 * `globalThis` view. This keeps the file strict-typed and self-contained.
 */

/** Minimal structural view of the DOM nodes/objects we read in the page. */
interface DomElement {
  readonly id: string;
  readonly tagName: string;
  readonly textContent: string | null;
  readonly nodeType: number;
  readonly parentElement: DomElement | null;
  readonly children: ArrayLike<DomElement>;
  readonly hidden?: boolean;
  readonly value?: string;
  readonly placeholder?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getClientRects(): ArrayLike<unknown>;
}

interface DomDocument {
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getElementById(id: string): DomElement | null;
}

interface DomWindow {
  CSS?: { escape?: (value: string) => string };
  getComputedStyle(el: DomElement): { visibility: string; display: string };
  document: DomDocument;
}

/** Shared with {@link BrowserSurface.goto} so the post-navigation settle wait
 * polls for the same notion of "real content" that this function extracts. */
export const INTERACTIVE_ELEMENT_SELECTOR = 'button, a[href], input, select, textarea, [role="button"]';

/**
 * Extract interactive elements (buttons, links, inputs, selects, textareas and
 * `[role=button]`), computing a stable selector (preferring `#id`) and an
 * accessible name for each. Runs as a single in-page evaluation so we avoid
 * per-element round-trips.
 */
export async function collectInteractiveElements(page: Page): Promise<InteractiveElement[]> {
  return page.evaluate<InteractiveElement[], string>((SELECTOR) => {
    // Inside the browser these globals exist; we narrow them to our local view.
    const win = globalThis as unknown as DomWindow;
    const doc = win.document;

    function cssEscape(value: string): string {
      if (win.CSS && typeof win.CSS.escape === 'function') {
        return win.CSS.escape(value);
      }
      // Fallback escaper. A leading digit (or empty value) makes an identifier
      // invalid (`#123` is not a valid selector), so escape the first char as a
      // unicode code point (`\31 ` style) when it's a digit, then escape the
      // remaining non-identifier characters individually.
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

    function selectorFor(el: DomElement): string {
      if (el.id) {
        return `#${cssEscape(el.id)}`;
      }

      const tag = el.tagName.toLowerCase();
      const stableAttrs = ['data-testid', 'data-test', 'name', 'aria-label'];
      for (const attr of stableAttrs) {
        const val = el.getAttribute(attr);
        if (val) {
          const candidate = `${tag}[${attr}="${val.replace(/"/g, '\\"')}"]`;
          // Only emit the attribute shortcut when it uniquely identifies the
          // node; otherwise fall through to the nth-of-type path builder.
          if (doc.querySelectorAll(candidate).length === 1) {
            return candidate;
          }
        }
      }

      // Build an nth-of-type path that uniquely identifies the node.
      const parts: string[] = [];
      let node: DomElement | null = el;
      while (node && node.nodeType === 1 && parts.length < 6) {
        const current: DomElement = node;
        let part = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.prototype.slice.call(parent.children) as DomElement[];
          const sameTag = siblings.filter((c) => c.tagName === current.tagName);
          if (sameTag.length > 1) {
            const index = sameTag.indexOf(current) + 1;
            part += `:nth-of-type(${index})`;
          }
        }
        parts.unshift(part);
        if (current.id) {
          parts[0] = `#${cssEscape(current.id)}`;
          break;
        }
        node = parent;
      }
      return parts.join(' > ');
    }

    function isInputLike(el: DomElement): boolean {
      const tag = el.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea';
    }

    /** Collapse whitespace and clamp every name source to a stable length. */
    function clamp(value: string): string {
      // Collapse first, then clamp to the cap. A trailing trim after the slice
      // guarantees the cut never leaves a dangling space when the 200-char
      // boundary lands mid-separator.
      return value.trim().replace(/\s+/g, ' ').slice(0, 200).trim();
    }

    function accessibleName(el: DomElement): string {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) {
        return clamp(ariaLabel);
      }

      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelText = labelledBy
          .split(/\s+/)
          .map((id) => {
            const ref = doc.getElementById(id);
            return ref ? (ref.textContent ?? '').trim() : '';
          })
          .filter(Boolean)
          .join(' ');
        if (labelText) {
          return clamp(labelText);
        }
      }

      const text = (el.textContent ?? '').trim();
      if (text) {
        return clamp(text);
      }

      if (isInputLike(el)) {
        if (el.value && el.value.trim()) {
          return clamp(el.value);
        }
        if (el.placeholder && el.placeholder.trim()) {
          return clamp(el.placeholder);
        }
      }

      const title = el.getAttribute('title');
      if (title && title.trim()) {
        return clamp(title);
      }

      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) {
        return clamp(alt);
      }

      return '';
    }

    function roleFor(el: DomElement): string {
      const explicit = el.getAttribute('role');
      if (explicit && explicit.trim()) {
        return explicit.trim();
      }
      const tag = el.tagName.toLowerCase();
      switch (tag) {
        case 'a':
          return el.hasAttribute('href') ? 'link' : 'generic';
        case 'button':
          return 'button';
        case 'select':
          return 'combobox';
        case 'textarea':
          return 'textbox';
        case 'input': {
          const type = (el.getAttribute('type') ?? 'text').toLowerCase();
          switch (type) {
            case 'button':
            case 'submit':
            case 'reset':
            case 'image':
              return 'button';
            case 'checkbox':
              return 'checkbox';
            case 'radio':
              return 'radio';
            case 'range':
              return 'slider';
            case 'search':
              return 'searchbox';
            default:
              return 'textbox';
          }
        }
        default:
          return tag;
      }
    }

    function isInForm(el: DomElement): boolean {
      let node: DomElement | null = el.parentElement;
      while (node) {
        if (node.tagName.toLowerCase() === 'form') return true;
        node = node.parentElement;
      }
      return false;
    }

    function isDisabled(el: DomElement): boolean {
      return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
    }

    function isVisible(el: DomElement): boolean {
      if (el.hidden) {
        return false;
      }
      if (el.getClientRects().length === 0) {
        return false;
      }
      const style = win.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    }

    const seen = new Set<DomElement>();
    const out: InteractiveElement[] = [];
    const nodes = Array.prototype.slice.call(doc.querySelectorAll(SELECTOR)) as DomElement[];

    for (const el of nodes) {
      if (seen.has(el) || !isVisible(el)) {
        continue;
      }
      seen.add(el);
      const tag = el.tagName.toLowerCase();
      const inForm = isInForm(el);
      const rawButtonType = tag === 'button' ? (el.getAttribute('type') ?? '').toLowerCase() : undefined;
      out.push({
        role: roleFor(el),
        name: accessibleName(el),
        selector: selectorFor(el),
        href: tag === 'a' ? (el.getAttribute('href') ?? undefined) : undefined,
        inputType: tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : undefined,
        // An untyped <button> inside a <form> implicitly submits per HTML spec.
        buttonType: tag === 'button' ? rawButtonType || (inForm ? 'submit' : '') : undefined,
        inForm,
        disabled: isDisabled(el),
      });
    }

    return out;
  }, INTERACTIVE_ELEMENT_SELECTOR);
}
