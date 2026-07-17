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
}

export interface DomSnapshot {
  url: string;
  title: string;
  interactiveElements: InteractiveElement[];
  axTree?: unknown;
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
  stop(): Promise<void>;
}
