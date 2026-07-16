import { normalizeUrl } from './crawler.js';
import type { BrowserSurface } from './types.js';

export interface LoginAttemptResult {
  ok: boolean;
  /** Post-submit URL, present only when `ok: true`. */
  landingUrl?: string;
  /** Set whenever `ok: false` — why the attempt wasn't trusted. */
  reason?: string;
}

/**
 * Fill and submit a login form at `loginUrl`, then VERIFY the session
 * actually left the login page — a real regression test for the mistake
 * flagged in GAP-017 ("verified" without confirming login succeeded): a
 * wrong-password submit that just re-renders the same form with an inline
 * error would "not throw" and could be mistaken for success if the only
 * check were "did the click succeed". Success requires the URL to have
 * changed away from the login page, or the password field to be gone —
 * ideally both.
 */
export async function attemptLogin(
  browser: BrowserSurface,
  loginUrl: string,
  username: string,
  password: string,
): Promise<LoginAttemptResult> {
  await browser.goto(loginUrl);
  const before = await browser.snapshot();

  const passwordEl = before.interactiveElements.find((el) => el.inputType === 'password');
  if (!passwordEl) {
    return { ok: false, reason: 'no password field found on candidate login page' };
  }
  const usernameEl = before.interactiveElements.find(
    (el) => el.role === 'textbox' && el.inputType !== 'password',
  );
  if (!usernameEl) {
    return { ok: false, reason: 'no username/email field found alongside the password field' };
  }
  const submitEl = before.interactiveElements.find(
    (el) => el.role === 'button' && /sign in|log ?in|submit|continue/i.test(el.name),
  );

  try {
    await browser.type(usernameEl.selector, username);
    await browser.type(passwordEl.selector, password);
    if (submitEl) {
      await browser.click(submitEl.selector);
    } else {
      await browser.pressKey('Enter');
    }
  } catch (err) {
    return {
      ok: false,
      reason: `login form interaction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const after = await browser.snapshot();
  const stillHasPasswordField = after.interactiveElements.some((el) => el.inputType === 'password');
  const navigatedAway = normalizeUrl(after.url) !== normalizeUrl(before.url);

  if (stillHasPasswordField && !navigatedAway) {
    return {
      ok: false,
      reason: 'still on a page with a password field after submitting; login likely failed',
    };
  }

  return { ok: true, landingUrl: after.url };
}
