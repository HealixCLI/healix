import type { Page } from 'playwright';

/** Target ~2fps live mirror. */
const FRAME_INTERVAL_MS = 500;

/**
 * Live-mirror frames are JPEG (quality 70), not PNG: a full-page PNG of a real
 * app is routinely several times larger than the equivalent JPEG, and at ~2fps
 * every frame crosses the process boundary (base64 over IPC to the renderer).
 * JPEG keeps the stream cheap; mild compression artifacts are fine for a
 * preview. Durable evidence screenshots (browser/index.ts) stay PNG.
 */
const FRAME_SCREENSHOT_OPTIONS = { type: 'jpeg', quality: 70 } as const;

/**
 * Drives a live JPEG screenshot stream off a single page at ~2fps.
 *
 * Multiple subscribers share one capture loop; we only capture while there is
 * at least one subscriber, and we guard against overlapping captures so a slow
 * screenshot never queues up behind itself.
 */
export class FrameMirror {
  private readonly subscribers = new Set<(frame: Buffer) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private capturing = false;
  private readonly getPage: () => Page | undefined;

  constructor(getPage: () => Page | undefined) {
    this.getPage = getPage;
  }

  /** Subscribe to live frames; returns an unsubscribe fn. Non-blocking. */
  subscribe(cb: (frame: Buffer) => void): () => void {
    this.subscribers.add(cb);
    this.ensureRunning();
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.subscribers.delete(cb);
      if (this.subscribers.size === 0) {
        this.stop();
      }
    };
  }

  /** Stop the capture loop and drop all subscribers (used on surface stop). */
  dispose(): void {
    this.subscribers.clear();
    this.stop();
  }

  private ensureRunning(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, FRAME_INTERVAL_MS);
    // Don't keep the event loop alive solely for the mirror.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    // Guard against overlapping shots (slow page / large viewport).
    if (this.capturing || this.subscribers.size === 0) {
      return;
    }
    const page = this.getPage();
    if (!page || page.isClosed()) {
      return;
    }

    this.capturing = true;
    try {
      const frame = (await page.screenshot(FRAME_SCREENSHOT_OPTIONS)) as Buffer;
      // Snapshot subscribers so unsubscribing mid-iteration is safe.
      for (const cb of Array.from(this.subscribers)) {
        try {
          cb(frame);
        } catch {
          // A misbehaving subscriber must not break the mirror loop.
        }
      }
    } catch {
      // Page may have navigated/closed between the guard and the capture;
      // swallow and let the next tick retry.
    } finally {
      this.capturing = false;
    }
  }
}
