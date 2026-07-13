import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { collectInteractiveElements } from './selectors.js';
import { FrameMirror } from './mirror.js';
import type { BrowserSurface, BrowserSurfaceOptions, DomSnapshot, Point } from './types.js';

export * from './types.js';

const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

/** Throw a uniform error when the surface is used before {@link start}. */
function requireStarted<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`[healix] BrowserSurface.${what} called before start(); call start() first.`);
  }
  return value;
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

  const mirror = new FrameMirror(() => page);

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

        browser = await chromium.launch({ headless });
        try {
          context = await browser.newContext({ viewport });
          page = await context.newPage();
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
      await p.goto(resolveUrl(url), { waitUntil: 'domcontentloaded' });
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
      const [title, interactiveElements] = await Promise.all([p.title(), collectInteractiveElements(p)]);
      return {
        url: p.url(),
        title,
        interactiveElements,
        axTree,
      };
    },

    async click(selector: string): Promise<void> {
      const p = requireStarted(page, 'click');
      await p.locator(selector).first().click();
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

    async stop(): Promise<void> {
      await teardown();
    },
  };
}
