import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';

/** Playwright has no standalone exported name for this shape — derived from the method itself
 * so this stays in sync with whatever version of Playwright is installed. */
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
import {
  collectContentElements,
  collectInteractiveElements,
  collectModalText,
  INTERACTIVE_ELEMENT_SELECTOR,
} from './selectors.js';
import { ensurePlaywrightBrowsersInstalled, looksLikeMissingBrowser } from './ensure-browsers.js';
import { FrameMirror } from './mirror.js';
import type {
  BrowserSurface,
  BrowserSurfaceOptions,
  CapturedNetworkEvent,
  DomSnapshot,
  Point,
} from './types.js';

export * from './types.js';

const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

/** Upper bound on how long goto() waits for the page to settle post-navigation. */
const SETTLE_TIMEOUT_MS = 8000;
/** Poll interval for the same-document content-settle check below. */
const SAME_DOC_POLL_MS = 150;
/**
 * Upper bound on how long click() waits for the page to settle after a click, before the caller's
 * next snapshot(). Much shorter than SETTLE_TIMEOUT_MS: unlike a full navigation, a click-driven
 * reveal (a modal, an inline edit form) is a client-side re-render with no network round trip to
 * wait for, so it settles fast when it settles at all — this just needs to be longer than one
 * React render tick, not longer than a page load.
 *
 * Added because click() previously returned as soon as Playwright dispatched the click event,
 * with no wait for the app's reaction to it — `discoverClickRoutes` (crawler.ts) then snapshotted
 * on the very next line. Confirmed live against the C&A app: clicking a dashboard "zmeniť" trigger
 * does open a real edit form (a manual click-then-inspect reproduces it every time), but the
 * automated crawl's click-immediately-snapshot sequence raced the render and saw the pre-click
 * DOM, so the reveal was silently treated as a no-op dropdown instead of a recorded state.
 */
const CLICK_SETTLE_TIMEOUT_MS = 800;
/** Char-length gate for whether a captured body needs truncating at all. Not a hard
 * output cap for JSON bodies (see {@link truncateJsonValue}) — those are shrunk
 * structurally instead, so the result stays valid JSON regardless of final length. Mirrors
 * generate.ts's MAX_MOCK_BODY_CHARS so captured ground truth and the prompt budget it
 * eventually feeds stay the same order of magnitude. */
const MAX_CAPTURED_BODY_CHARS = 400;
/** Arrays anywhere in a captured JSON body are capped to their first N elements
 * (GAP-063) — a real API list response can be hundreds of KB; keeping the shape and
 * a handful of real samples is enough for both prompt grounding and a runtime mock,
 * without needing to fit an arbitrary char budget. */
const MAX_ARRAY_ELEMENTS = 5;
/** Per-string-value cap applied to any JSON string field longer than this (GAP-063) —
 * e.g. a `description`/`metadata` field carrying embedded HTML/CSS boilerplate can run
 * to several KB on its own, independent of any array truncation. */
const STRING_FIELD_MAX_CHARS = 200;
/** Hard cap on buffered network events between drains, so a chatty page
 * (polling/analytics) can't grow the buffer unbounded during a long crawl. */
const MAX_BUFFERED_EVENTS = 200;

/** Cuts a long string at its first sentence boundary (`.`/`!`/`?` followed by
 * whitespace-or-end) when one exists within the cap; otherwise hard-cuts with `…`.
 * Markup-heavy fields (HTML/CSS boilerplate) rarely have an early sentence boundary
 * and fall through to the hard cut — expected, not a defect. */
function truncateStringField(value: string): string {
  if (value.length <= STRING_FIELD_MAX_CHARS) return value;
  const window = value.slice(0, STRING_FIELD_MAX_CHARS);
  const sentenceEnd = window.match(/[.!?](?=\s|$)/);
  if (sentenceEnd?.index !== undefined) return window.slice(0, sentenceEnd.index + 1);
  return `${window}…`;
}

/** Recursively caps array length and long string values within a parsed JSON value
 * (GAP-063) so a captured body stays valid, representative JSON regardless of how
 * large the real response was — instead of a flat char-slice that can cut mid-structure
 * and produce invalid JSON. */
function truncateJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ELEMENTS).map(truncateJsonValue);
  }
  if (typeof value === 'string') {
    return truncateStringField(value);
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      result[key] = truncateJsonValue(v);
    }
    return result;
  }
  return value;
}

/** True for `application/xml`, `text/xml`, `application/soap+xml`, and any other
 * `*+xml` content-type (GAP-069) — the set of types `truncateBody()` routes to the
 * structural XML truncator instead of the flat char-slice fallback. */
export function isXmlContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /(?:^|\/)xml\s*(?:;|$)|\+xml\s*(?:;|$)/i.test(contentType);
}

/** A parsed XML element (`children` holds nested elements/text) or a text run between
 * tags. Deliberately minimal — only what a captured API response body needs (elements,
 * attributes carried verbatim, text, CDATA) — not a general/validating XML parser. */
type XmlNode =
  | { type: 'element'; tag: string; attrs: string; selfClosing: boolean; children: XmlNode[] }
  | { type: 'text'; value: string }
  | { type: 'cdata'; value: string }
  | { type: 'other'; value: string };

/** Tokenizes and parses `text` into a tree of {@link XmlNode}s, tolerating a single
 * leading prolog/declaration and comments anywhere. Returns `null` on any structural
 * inconsistency (unclosed/mismatched tags) — same contract as `JSON.parse` throwing:
 * the caller falls back to a safe default rather than emitting something malformed. */
function parseXmlLoose(text: string): XmlNode[] | null {
  const tokenRe = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/[^>]+>|<[^>/][^>]*\/?>|[^<]+/g;
  const root: XmlNode[] = [];
  const stack: Array<{ tag: string; children: XmlNode[] }> = [];
  const current = () => (stack.length > 0 ? stack[stack.length - 1].children : root);

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    const token = match[0];
    if (token.startsWith('<?') || token.startsWith('<!--')) {
      current().push({ type: 'other', value: token });
    } else if (token.startsWith('<![CDATA[')) {
      current().push({ type: 'cdata', value: token.slice(9, -3) });
    } else if (token.startsWith('</')) {
      const tag = token.slice(2, -1).trim();
      const top = stack.pop();
      if (!top || top.tag !== tag) return null;
    } else if (token.startsWith('<')) {
      const selfClosing = /\/>$/.test(token);
      const body = token.slice(1, selfClosing ? -2 : -1).trim();
      const nameMatch = body.match(/^[^\s/]+/);
      if (!nameMatch) return null;
      const tag = nameMatch[0];
      const attrs = body.slice(tag.length);
      const node: XmlNode = { type: 'element', tag, attrs, selfClosing, children: [] };
      current().push(node);
      if (!selfClosing) stack.push({ tag, children: node.children });
    } else {
      current().push({ type: 'text', value: token });
    }
  }
  if (stack.length > 0) return null;
  return root;
}

/** Re-emits a parsed {@link XmlNode} tree back into XML text, the inverse of
 * {@link parseXmlLoose}. */
function serializeXmlNodes(nodes: XmlNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
        case 'other':
          return node.value;
        case 'cdata':
          return `<![CDATA[${node.value}]]>`;
        case 'element': {
          const open = `<${node.tag}${node.attrs}`;
          if (node.selfClosing) return `${open}/>`;
          return `${open}>${serializeXmlNodes(node.children)}</${node.tag}>`;
        }
      }
    })
    .join('');
}

/** Recursively caps repeated sibling elements and long text runs within a parsed XML
 * tree (GAP-069) — the XML analogue of {@link truncateJsonValue}: a run of more than
 * {@link MAX_ARRAY_ELEMENTS} sibling elements sharing the same tag (the XML equivalent
 * of a JSON array of records, e.g. repeated `<item>`/`<row>` elements) is capped to the
 * first N, and long text content is cut with {@link truncateStringField} — same caps,
 * same rationale, applied structurally so the result is well-formed by construction. */
function truncateXmlNodes(nodes: XmlNode[]): XmlNode[] {
  const result: XmlNode[] = [];
  const tagCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.type === 'element') {
      const count = (tagCounts.get(node.tag) ?? 0) + 1;
      tagCounts.set(node.tag, count);
      if (count > MAX_ARRAY_ELEMENTS) continue;
      result.push({ ...node, children: truncateXmlNodes(node.children) });
    } else if (node.type === 'text') {
      result.push({ type: 'text', value: truncateStringField(node.value) });
    } else {
      result.push(node);
    }
  }
  return result;
}

/** Structural, well-formedness-preserving XML/SOAP truncation (GAP-069) — the XML
 * counterpart to `truncateBody()`'s JSON branch. Parses `text`, caps it via
 * {@link truncateXmlNodes}, and re-serializes; falls back to the original flat
 * char-slice when the body doesn't parse with {@link parseXmlLoose}'s loose grammar. */
export function truncateXmlBody(text: string): string {
  const nodes = parseXmlLoose(text);
  if (nodes === null) return `${text.slice(0, MAX_CAPTURED_BODY_CHARS)}…`;
  return serializeXmlNodes(truncateXmlNodes(nodes));
}

/** Exported for direct unit testing (GAP-063) — otherwise only used internally by
 * {@link captureNetworkEvent}. `contentType`, when it looks like XML/SOAP (GAP-069),
 * routes the non-JSON fallback through {@link truncateXmlBody} instead of a flat
 * char-slice, so a truncated XML body stays well-formed. */
export function truncateBody(text: string, contentType?: string): string {
  if (text.length <= MAX_CAPTURED_BODY_CHARS) return text;
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(truncateJsonValue(parsed));
  } catch {
    if (isXmlContentType(contentType)) return truncateXmlBody(text);
    return `${text.slice(0, MAX_CAPTURED_BODY_CHARS)}…`;
  }
}

/** Best-effort capture of one response + its originating request. Only called for
 * xhr/fetch resource types (see caller) — other resource types (images, css, fonts,
 * documents) are irrelevant to mock-endpoint ground truth and are skipped before this
 * is ever invoked. Swallows read errors (binary bodies, aborted/redirected responses). */
export async function captureNetworkEvent(response: Response): Promise<CapturedNetworkEvent> {
  const request = response.request();
  const event: CapturedNetworkEvent = {
    method: request.method(),
    url: request.url(),
    status: response.status(),
  };
  try {
    const body = request.postData();
    if (body) event.requestBody = truncateBody(body);
  } catch {
    // No readable request body.
  }
  try {
    const contentType = response.headers()['content-type'];
    if (contentType) event.contentType = contentType;
  } catch {
    // Headers unavailable (redirected/aborted response).
  }
  try {
    const text = await response.text();
    if (text) event.responseBody = truncateBody(text, event.contentType);
  } catch {
    // Binary, redirected, or otherwise unreadable response body.
  }
  return event;
}

/** Throw a uniform error when the surface is used before {@link start}. */
function requireStarted<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`[healix] BrowserSurface.${what} called before start(); call start() first.`);
  }
  return value;
}

/** True when `from` and `to` are the same document (origin + pathname), e.g. only the hash or
 * query differs — the shape of a client-side SPA route change rather than a real page load. */
function isSameDocumentNav(from: string, to: string): boolean {
  try {
    const a = new URL(from);
    const b = new URL(to);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/**
 * SPAs (esp. hash-routed) often finish DOMContentLoaded before client-side hydration renders real
 * content, so a snapshot taken immediately after a navigation/reload can see 0 interactive
 * elements on an otherwise content-rich page. Race two settle signals instead of betting on a
 * fixed delay: as soon as a real interactive element appears, stop waiting (fast for the common
 * case); otherwise fall back to networkidle. Both are capped so a genuinely thin page (no
 * interactive elements, ever) still falls through in bounded time rather than hanging. Shared by
 * `goto()` and `reload()` so both settle the same way after their respective navigation.
 */
async function waitForSettle(p: Page): Promise<void> {
  await Promise.race([
    p
      .waitForFunction(
        (selector) =>
          (
            globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<unknown> } }
          ).document.querySelectorAll(selector).length > 0,
        INTERACTIVE_ELEMENT_SELECTOR,
        { timeout: SETTLE_TIMEOUT_MS },
      )
      .catch(() => {}),
    p.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {}),
  ]);
}

/** Cheap per-page signature (title + interactive-element count) used to detect that a
 * same-document navigation actually swapped in new content, rather than leaving stale elements
 * from the previous route still in the DOM. Deliberately cheaper than a full
 * `collectInteractiveElements` pass since it's polled. */
async function contentSignature(p: Page): Promise<string> {
  return p.evaluate((selector) => {
    const doc = (
      globalThis as unknown as {
        document: { title: string; querySelectorAll(s: string): ArrayLike<unknown> };
      }
    ).document;
    return `${doc.title}#${doc.querySelectorAll(selector).length}`;
  }, INTERACTIVE_ELEMENT_SELECTOR);
}

/**
 * Single controllable Chromium serving both computer-use (clickAt/screenshot)
 * and browser-use (click/snapshot), mirrored live via onFrame.
 */
export function createBrowserSurface(): BrowserSurface {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let baseUrl: string | undefined;
  let starting: Promise<void> | undefined;
  let networkBuffer: CapturedNetworkEvent[] = [];

  const mirror = new FrameMirror(() => page);

  function onResponse(response: Response): void {
    const resourceType = response.request().resourceType();
    if (resourceType !== 'xhr' && resourceType !== 'fetch') return;
    if (networkBuffer.length >= MAX_BUFFERED_EVENTS) return;
    captureNetworkEvent(response)
      .then((event) => {
        if (networkBuffer.length < MAX_BUFFERED_EVENTS) networkBuffer.push(event);
      })
      .catch(() => {
        // Never let a capture failure surface as an unhandled rejection.
      });
  }

  /** Resolve a possibly-relative URL against baseUrl when one is configured. */
  function resolveUrl(url: string): string {
    if (!baseUrl) {
      return url;
    }
    try {
      return new URL(url, baseUrl).toString();
    } catch {
      return url;
    }
  }

  /**
   * Tear down all handles, swallowing errors so a half-open session can always
   * be fully released. Safe to call repeatedly. Defined as a closure (not via
   * `this`) so it can't be broken by method destructuring/rebinding.
   */
  async function teardown(): Promise<void> {
    mirror.dispose();
    page = undefined;
    const ctx = context;
    const br = browser;
    context = undefined;
    browser = undefined;
    baseUrl = undefined;
    networkBuffer = [];

    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // Context may already be gone.
      }
    }
    if (br) {
      try {
        await br.close();
      } catch {
        // Browser may already be gone.
      }
    }
  }

  return {
    async start(opts: BrowserSurfaceOptions = {}): Promise<void> {
      // In-flight mutex: if a launch is already underway, await it instead of
      // launching a second browser (the `if (browser)` guard below only fires
      // once `chromium.launch` has resolved, so it can't catch re-entrant calls).
      if (starting) {
        return starting;
      }

      starting = (async () => {
        if (browser) {
          // Idempotent guard: tear down a prior session before relaunching.
          await teardown();
        }

        const headless = opts.headless ?? true;
        const viewport = opts.viewport ?? { ...DEFAULT_VIEWPORT };
        baseUrl = opts.baseUrl;

        try {
          browser = await chromium.launch({ headless });
        } catch (err) {
          // The browser binary comes from a shared global cache Playwright manages
          // itself; a first-ever run (or one after a Playwright upgrade) can find it
          // empty. Install once and retry rather than failing every exploration until
          // someone runs the command by hand.
          if (!looksLikeMissingBrowser(err)) throw err;
          const installed = await ensurePlaywrightBrowsersInstalled();
          if (!installed) throw err;
          browser = await chromium.launch({ headless });
        }
        try {
          context = await browser.newContext({
            viewport,
            storageState: opts.storageState as StorageState | undefined,
          });
          page = await context.newPage();
          page.on('response', onResponse);
        } catch (err) {
          // Don't leak the browser process if context/page creation fails.
          await teardown();
          throw err;
        }
      })();

      try {
        await starting;
      } finally {
        starting = undefined;
      }
    },

    async goto(url: string): Promise<void> {
      const p = requireStarted(page, 'goto');
      const target = resolveUrl(url);
      const fromUrl = p.url();
      const sameDocument = isSameDocumentNav(fromUrl, target);
      let before: string | undefined;
      if (sameDocument) {
        before = await contentSignature(p).catch(() => undefined);
      }

      const response = await p.goto(target, { waitUntil: 'domcontentloaded' });
      await waitForSettle(p);

      // A same-document navigation (only the hash/query changed — a client-side SPA route
      // change) never unloads the page, so the race above can resolve instantly on the PREVIOUS
      // route's still-present elements rather than waiting for the new (possibly lazy-loaded)
      // route component to actually mount. Poll until the page's content signature changes from
      // its pre-nav value, bounded by the same settle timeout, so a snapshot taken right after
      // goto() reflects the destination route instead of a stale or momentarily-empty frame.
      //
      // Skipped when goto() returned a response: Playwright returns null ONLY for a genuine
      // same-document navigation (same URL, different hash) and a real Response whenever the
      // document actually loaded — including a navigation to the URL we're already on, which
      // reloads. That reload case is where waiting for the signature to CHANGE is not just
      // useless but actively harmful: the destination content is identical by definition, so
      // the poll can only ever run out the full SETTLE_TIMEOUT_MS. crawler.ts's
      // discoverClickRoutes issues exactly that goto after every click probe to reset the page,
      // so on a click-heavy route this dominated the entire crawl budget. When the document did
      // load, it was torn down and rebuilt, so the stale-element problem this poll exists for
      // cannot apply and the load/interactive-element race above is already sufficient.
      if (sameDocument && before !== undefined && response === null) {
        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        for (;;) {
          const after: string = await contentSignature(p).catch(() => before as string);
          if (after !== before || Date.now() >= deadline) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, SAME_DOC_POLL_MS));
        }
      }
    },

    async reload(): Promise<void> {
      const p = requireStarted(page, 'reload');
      await p.reload({ waitUntil: 'domcontentloaded' });
      await waitForSettle(p);
    },

    async screenshot(): Promise<Buffer> {
      const p = requireStarted(page, 'screenshot');
      return (await p.screenshot({ type: 'png' })) as Buffer;
    },

    async snapshot(): Promise<DomSnapshot> {
      const p = requireStarted(page, 'snapshot');
      // Playwright removed `page.accessibility.snapshot()`; the supported
      // replacement is `page.ariaSnapshot()`, which yields the accessibility
      // tree as a YAML string. `DomSnapshot.axTree` is `unknown`, so either
      // shape satisfies the contract. We swallow AX errors so a snapshot is
      // still returned (with `axTree: undefined`) if the tree can't be built.
      let axTree: unknown;
      try {
        axTree = await p.ariaSnapshot();
      } catch {
        axTree = undefined;
      }
      // Best-effort, same posture as ariaSnapshot() above — a failure here (e.g. the page
      // navigated away mid-evaluate) must never fail the whole snapshot.
      let modalText: string | undefined;
      let bodyText: string | undefined;
      try {
        ({ modalText, bodyText } = await collectModalText(p));
      } catch {
        modalText = undefined;
        bodyText = undefined;
      }
      const [title, interactiveElements, contentElements] = await Promise.all([
        p.title(),
        collectInteractiveElements(p),
        collectContentElements(p),
      ]);
      return {
        url: p.url(),
        title,
        interactiveElements,
        contentElements,
        axTree,
        modalText,
        bodyText,
      };
    },

    async click(selector: string): Promise<void> {
      const p = requireStarted(page, 'click');
      const before = await contentSignature(p).catch(() => undefined);
      await p.locator(selector).first().click();
      if (before === undefined) return;
      const deadline = Date.now() + CLICK_SETTLE_TIMEOUT_MS;
      for (;;) {
        const after: string = await contentSignature(p).catch(() => before);
        if (after !== before || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, SAME_DOC_POLL_MS));
      }
    },

    async clickAt(point: Point): Promise<void> {
      const p = requireStarted(page, 'clickAt');
      await p.mouse.click(point.x, point.y);
    },

    async type(selector: string, text: string): Promise<void> {
      const p = requireStarted(page, 'type');
      await p.locator(selector).first().fill(text);
    },

    async pressKey(key: string): Promise<void> {
      const p = requireStarted(page, 'pressKey');
      await p.keyboard.press(key);
    },

    onFrame(cb: (png: Buffer) => void): () => void {
      return mirror.subscribe(cb);
    },

    drainNetworkEvents(): CapturedNetworkEvent[] {
      const drained = networkBuffer;
      networkBuffer = [];
      return drained;
    },

    async exportStorageState(): Promise<StorageState> {
      const ctx = requireStarted(context, 'exportStorageState');
      return ctx.storageState();
    },

    async stop(): Promise<void> {
      await teardown();
    },
  };
}
