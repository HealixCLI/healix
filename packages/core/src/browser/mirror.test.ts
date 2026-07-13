/**
 * Unit tests for the FrameMirror capture loop.
 *
 * No real browser: FrameMirror only needs `screenshot()` and `isClosed()` from
 * a Page, so a tiny fake (cast through unknown) plus vitest fake timers drive
 * the ~2fps interval deterministically and fully offline. The `playwright`
 * import in mirror.ts is type-only, so nothing browser-shaped is loaded here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { FrameMirror } from './mirror.js';

interface FakePage {
  screenshot: ReturnType<typeof vi.fn>;
  isClosed: () => boolean;
}

function makeFakePage(frame: Buffer = Buffer.from('jpeg-bytes')): FakePage {
  return {
    screenshot: vi.fn(async () => frame),
    isClosed: () => false,
  };
}

const asPage = (p: FakePage): Page => p as unknown as Page;

describe('FrameMirror', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures JPEG frames (quality 70) and delivers them to subscribers', async () => {
    const page = makeFakePage();
    const mirror = new FrameMirror(() => asPage(page));
    const frames: Buffer[] = [];
    const unsubscribe = mirror.subscribe((f) => frames.push(f));

    await vi.advanceTimersByTimeAsync(500);

    // The live mirror must stream JPEG, not PNG — PNG frames are several times
    // larger and every frame is base64'd over IPC to the renderer.
    expect(page.screenshot).toHaveBeenCalledWith({ type: 'jpeg', quality: 70 });
    expect(frames).toHaveLength(1);
    expect(frames[0].toString()).toBe('jpeg-bytes');

    unsubscribe();
    mirror.dispose();
  });

  it('stops capturing once the last subscriber unsubscribes', async () => {
    const page = makeFakePage();
    const mirror = new FrameMirror(() => asPage(page));
    const unsubscribe = mirror.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(1000);
    const callsWhileSubscribed = page.screenshot.mock.calls.length;
    expect(callsWhileSubscribed).toBeGreaterThan(0);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(2000);
    expect(page.screenshot.mock.calls.length).toBe(callsWhileSubscribed);

    mirror.dispose();
  });

  it('does not capture when no page is available and never throws on a bad subscriber', async () => {
    const page = makeFakePage();
    // Explicit undefined init so the later "page appears" write is a genuine
    // reassignment (prefer-const would otherwise demand an impossible const).
    let current: Page | undefined = undefined;
    const mirror = new FrameMirror(() => current);

    const received: Buffer[] = [];
    mirror.subscribe(() => {
      throw new Error('bad subscriber');
    });
    mirror.subscribe((f) => received.push(f));

    // No page yet: ticks are no-ops.
    await vi.advanceTimersByTimeAsync(1000);
    expect(page.screenshot).not.toHaveBeenCalled();

    // Page appears: the throwing subscriber must not break delivery to others.
    current = asPage(page);
    await vi.advanceTimersByTimeAsync(500);
    expect(received.length).toBeGreaterThan(0);

    mirror.dispose();
  });
});
