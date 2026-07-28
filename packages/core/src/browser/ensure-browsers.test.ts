import { describe, expect, it, vi } from 'vitest';

vi.mock('../exec/run-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec/run-cli.js')>();
  return { ...actual, runCli: vi.fn() };
});

import { looksLikeMissingBrowser } from './ensure-browsers.js';

function fakeResult(code: number | null) {
  return { code, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 0 };
}

/**
 * ensurePlaywrightBrowsersInstalled() caches its result at MODULE scope (see its own
 * comment), so testing dedup/cache-clear-on-failure needs a genuinely fresh module
 * instance per test rather than the file's one shared static import — vi.resetModules()
 * plus a dynamic re-import gives each test its own `installPromise` starting at null.
 */
async function freshEnsureBrowsers() {
  vi.resetModules();
  const runCliModule = await import('../exec/run-cli.js');
  const ensureBrowsersModule = await import('./ensure-browsers.js');
  const runCliMock = vi.mocked(runCliModule.runCli);
  // The mock FUNCTION instance itself is memoized per resolved module id across this
  // file's whole run (only ensure-browsers.js's own `installPromise` state actually
  // resets), so its call history carries over between tests unless cleared here.
  runCliMock.mockClear();
  return {
    runCliMock,
    ensurePlaywrightBrowsersInstalled: ensureBrowsersModule.ensurePlaywrightBrowsersInstalled,
  };
}

describe('looksLikeMissingBrowser', () => {
  it('recognizes the real chromium-headless-shell "Executable doesn\'t exist" error', () => {
    const err = new Error(
      "browserType.launch: Executable doesn't exist at C:\\Users\\x\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1228\\chrome-headless-shell-win64\\chrome-headless-shell.exe\n" +
        'Looks like Playwright was just installed or updated.\n' +
        'Please run the following command to download new browsers:\n\n    pnpm exec playwright install\n',
    );
    expect(looksLikeMissingBrowser(err)).toBe(true);
  });

  it('does not misclassify an unrelated launch failure', () => {
    expect(looksLikeMissingBrowser(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(false);
  });

  it('handles non-Error thrown values without throwing', () => {
    expect(looksLikeMissingBrowser('a plain string')).toBe(false);
  });

  it('handles a plain (non-Error, non-string) thrown value without throwing', () => {
    expect(looksLikeMissingBrowser({ some: 'object' })).toBe(false);
    expect(looksLikeMissingBrowser(undefined)).toBe(false);
    expect(looksLikeMissingBrowser(null)).toBe(false);
  });

  it('matches on the bare "browserType.launch:" prefix alone (no "Executable doesn\'t exist" phrase)', () => {
    expect(looksLikeMissingBrowser(new Error('browserType.launch: some other launch failure'))).toBe(true);
  });

  it('matches on the "please run the following command to download new browsers" phrase alone', () => {
    expect(
      looksLikeMissingBrowser(
        new Error(
          'Looks like Playwright was just installed or updated.\nPlease run the following command to download new browsers:\n',
        ),
      ),
    ).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(looksLikeMissingBrowser(new Error("EXECUTABLE DOESN'T EXIST at /some/path"))).toBe(true);
  });

  it('matches when the signature is only in the stack, not the message', () => {
    const err = new Error('launch failed');
    err.stack = "Error: launch failed\n    at browserType.launch: Executable doesn't exist at /some/path";
    expect(looksLikeMissingBrowser(err)).toBe(true);
  });

  it('does not match a normal assertion or selector failure', () => {
    expect(
      looksLikeMissingBrowser(new Error("locator.click: Error: locator not found for getByRole('button')")),
    ).toBe(false);
    expect(looksLikeMissingBrowser(new Error('expect(locator).toHaveText(expected) failed'))).toBe(false);
  });
});

describe('ensurePlaywrightBrowsersInstalled', () => {
  it('runs a bare `npx playwright install` (no browser name filter)', async () => {
    const { runCliMock, ensurePlaywrightBrowsersInstalled } = await freshEnsureBrowsers();
    runCliMock.mockResolvedValueOnce(fakeResult(0));
    const ok = await ensurePlaywrightBrowsersInstalled();
    expect(ok).toBe(true);
    expect(runCliMock).toHaveBeenCalledWith('npx', ['playwright', 'install'], expect.any(Object));
  });

  it('resolves false (without throwing) when the install exits non-zero', async () => {
    const { runCliMock, ensurePlaywrightBrowsersInstalled } = await freshEnsureBrowsers();
    runCliMock.mockResolvedValueOnce(fakeResult(1));
    await expect(ensurePlaywrightBrowsersInstalled()).resolves.toBe(false);
  });

  it('de-dupes concurrent callers: two overlapping calls share one install, not two', async () => {
    const { runCliMock, ensurePlaywrightBrowsersInstalled } = await freshEnsureBrowsers();
    let resolveInstall!: (v: ReturnType<typeof fakeResult>) => void;
    runCliMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        }),
    );

    const first = ensurePlaywrightBrowsersInstalled();
    const second = ensurePlaywrightBrowsersInstalled();
    resolveInstall(fakeResult(0));

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(runCliMock).toHaveBeenCalledTimes(1);
  });

  it('caches a SUCCESS: a later call does not re-run the install', async () => {
    const { runCliMock, ensurePlaywrightBrowsersInstalled } = await freshEnsureBrowsers();
    runCliMock.mockResolvedValueOnce(fakeResult(0));
    await ensurePlaywrightBrowsersInstalled();
    await ensurePlaywrightBrowsersInstalled();
    expect(runCliMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a FAILURE: a later call retries the install rather than staying stuck at false', async () => {
    const { runCliMock, ensurePlaywrightBrowsersInstalled } = await freshEnsureBrowsers();
    runCliMock.mockResolvedValueOnce(fakeResult(1));
    expect(await ensurePlaywrightBrowsersInstalled()).toBe(false);

    runCliMock.mockResolvedValueOnce(fakeResult(0));
    expect(await ensurePlaywrightBrowsersInstalled()).toBe(true);
    expect(runCliMock).toHaveBeenCalledTimes(2);
  });

  it('passes a generous install timeout through to runCli', async () => {
    const { runCliMock, ensurePlaywrightBrowsersInstalled } = await freshEnsureBrowsers();
    runCliMock.mockResolvedValueOnce(fakeResult(0));
    await ensurePlaywrightBrowsersInstalled();
    const opts = runCliMock.mock.calls[0]?.[2] as { timeoutMs?: number } | undefined;
    expect(opts?.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});
