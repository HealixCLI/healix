import { LOGIN_TEXT_RE, LOGIN_URL_HINT_RE, SIGNUP_URL_HINT_RE, normalizeUrl } from './crawler.js';
import type { BrowserSurface, CapturedNetworkEvent, DomSnapshot, InteractiveElement } from './types.js';

export interface LoginAttemptResult {
  ok: boolean;
  /** Post-submit URL, present only when `ok: true`. */
  landingUrl?: string;
  /** Set whenever `ok: false` — why the attempt wasn't trusted. */
  reason?: string;
  /**
   * The exact selectors just proven to work, present only when `ok: true` — the FINAL
   * identifier/password elements actually typed into (post toggle-swap re-fill, if that
   * kicked in) and the submit control actually clicked. `submit` is absent when submission
   * fell back to pressing Enter (no submit button was found). Lets a caller ground a
   * downstream, independently-generated login flow in what demonstrably worked here instead
   * of re-guessing from scratch.
   */
  selectors?: { identifier: string; password: string; submit?: string };
  /**
   * Network traffic captured from the submit click through the outcome settling, present only
   * when `ok: true` — this is the REAL login response (the actual account's real id/email/name,
   * a real signed token), the one piece of ground truth every mock/identity-reconciliation pass
   * downstream needs but, until now, never received: nothing else in a run ever performs a real
   * login again, so a caller that discards this (as crawl()'s own startup drain used to do
   * unconditionally) leaves reconciliation permanently dependent on some OTHER page happening to
   * expose the same identity by luck. Pass this to crawl() as `seedNetworkEvents` instead.
   */
  networkEvents?: CapturedNetworkEvent[];
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

/**
 * The username/email field for a login form is the non-password textbox
 * CLOSEST to the password field in DOM order — not just the first textbox
 * anywhere on the page. A real page can have unrelated textboxes ahead of
 * the actual login field (a header search box, a newsletter/promo-code
 * signup elsewhere on the page); picking the first one blind would type the
 * username into the wrong element, fill the password correctly, and then
 * fail submit — indistinguishable from a genuine wrong-credentials failure.
 */
function findNearestUsernameField(
  elements: InteractiveElement[],
  passwordIndex: number,
): InteractiveElement | undefined {
  let best: InteractiveElement | undefined;
  let bestDistance = Infinity;
  elements.forEach((el, i) => {
    if (el.role !== 'textbox' || el.inputType === 'password') return;
    const distance = Math.abs(i - passwordIndex);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = el;
    }
  });
  return best;
}

/** Upper bound on how long to wait for a real login's async API chain (token generate, password
 * validate, profile lookup, ...) to redirect away from the login page before giving up. */
const LOGIN_SETTLE_TIMEOUT_MS = 10_000;
const LOGIN_SETTLE_POLL_MS = 250;

/** Upper bound on how long to wait for the credential fields to MOUNT before concluding a
 * candidate page has no login form. See `waitForCredentialForm`. */
const FORM_MOUNT_TIMEOUT_MS = 5_000;
const FORM_MOUNT_POLL_MS = 250;

function passwordFieldOf(snapshot: DomSnapshot): InteractiveElement | undefined {
  return snapshot.interactiveElements.find((el) => el.inputType === 'password');
}

/**
 * Polls until a password field is present, clicking a login-reveal control if one turns up
 * along the way, or gives up after `FORM_MOUNT_TIMEOUT_MS`.
 *
 * A single snapshot taken straight after `goto()` is not evidence that a page has no login
 * form — on a client-side-routed app the route component may not have mounted yet, and the
 * frame can still hold the PREVIOUS route's elements or none at all. Concluding "no password
 * field found on candidate login page" from that one look is how a real run reported exactly
 * that about a page which, navigated to by hand, renders its password field perfectly well —
 * and because that reason aborts the login, the entire authenticated half of the crawl never
 * ran and every Tier B spec shipped ungrounded.
 *
 * The reveal click is folded into this loop rather than tried after it, so a toggle-gated form
 * is revealed on the first iteration (immediately) instead of after the mount timeout has
 * already elapsed — waiting 5s for a form that was only ever going to appear on a click is
 * pure latency, paid on every login attempt against such an app. Returns the last snapshot
 * either way, so the caller reports a genuine absence after a real wait, not after one frame.
 */
async function waitForCredentialForm(browser: BrowserSurface): Promise<DomSnapshot> {
  const deadline = Date.now() + FORM_MOUNT_TIMEOUT_MS;
  let snapshot = await browser.snapshot();
  let revealAttempted = false;
  for (;;) {
    if (passwordFieldOf(snapshot)) return snapshot;

    if (!revealAttempted) {
      const reveal = findLoginRevealControl(snapshot.interactiveElements);
      if (reveal) {
        // Only ever one attempt: if clicking it didn't produce a form, clicking again won't,
        // and a toggle clicked twice can just as easily switch the login view back off.
        revealAttempted = true;
        try {
          await browser.click(reveal.selector);
          snapshot = await browser.snapshot();
          continue;
        } catch {
          // Reveal click failed — keep polling. A genuine absence is the caller's diagnosis to
          // report, and it's more useful than "a click we guessed at didn't work".
        }
      }
    }

    if (Date.now() >= deadline) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, FORM_MOUNT_POLL_MS));
    snapshot = await browser.snapshot();
  }
}

/**
 * A control that reveals a login form hidden behind a click — the register/login switch some
 * SPAs use instead of two routes. Unlike crawler.ts's click-probing (which must never touch
 * in-form controls, since a stray click could submit something), this runs on a page we are
 * deliberately trying to log in through, so an in-form "Prihlásiť sa"/"Sign in" button is
 * exactly the control we want. Submit-typed buttons are still excluded: those submit the form
 * we're trying to get AWAY from.
 */
function findLoginRevealControl(elements: InteractiveElement[]): InteractiveElement | undefined {
  return elements.find(
    (el) =>
      !el.disabled &&
      (el.role === 'button' || el.role === 'link') &&
      el.buttonType !== 'submit' &&
      LOGIN_TEXT_RE.test(el.name),
  );
}

/**
 * True when submitting would register a new account rather than log in: the resolved submit
 * control identifies itself as a signup control AND the page's own URL reads as signup, with
 * no login hint anywhere to contradict either.
 *
 * `findLoginSubmitButton`'s strongest tier is "the `type="submit"` button inside the same
 * form", which on a registration page is the REGISTRATION submit — so a login attempt pointed
 * at a register page (which is what an unfixed login-candidate ranking produces) would fill a
 * real signup form with the test account's credentials and submit it. Requiring BOTH signals
 * keeps this from misfiring on a legitimate login form that merely lives at a shared
 * `/account` route or carries an unlucky testid.
 */
function looksLikeSignupSubmission(url: string, submit: InteractiveElement | undefined): boolean {
  if (!submit) return false;
  if (LOGIN_URL_HINT_RE.test(url) || LOGIN_TEXT_RE.test(submit.name)) return false;
  return SIGNUP_URL_HINT_RE.test(url) && SIGNUP_URL_HINT_RE.test(submit.selector);
}

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
  // Waits for the credential form to mount, revealing it behind a login toggle if that's what
  // this app needs — see waitForCredentialForm.
  let before = await waitForCredentialForm(browser);
  // Discard whatever page-load noise accumulated getting here, so the capture below (returned
  // to the caller only on success) is scoped to the actual submit attempt — see
  // LoginAttemptResult.networkEvents.
  browser.drainNetworkEvents();

  const passwordIndex = before.interactiveElements.findIndex((el) => el.inputType === 'password');
  const passwordEl = before.interactiveElements[passwordIndex];
  if (!passwordEl) {
    return { ok: false, reason: 'no password field found on candidate login page' };
  }
  const usernameEl = findNearestUsernameField(before.interactiveElements, passwordIndex);
  if (!usernameEl) {
    return { ok: false, reason: 'no username/email field found alongside the password field' };
  }
  const submitEl = findLoginSubmitButton(before.interactiveElements);
  if (looksLikeSignupSubmission(before.url, submitEl)) {
    return {
      ok: false,
      reason: `candidate login page at ${before.url} is a registration form (its only submit control is ${submitEl?.selector}) — refusing to submit it as a login`,
    };
  }

  // Tracks the elements ACTUALLY typed into/clicked, reassigned below if the toggle-swap
  // re-fill branch kicks in — this is what a successful attempt reports back in `selectors`.
  let finalIdentifierSelector = usernameEl.selector;
  let finalPasswordSelector = passwordEl.selector;
  let finalSubmitSelector: string | undefined;

  try {
    await browser.type(usernameEl.selector, username);
    await browser.type(passwordEl.selector, password);

    // Re-check that we're still filling the form we started on. The same click-to-reveal apps
    // that hide a login form behind a toggle swap it in ASYNCHRONOUSLY, so the swap can land
    // BETWEEN the two type() calls above — the username goes into the outgoing form's field,
    // the password into the incoming one's, and the login then fails with a wrong-looking
    // "credentials rejected" that no amount of credential-checking explains. Detected by
    // element identity rather than by reading back the values (BrowserSurface exposes no
    // value read, and a swapped-in field is empty either way): if the password field we typed
    // into is gone, the form was replaced, so re-fill the replacement once.
    const afterFill = await browser.snapshot();
    const stillSameForm = afterFill.interactiveElements.some(
      (el) => el.inputType === 'password' && el.selector === passwordEl.selector,
    );
    if (!stillSameForm) {
      const newPasswordIndex = afterFill.interactiveElements.findIndex((el) => el.inputType === 'password');
      const newPasswordEl = afterFill.interactiveElements[newPasswordIndex];
      const newUsernameEl = findNearestUsernameField(afterFill.interactiveElements, newPasswordIndex);
      if (newPasswordEl && newUsernameEl) {
        await browser.type(newUsernameEl.selector, username);
        await browser.type(newPasswordEl.selector, password);
        before = afterFill;
        finalIdentifierSelector = newUsernameEl.selector;
        finalPasswordSelector = newPasswordEl.selector;
      }
    }

    const submit = findLoginSubmitButton(before.interactiveElements);
    if (submit) {
      await browser.click(submit.selector);
      finalSubmitSelector = submit.selector;
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

  return {
    ok: true,
    landingUrl: after.url,
    selectors: {
      identifier: finalIdentifierSelector,
      password: finalPasswordSelector,
      submit: finalSubmitSelector,
    },
    networkEvents: browser.drainNetworkEvents(),
  };
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
