import { runCli } from '../exec/run-cli.js';

/** Generous — a cold Playwright browser download can take a while on a slow connection. */
const INSTALL_TIMEOUT_MS = 180_000;

/** Heuristic: did this error come from a Playwright browser binary that was never downloaded? */
export function looksLikeMissingBrowser(err: unknown): boolean {
  const text = `${err instanceof Error ? err.message : String(err)}\n${err instanceof Error ? (err.stack ?? '') : ''}`;
  return /Executable doesn't exist|browserType\.launch:|please run the following command to download new browsers/i.test(
    text,
  );
}

// Module-level so concurrent callers (e.g. explore + a parallel execute) share one
// install attempt instead of racing several `npx playwright install` processes.
let installPromise: Promise<boolean> | null = null;

/** Runs `npx playwright install` (whatever the local Playwright version needs) at most
 * once per process, de-duping concurrent callers. Resolves to whether it exited cleanly. */
export function ensurePlaywrightBrowsersInstalled(): Promise<boolean> {
  if (!installPromise) {
    installPromise = runCli('npx', ['playwright', 'install'], { timeoutMs: INSTALL_TIMEOUT_MS }).then(
      (res) => res.code === 0,
    );
    // Only cache a SUCCESS permanently. A failed attempt (e.g. a transient network
    // blip) must not poison every later call in this process — clear it so the next
    // caller gets a fresh attempt instead of being stuck with a stale `false` forever.
    installPromise.then((ok) => {
      if (!ok) installPromise = null;
    });
  }
  return installPromise;
}
