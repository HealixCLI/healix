/**
 * Unit tests for createBrowserSurface().start()'s missing-browser self-heal wiring:
 * on a `chromium.launch()` failure that looks like a missing Playwright browser
 * binary, it should install once (ensurePlaywrightBrowsersInstalled) and retry the
 * launch — exactly once, never looping, and never touching install for an
 * unrelated failure. Nothing here exercises a real browser; `playwright` and
 * `./ensure-browsers.js` are both mocked so this only proves the RETRY WIRING
 * itself, independent of real browser/install behavior (covered separately by
 * ensure-browsers.test.ts and a real, non-mocked repro run manually).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const launchMock = vi.fn();
vi.mock('playwright', () => ({
  chromium: { launch: (...args: unknown[]) => launchMock(...args) },
}));

const looksLikeMissingBrowserMock = vi.fn();
const ensurePlaywrightBrowsersInstalledMock = vi.fn();
vi.mock('./ensure-browsers.js', () => ({
  looksLikeMissingBrowser: (...args: unknown[]) => looksLikeMissingBrowserMock(...args),
  ensurePlaywrightBrowsersInstalled: (...args: unknown[]) => ensurePlaywrightBrowsersInstalledMock(...args),
}));

import { createBrowserSurface } from './index.js';

function fakeBrowser() {
  const page = { on: vi.fn() };
  const context = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { browser, context, page };
}

describe('createBrowserSurface().start() — missing-browser self-heal wiring', () => {
  beforeEach(() => {
    launchMock.mockReset();
    looksLikeMissingBrowserMock.mockReset();
    ensurePlaywrightBrowsersInstalledMock.mockReset();
  });

  it('launches normally on the first try when nothing is missing (install never attempted)', async () => {
    const { browser } = fakeBrowser();
    launchMock.mockResolvedValueOnce(browser);

    const surface = createBrowserSurface();
    await surface.start({ headless: true });

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(ensurePlaywrightBrowsersInstalledMock).not.toHaveBeenCalled();
  });

  it('self-heals: on a missing-browser error, installs once and retries the launch, which then succeeds', async () => {
    const { browser } = fakeBrowser();
    const err = new Error("Executable doesn't exist");
    launchMock.mockRejectedValueOnce(err).mockResolvedValueOnce(browser);
    looksLikeMissingBrowserMock.mockReturnValue(true);
    ensurePlaywrightBrowsersInstalledMock.mockResolvedValue(true);

    const surface = createBrowserSurface();
    await surface.start({ headless: true });

    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(ensurePlaywrightBrowsersInstalledMock).toHaveBeenCalledTimes(1);
  });

  it('does not attempt install/retry for an unrelated launch failure, and rethrows it as-is', async () => {
    const err = new Error('some other launch failure');
    launchMock.mockRejectedValueOnce(err);
    looksLikeMissingBrowserMock.mockReturnValue(false);

    const surface = createBrowserSurface();
    await expect(surface.start({ headless: true })).rejects.toThrow('some other launch failure');

    expect(ensurePlaywrightBrowsersInstalledMock).not.toHaveBeenCalled();
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows the ORIGINAL error (not a generic one), and does not retry the launch, when the install itself fails', async () => {
    const err = new Error("Executable doesn't exist");
    launchMock.mockRejectedValueOnce(err);
    looksLikeMissingBrowserMock.mockReturnValue(true);
    ensurePlaywrightBrowsersInstalledMock.mockResolvedValue(false);

    const surface = createBrowserSurface();
    await expect(surface.start({ headless: true })).rejects.toBe(err);

    expect(launchMock).toHaveBeenCalledTimes(1);
  });
});
