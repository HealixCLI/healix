export interface Point {
  x: number;
  y: number;
}

export interface BrowserSurfaceOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  baseUrl?: string;
  /**
   * Pre-seeds the new context's cookies/localStorage from a prior session's exported state (see
   * `BrowserSurface.exportStorageState`) — lets a fresh browser process start already
   * authenticated, without repeating a login. Used by the separate-origin seed fan-out path
   * (multiple Chromium processes can't share one `BrowserContext`, but they can share one login).
   */
  storageState?: unknown;
}

export interface InteractiveElement {
  role: string;
  name: string;
  selector: string;
  /** Raw `href` attribute for `<a>` elements — same-origin links a crawler can follow. */
  href?: string;
  /** Raw `type` attribute for `<input>` elements — lets callers spot password fields. */
  inputType?: string;
  /** Raw `type` attribute for `<button>` elements (e.g. "submit") — lets a click-prober skip a form's submit button. */
  buttonType?: string;
  /** True when the element sits inside a `<form>` — click-probing must never touch in-form controls (could submit a real form). */
  inForm?: boolean;
  /** True when the element is disabled (`disabled` attribute or `aria-disabled="true"`). */
  disabled?: boolean;
  /**
   * True when the element is `readonly` (the `readonly` attribute or `aria-readonly="true"`).
   *
   * Deliberately SEPARATE from `disabled`, because the two mean different things to a generated
   * test: a disabled control can't be clicked, while a readonly input is perfectly clickable and
   * visible but cannot be typed into. Conflating them would drop readonly fields from
   * click-probe candidates rather than merely stopping GENERATE filling them.
   *
   * Captured because its absence has a specific, expensive failure mode: an app that gates a
   * field until its precondition is met (this one makes the password-reset confirm field
   * `readonly` until the first password validates) looked perfectly fillable in the inventory,
   * so GENERATE emitted a `.fill()` and Playwright retried "element is not editable" for the
   * FULL 60s test timeout — a whole test's budget spent on a signal we could see and simply
   * weren't recording.
   */
  readOnly?: boolean;
  /**
   * True when another visible element on the SAME page shares this exact (role, name) pair —
   * e.g. two links both named "foo". A generated `getByRole(role, { name })` locator would
   * strict-mode-violate against either one; callers must warn generation to scope further
   * (`.first()`/`.nth()`/a more specific attribute) rather than assuming role+name is unique.
   */
  ambiguousMatch?: boolean;
  /**
   * Confidence ranking of `selector`'s stability, from which selectorFor() branch produced it:
   * 1 = data-testid/data-test, 2 = name/aria-label, 3 = unique #id, 4 = positional nth-of-type
   * fallback. Optional so existing hand-built fixtures default to a neutral (no bonus/penalty)
   * score rather than being misread as tier 4.
   */
  selectorTier?: 1 | 2 | 3 | 4;
  /**
   * When `selector` is a positional (tier-4) nth-of-type path sitting among repeated siblings,
   * the nearest repeated ancestor's own clamped text content — e.g. a table row's text. Lets
   * generation prefer a text-anchored Playwright pattern (`.filter({ hasText: ... })`) over the
   * raw index path, which breaks when the list/table reorders.
   */
  repeatedRowText?: string;
  /**
   * Set when this element represents a group of `repeatedGroupSize` near-identical siblings
   * (same role, same selector shape ignoring the nth-of-type index — e.g. a date-picker's day
   * cells, a table's rows) that were collapsed to this one representative — see
   * `collapseRepeatedSiblings` in browser/crawler.ts. Absent for an ordinary, non-repeated
   * element.
   */
  repeatedGroupSize?: number;
}

export interface DomSnapshot {
  url: string;
  title: string;
  interactiveElements: InteractiveElement[];
  axTree?: unknown;
}

/** A single XHR/fetch request/response pair observed while the page was live. */
export interface CapturedNetworkEvent {
  method: string;
  url: string;
  status: number;
  /** Best-effort, size-capped; omitted when the body couldn't be read (binary, redirect, etc). */
  requestBody?: string;
  /** Best-effort, size-capped; omitted when the body couldn't be read (binary, redirect, etc). */
  responseBody?: string;
}

/**
 * Single controllable Chromium (Playwright/CDP) serving BOTH computer-use
 * (screenshots → coordinate actions) and browser-use (DOM/AX actions),
 * mirrored live to the UI via onFrame.
 */
export interface BrowserSurface {
  start(opts?: BrowserSurfaceOptions): Promise<void>;
  goto(url: string): Promise<void>;
  /** Force a genuine reload of the current page — unlike `goto()`, this always re-fetches and
   * re-parses the document from scratch, so it can't suffer `goto()`'s same-URL SPA no-op
   * problem (see `browser/index.ts`'s `goto()` and `crawler.ts`'s `resetAfterProbe`). */
  reload(): Promise<void>;
  screenshot(): Promise<Buffer>;
  snapshot(): Promise<DomSnapshot>;
  click(selector: string): Promise<void>;
  clickAt(point: Point): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  /** Subscribe to a live screenshot stream for UI mirroring; returns an unsubscribe fn. */
  onFrame(cb: (png: Buffer) => void): () => void;
  /** Return and clear the XHR/fetch traffic observed since the last drain (or since start()). */
  drainNetworkEvents(): CapturedNetworkEvent[];
  /** Snapshot this session's cookies/localStorage so a separate `BrowserSurface` can start
   * pre-authenticated from it via `BrowserSurfaceOptions.storageState` — see there for why. */
  exportStorageState(): Promise<unknown>;
  stop(): Promise<void>;
}
