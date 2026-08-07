# Fix: a submit button disabled at fill-time is discarded forever, forcing a fragile Enter-key fallback that can silently no-op

## Bug report

Real reuse run (`run_WcP0jcReoZ`, project `prj_eQg-UbZR2a`) failed Tier B auth setup with:

```
Error: Login did not navigate away from the login page after submitting — still on
http://localhost:4202/#/SK/login with a visible password field. Check credentials or selectors.
```

Both identifier and password fields were located and filled correctly (confirmed via the
error's own diagnostic and by checking the cached `verifiedLogin` — real, specific
`data-testid`-based selectors, not guesses). The user independently confirmed the
configured credentials are correct by logging in manually, **and confirmed that pressing
Enter (not clicking the visible "Pokračovať" button) does successfully log in by hand.**
So this isn't a credential problem, and it isn't proof Enter itself can't work on this
app — the automated attempt failed at something more specific.

## Root cause

The project's cached `exploration-cache.json` records `verifiedLogin` for this app with
**no `submitSelector`**:

```json
{
  "pageUrl": "http://localhost:4202/#/SK/login",
  "identifierSelector": "input[data-testid=\"login-email\"]",
  "passwordSelector": "input[data-testid=\"login-password\"]"
}
```

But the login page's full crawled snapshot **does** contain a real, specific, well-identified
submit button:

```json
{
  "role": "button",
  "name": "Pokračovať",
  "selector": "button[data-testid=\"login-submit\"]",
  "disabled": true
}
```

`disabled: true` here is simply the pre-fill page state (client-side validation gates the
button until both fields hold a value — completely normal, and confirmed non-permanent by
the user's own screenshot showing it enabled once both fields are filled). The problem is
in `packages/core/src/browser/login.ts`'s `findLoginSubmitButton` (line 41-48):

```ts
function findLoginSubmitButton(elements: InteractiveElement[]): InteractiveElement | undefined {
  const buttons = elements.filter((el) => el.role === 'button' && !el.disabled);
  ...
}
```

It unconditionally filters out disabled buttons. `submitLoginAttempt` (line 211-306) calls
this **only once**, against the snapshot taken _before_ credentials were typed
(`before.interactiveElements`, or the toggle-swap-replaced snapshot — never a snapshot
taken _after_ filling):

```ts
const submit = findLoginSubmitButton(before.interactiveElements); // line 272
if (submit) {
  await browser.click(submit.selector);
  finalSubmitSelector = submit.selector;
} else {
  await browser.pressKey('Enter'); // line 277 — no readiness wait at all
}
```

Since the button was disabled in that snapshot, `findLoginSubmitButton` returns
`undefined` regardless of whether it's enabled by the time this code actually runs (after
both fields were typed into) — the button is discarded **permanently**, never
re-considered, and the code falls straight to `browser.pressKey('Enter')` with **zero
wait** for the form/button's own async validation to settle.

This is exactly the gap the generated `auth.setup.ts` fixture's own click-path already
protects against for a _grounded_ submit selector — `waitForSubmitEnabled()`
(`templates.ts:560-567`) polls up to a bounded timeout before clicking. But EXPLORE's own
crawl-time login capture (`login.ts`) has no equivalent wait, and because it never
grounds `submitSelector` at all here, the _replay_ path also never gets a chance to use
that existing, working `waitForSubmitEnabled` logic — it's stuck on the ungrounded,
wait-free Enter fallback (`auth.setup.ts:252-256`: `if (hasGroundedForm &&
!groundedSubmitSelector) { await page.keyboard.press('Enter'); }`, no wait beforehand).

**Why Enter works by hand but not automated**: a human naturally pauses between typing
and pressing Enter — plenty of time for any debounced client-side validation to finish
and the form to consider itself submittable. The automated fixture fills both fields and
presses Enter immediately afterward (only an identifier-value re-verification in between,
no wait), which can race ahead of that same validation window. Manual Enter and automated
Enter aren't necessarily different mechanisms on this app — the automated one is just not
giving the app time to be ready before firing it.

## Fix

Make `submitLoginAttempt` re-consider the FULL button-candidate set (including one that
was disabled at fill-time) after credentials are typed, and give it a bounded chance to
become enabled — mirroring `waitForSubmitEnabled`'s already-proven pattern — before
falling back to Enter. This lets a real, specific button like
`button[data-testid="login-submit"]` get clicked (and its selector correctly grounded
into `verifiedLogin.submitSelector` for future replay) instead of the app being driven
blind through an ungrounded, unwaited Enter press.

### `packages/core/src/browser/login.ts`

1. New `findLoginSubmitButtonCandidate` — same three-tier logic as `findLoginSubmitButton`,
   but without the `!el.disabled` filter (a candidate worth waiting for, not necessarily
   clickable yet):

   ```ts
   function findLoginSubmitButtonCandidate(elements: InteractiveElement[]): InteractiveElement | undefined {
     const buttons = elements.filter((el) => el.role === 'button');
     return (
       buttons.find((el) => el.inForm && el.buttonType === 'submit') ??
       buttons.find((el) => SELECTOR_SUBMIT_HINT_RE.test(el.selector)) ??
       buttons.find((el) => NAME_SUBMIT_HINT_RE.test(el.name))
     );
   }
   ```

   `findLoginSubmitButton` itself is left untouched (still used for the earlier
   `looksLikeSignupSubmission` check at line 230, whose purpose doesn't need
   disabled-button candidates and shouldn't change behavior).

2. New `waitForCandidateEnabled(browser, selector, timeoutMs)` — polls fresh snapshots
   until that specific selector resolves to a non-disabled button, or the timeout elapses:

   ```ts
   const SUBMIT_ENABLE_TIMEOUT_MS = 5_000;
   const SUBMIT_ENABLE_POLL_MS = 200;

   async function waitForCandidateEnabled(
     browser: BrowserSurface,
     selector: string,
     timeoutMs: number,
   ): Promise<boolean> {
     const deadline = Date.now() + timeoutMs;
     for (;;) {
       const snap = await browser.snapshot();
       const el = snap.interactiveElements.find((e) => e.selector === selector);
       if (el && !el.disabled) return true;
       if (Date.now() >= deadline) return false;
       await new Promise((resolve) => setTimeout(resolve, SUBMIT_ENABLE_POLL_MS));
     }
   }
   ```

3. `submitLoginAttempt`'s submit-decision block (lines 272-278) becomes:

   ```ts
   // Prefer an ALREADY-enabled candidate first — a weaker-tier button that's already
   // clickable beats waiting on a stronger-tier one that might never enable.
   let submit = findLoginSubmitButton(before.interactiveElements);
   if (!submit) {
     const candidate = findLoginSubmitButtonCandidate(before.interactiveElements);
     if (
       candidate &&
       (await waitForCandidateEnabled(browser, candidate.selector, SUBMIT_ENABLE_TIMEOUT_MS))
     ) {
       submit = candidate;
     }
   }
   if (submit) {
     await browser.click(submit.selector);
     finalSubmitSelector = submit.selector;
   } else {
     await browser.pressKey('Enter');
   }
   ```

   The `findLoginSubmitButton(...)` first check is a deliberate, load-bearing ordering
   decision, not just a redundant fast path: it MUST run first and MUST short-circuit the
   wait whenever it finds anything, because a page can have a strong-tier candidate that's
   disabled and STAYS disabled (broken button, or a form that only submits differently)
   alongside a weaker-tier candidate that's already perfectly clickable — waiting on the
   strong-tier one first would abandon a working button in favor of a 5s wait that only
   ends in a worse fallback (Enter). Confirmed against the existing regression test "never
   picks a disabled button at any tier" (`login.test.ts`), which encodes exactly this
   shape: a disabled tier-1 `inForm`+`type=submit` button alongside an enabled tier-3
   name-matched fallback — must still click the enabled fallback, unchanged.

   Fail-open in every other case, exactly matching today's behavior: no candidate at all
   → straight to Enter (same as today, zero added latency); the one candidate that exists
   never becomes enabled within 5s (genuinely broken form, or credentials the app's own
   validation never accepts) → falls back to Enter after the wait, same outcome as today
   just with a bounded, small added latency. The only case that changes is exactly the one
   this bug describes: NOTHING is currently enabled, but the best candidate reliably
   becomes enabled soon after filling — now gets clicked and grounded instead of silently
   falling to an unwaited Enter press.

### Why this doesn't touch `auth.setup.ts` / `templates.ts`

No change needed there: once `submitLoginAttempt` starts grounding a real
`submitSelector` for apps like this, `verifiedLogin.submitSelector` is populated, and the
EXISTING replay logic already prefers it correctly (`auth.setup.ts`'s
`groundedSubmitSelector` branch, which already calls `waitForSubmitEnabled` before
clicking). The bug was entirely upstream, in EXPLORE never grounding the button in the
first place — fixing that one point fixes the whole downstream replay path for free.

### Residual note: previously-cached data stays wrong until re-explored

This fix changes future EXPLORE crawls, not data already sitting in an existing
`exploration-cache.json`. Fixing the underlying `login.ts` logic doesn't retroactively
repair `prj_eQg-UbZR2a`'s current stale cache entry — it still has no `submitSelector`
until that project's cache is cleared (or naturally expires, for a run that isn't reuse
mode) and a fresh EXPLORE re-runs `submitLoginAttempt` with the fixed logic.

## Verification plan

- Unit test on `submitLoginAttempt`: a fake `BrowserSurface` whose `snapshot()` returns a
  submit button as `disabled: true` on the first call and `disabled: false` on a
  subsequent call (simulating the real app's validation settling shortly after fill) —
  assert the button IS clicked (not Enter), and `selectors.submit` is populated with its
  selector.
- Unit test: a fake browser whose submit-button candidate NEVER becomes enabled within
  the timeout — assert it falls back to `pressKey('Enter')`, unchanged from today, and
  the returned `selectors.submit` is `undefined`.
- Regression test: a page with genuinely no submit-button-shaped element at all — assert
  `findLoginSubmitButtonCandidate` returns `undefined` and the flow goes straight to
  Enter with no wait/polling overhead (same latency as today for this case).
- Regression test: `looksLikeSignupSubmission`'s existing behavior (using
  `findLoginSubmitButton`, untouched) is unaffected — still correctly detects a
  registration-only submit control.
- Manual: clear `prj_eQg-UbZR2a`'s exploration cache, re-run EXPLORE, confirm the new
  `verifiedLogin` now carries a `submitSelector` (`button[data-testid="login-submit"]`),
  then run reuse mode and confirm Tier B auth setup succeeds (no
  `"Login did not navigate away..."` error) using the click path instead of Enter.

## Critical files

- `packages/core/src/browser/login.ts` — `findLoginSubmitButton` (41-48, untouched, kept
  for `looksLikeSignupSubmission`), new `findLoginSubmitButtonCandidate` and
  `waitForCandidateEnabled`, `submitLoginAttempt`'s submit-decision block (272-278,
  primary fix site)
- `packages/core/src/modes/playwright/templates.ts` — `waitForSubmitEnabled` (560-567),
  reused as the pattern this fix mirrors; no changes needed, already correct
- `packages/core/src/modes/playwright/auth.setup.ts` template — reused as-is; no changes
  needed, already correctly prefers a grounded `submitSelector` when present
