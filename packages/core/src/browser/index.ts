import { notImplemented } from '../util/not-implemented.js';
import type { BrowserSurface, BrowserSurfaceOptions, DomSnapshot, Point } from './types.js';

export * from './types.js';

/** Foundation stub — real Playwright/CDP surface implemented in M1 (browser/ module). */
export function createBrowserSurface(): BrowserSurface {
  return {
    start(_opts?: BrowserSurfaceOptions): Promise<void> {
      return notImplemented('BrowserSurface.start');
    },
    goto(_url: string): Promise<void> {
      return notImplemented('BrowserSurface.goto');
    },
    screenshot(): Promise<Buffer> {
      return notImplemented('BrowserSurface.screenshot');
    },
    snapshot(): Promise<DomSnapshot> {
      return notImplemented('BrowserSurface.snapshot');
    },
    click(_selector: string): Promise<void> {
      return notImplemented('BrowserSurface.click');
    },
    clickAt(_point: Point): Promise<void> {
      return notImplemented('BrowserSurface.clickAt');
    },
    type(_selector: string, _text: string): Promise<void> {
      return notImplemented('BrowserSurface.type');
    },
    pressKey(_key: string): Promise<void> {
      return notImplemented('BrowserSurface.pressKey');
    },
    onFrame(_cb: (png: Buffer) => void): () => void {
      return () => undefined;
    },
    stop(): Promise<void> {
      return notImplemented('BrowserSurface.stop');
    },
  };
}
