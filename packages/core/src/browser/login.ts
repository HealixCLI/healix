import { normalizeUrl } from './crawler.js';
import type { BrowserSurface, DomSnapshot, InteractiveElement } from './types.js';

export interface LoginAttemptResult {
  ok: boolean;
  /** Post-submit URL, present only when `ok: true`. */
  landingUrl?: string;
  /** Set whenever `ok: false` — why the attempt wasn't trusted. */
  reason?: string;
}

/** Matches a submit-ish `selector` — built from `data-testid`/`data-test`/`name`/`aria-label`/`#id`,
 * i.e. developer-facing identifiers that are almost always English even on a fully localized UI. */
const SELECTOR_SUBMIT_HINT_RE = /submit|log[- ]?in|signin|continue|next|proceed/i;
/** Weakest, last-resort signal: the button's user-facing (and possibly localized) accessible name. */
const NAME_SUBMIT_HINT_RE = /sign in|log ?in|submit|continue/i;

/**
 * Finds the login form's submit button without assuming any one language or
 * markup style. Layered from most to least reliable so a page that only
 * satisfies a weaker signal still works, while a page that satisfies a
 * stronger one is never second-guessed by a coincidental weaker match:
 *   1. A `type="submit"` button inside the same `<form>` as the credential
 *      fields — native HTML semantics, correct regardless of visible-text
 *      language.
 *   2. A button whose selector (data-testid/data-test/name/aria-label/#id)
 *      reads as a submit action — engineers overwhelmingly write English
 *      identifiers even for a fully localized product.
 *   3. The original visible-name regex, for markup with neither a semantic
 *      form nor a useful test id/attribute.
 */
function findLoginSubmitButton(elements: InteractiveElement[]): InteractiveElement | undefined {
  const buttons = elements.filter((el) => el.role === 'button' && !el.disabled);
  return (
    buttons.find((el) => el.inForm && el.buttonType === 'submit') ??
    buttons.find((el) => SELECTOR_SUBMIT_HINT_RE.test(el.selector)) ??
    buttons.find((el) => NAME_SUBMIT_HINT_RE.test(el.name))
  );
}

/** Upper bound on how long to wait for a real login's async API chain (token generate, password
 * validate, profile lookup, ...) to redirect away from the login page before giving up. */
const LOGIN_SETTLE_TIMEOUT_MS = 10_000;
const LOGIN_SETTLE_POLL_MS = 250;

/**
 * Polls until the page navigates away from the login URL or the password
 * field disappears, or `LOGIN_SETTLE_TIMEOUT_MS` elapses. A real login is
 * rarely a single synchronous action — this app's login alone chains 4
 * sequential network calls (token generate -> password validate -> profile
 * lookup -> redirect) before the URL changes, so snapshotting immediately
 * after the click reads the pre-redirect state as a failure even when the
 * submit click was entirely correct. Returns immediately (no polling delay)
 * once either condition is already true on the first snapshot, so a fast/
 * synchronous login (or a test double) never pays this timeout.
 */
async function waitForLoginOutcome(browser: BrowserSurface, beforeUrl: string): Promise<DomSnapshot> {
  const deadline = Date.now() + LOGIN_SETTLE_TIMEOUT_MS;
  for (;;) {
    const snapshot = await browser.snapshot();
    const stillHasPasswordField = snapshot.interactiveElements.some((el) => el.inputType === 'password');
    const navigatedAway = normalizeUrl(snapshot.url) !== normalizeUrl(beforeUrl);
    if (navigatedAway || !stillHasPasswordField || Date.now() >= deadline) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, LOGIN_SETTLE_POLL_MS));
  }
}

/**
 * Fill and submit the login form on the CURRENT page, then VERIFY the
 * session actually left the login page — a real regression test for the
 * mistake flagged in GAP-017 ("verified" without confirming login
 * succeeded): a wrong-password submit that just re-renders the same form
 * with an inline error would "not throw" and could be mistaken for success
 * if the only check were "did the click succeed". Success requires the URL
 * to have changed away from the login page, or the password field to be
 * gone — ideally both. Shared by `attemptLogin` (navigates to a dedicated
 * login URL first) and `attemptLoginViaToggle` (reveals an in-page login
 * view first) — everything past "the login form is now on screen" is
 * identical for both.
 */
async function submitLoginAttempt(
  browser: BrowserSurface,
  username: string,
  password: string,
): Promise<LoginAttemptResult> {
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
  const submitEl = findLoginSubmitButton(before.interactiveElements);

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

  const after = await waitForLoginOutcome(browser, before.url);
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

/** Fill and submit a login form at a dedicated `loginUrl`. See `submitLoginAttempt`. */
export async function attemptLogin(
  browser: BrowserSurface,
  loginUrl: string,
  username: string,
  password: string,
): Promise<LoginAttemptResult> {
  await browser.goto(loginUrl);
  return submitLoginAttempt(browser, username, password);
}

/**
 * Same as `attemptLogin`, but for a login view that only exists as a
 * same-URL client-side toggle (no distinct route) discovered during
 * click-probing — see `CrawledRoute.loginToggleSelector` in crawler.ts. A
 * fresh `goto()` alone can't reproduce a toggled-in view (client-side state
 * doesn't survive a reload), so this replays the discovered toggle click
 * in-place, on the same page, immediately before filling the form.
 */
export async function attemptLoginViaToggle(
  browser: BrowserSurface,
  pageUrl: string,
  toggleSelector: string,
  username: string,
  password: string,
): Promise<LoginAttemptResult> {
  await browser.goto(pageUrl);
  try {
    await browser.click(toggleSelector);
  } catch (err) {
    return {
      ok: false,
      reason: `failed to activate login toggle: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return submitLoginAttempt(browser, username, password);
}
