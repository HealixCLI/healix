import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../exec/run-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec/run-cli.js')>();
  return { ...actual, runCli: vi.fn() };
});

import { runCli } from '../exec/run-cli.js';
import { ensurePlaywrightBrowsersInstalled, looksLikeMissingBrowser } from './ensure-browsers.js';

const runCliMock = vi.mocked(runCli);

function fakeResult(code: number | null) {
  return { code, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 0 };
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
});

describe('ensurePlaywrightBrowsersInstalled', () => {
  beforeEach(() => {
    runCliMock.mockReset();
    // Reset the module's de-dup cache between tests by re-importing is overkill here;
    // instead each test asserts on call args of THIS invocation's resolved promise.
  });

  it('runs a bare `npx playwright install` (no browser name filter)', async () => {
    runCliMock.mockResolvedValueOnce(fakeResult(0));
    const ok = await ensurePlaywrightBrowsersInstalled();
    expect(ok).toBe(true);
    expect(runCliMock).toHaveBeenCalledWith('npx', ['playwright', 'install'], expect.any(Object));
  });
});
