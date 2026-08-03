export interface Point {
  x: number;
  y: number;
}

export interface BrowserSurfaceOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  baseUrl?: string;
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
}

export interface DomSnapshot {
  url: string;
  title: string;
  interactiveElements: InteractiveElement[];
  axTree?: unknown;
  /** Clamped, concatenated textContent of every visible `[role="dialog"]`/`[role="alertdialog"]`/
   * `[aria-modal="true"]` container present at snapshot time — see selectors.ts's
   * collectModalText(). Deliberately scoped to this precise ARIA signal only (not a fuzzy
   * z-index/class heuristic), to keep false positives low; silently absent on an app with no
   * semantic dialog markup (a known, accepted limitation — see Cluster E). */
  modalText?: string;
  /** Clamped `document.body.textContent` at snapshot time — the "rest of the page" corpus a
   * modal-scoping check (generate.ts's GroundTruth) compares `modalText` against, to tell
   * "permanent static page copy" apart from content that only exists once a modal is open. */
  bodyText?: string;
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
  /** The response's real `content-type` header, when readable (GAP-063 follow-up: lets a
   * mock built from this event serve back the real content-type instead of always
   * defaulting to application/json). */
  contentType?: string;
}

/**
 * Single controllable Chromium (Playwright/CDP) serving BOTH computer-use
 * (screenshots → coordinate actions) and browser-use (DOM/AX actions),
 * mirrored live to the UI via onFrame.
 */
export interface BrowserSurface {
  start(opts?: BrowserSurfaceOptions): Promise<void>;
  goto(url: string): Promise<void>;
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
  stop(): Promise<void>;
}
