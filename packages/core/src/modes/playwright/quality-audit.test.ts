/**
 * Unit tests for the static quality audit (Phase A of the enhanced
 * validator): splitTestBlocks (structural test(...) block splitter),
 * auditSpecQuality (hard vs. soft findings), and pruneHardFindings
 * (block-level removal feeding Phase B's rollback logic in validate.ts).
 */
import { describe, expect, it } from 'vitest';
import { auditSpecQuality, pruneHardFindings, splitTestBlocks } from './quality-audit.js';

const HEADER = `import { test, expect } from '@playwright/test';\n\n`;

describe('splitTestBlocks', () => {
  it('finds a single top-level test() block with its title', () => {
    const source = `${HEADER}test('does a thing', async ({ page }) => {\n  await expect(page).toHaveTitle('X');\n});\n`;
    const blocks = splitTestBlocks(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe('does a thing');
    expect(blocks[0].body).toContain('toHaveTitle');
  });

  it('finds multiple blocks and is not confused by nested braces/parens', () => {
    const source = `${HEADER}test('a', async ({ page }) => {\n  if (true) { await page.click('x'); }\n  await expect(page).toHaveURL(/x/);\n});\n\ntest.only('b', async ({ page }) => {\n  await expect(page).toHaveTitle('Y');\n});\n`;
    const blocks = splitTestBlocks(source);
    expect(blocks.map((b) => b.title)).toEqual(['a', 'b']);
  });

  it('ignores test(...) mentioned inside a string or comment', () => {
    const source = `${HEADER}// test('not real', () => {});\ntest('real', async ({ page }) => {\n  const s = "test(fake)";\n  await expect(page).toHaveTitle('Z');\n});\n`;
    const blocks = splitTestBlocks(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe('real');
  });

  it('does not treat test.describe(...) as an assertable block', () => {
    const source = `${HEADER}test.describe('group', () => {\n  test('inner', async ({ page }) => {\n    await expect(page).toHaveTitle('Z');\n  });\n});\n`;
    const blocks = splitTestBlocks(source);
    // The describe wrapper itself is not a match target (regex excludes it);
    // only the inner test() call is found, nested inside describe's braces.
    expect(blocks.map((b) => b.title)).toEqual(['inner']);
  });
});

describe('auditSpecQuality', () => {
  function block(title: string, body: string): string {
    return `${HEADER}test('${title}', async ({ page }) => {\n${body}\n});\n`;
  }

  it('returns no findings for a clean, well-formed test', () => {
    const source = block('works', `  await page.goto('/');\n  await expect(page).toHaveTitle(/Home/);`);
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('flags a test with zero assertions as a hard finding', () => {
    const source = block('does nothing', `  await page.goto('/');\n  await page.click('button');`);
    const findings = auditSpecQuality(source);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'empty-assertion-block', severity: 'hard' });
    expect(findings[0].blockRange).toBeDefined();
  });

  it('flags a wildcard toHaveURL/toHaveTitle assertion as a hard finding', () => {
    const source = block('vacuous', `  await expect(page).toHaveURL(/.*/ );`);
    const findings = auditSpecQuality(source);
    expect(findings.some((f) => f.code === 'useless-wildcard-assertion' && f.severity === 'hard')).toBe(true);
  });

  it('flags a hardcoded absolute-URL assertion as a soft (warn) finding', () => {
    const source = block('nav', `  await expect(page).toHaveURL('http://localhost:4202/home');`);
    const findings = auditSpecQuality(source);
    expect(findings).toEqual([expect.objectContaining({ code: 'absolute-url-assertion', severity: 'warn' })]);
  });

  it('flags a non-placeholder email literal filled into a form as a soft (warn) finding', () => {
    const source = block(
      'login',
      `  await page.getByLabel('Email').fill('real.user@corp-internal.io');\n  await expect(page).toHaveTitle(/Dashboard/);`,
    );
    const findings = auditSpecQuality(source);
    expect(findings).toEqual([
      expect.objectContaining({ code: 'hardcoded-credential-literal', severity: 'warn' }),
    ]);
  });

  it('does not flag an obviously-fake placeholder email domain', () => {
    const source = block(
      'login',
      `  await page.getByLabel('Email').fill('test@example.com');\n  await expect(page).toHaveTitle(/Dashboard/);`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('hard-fails a login-form submission that fills a literal credential when the project has a configured credential', () => {
    const source = block(
      'succeeds with valid input',
      `  await page.getByLabel('Email').fill('registered.user@example.com');\n  await page.getByLabel('Password').fill('hunter2');\n  await page.getByRole('button', { name: 'Sign in' }).click();\n  await expect(page).toHaveURL(/dashboard/);`,
    );
    const findings = auditSpecQuality(source, { hasCredentials: true });
    expect(findings).toEqual([
      expect.objectContaining({ code: 'invented-login-credential', severity: 'hard' }),
    ]);
  });

  it('does not flag a login-form submission when the project has no configured credential', () => {
    const source = block(
      'succeeds with valid input',
      `  await page.getByLabel('Email').fill('registered.user@example.com');\n  await page.getByLabel('Password').fill('hunter2');\n  await page.getByRole('button', { name: 'Sign in' }).click();\n  await expect(page).toHaveURL(/dashboard/);`,
    );
    expect(auditSpecQuality(source, { hasCredentials: false })).toEqual([]);
  });

  it('does not flag a login-form submission that references the real credential env vars', () => {
    const source = block(
      'succeeds with valid input',
      `  await page.getByLabel('Email').fill(process.env.HEALIX_TIERB_EMAIL!);\n  await page.getByLabel('Password').fill(process.env.HEALIX_TIERB_PASSWORD!);\n  await page.getByRole('button', { name: 'Sign in' }).click();\n  await expect(page).toHaveURL(/dashboard/);`,
    );
    expect(auditSpecQuality(source, { hasCredentials: true })).toEqual([]);
  });

  it('does not flag a correctly-grounded login whose third, unrelated field (e.g. a promo code) is filled with a literal', () => {
    const source = block(
      'succeeds with valid input',
      `  await page.getByLabel('Email').fill(process.env.HEALIX_TIERB_EMAIL!);\n  await page.getByLabel('Password').fill(process.env.HEALIX_TIERB_PASSWORD!);\n  await page.getByLabel('Promo code').fill('WELCOME10');\n  await page.getByRole('button', { name: 'Sign in' }).click();\n  await expect(page).toHaveURL(/dashboard/);`,
    );
    expect(auditSpecQuality(source, { hasCredentials: true })).toEqual([]);
  });

  it('catches an invented password even when it is filled third, after an unrelated field, by recognizing it by label rather than position', () => {
    const source = block(
      'succeeds with valid input',
      `  await page.getByLabel('Company code').fill('ACME');\n  await page.getByLabel('Email').fill(process.env.HEALIX_TIERB_EMAIL!);\n  await page.getByLabel('Password').fill('hunter2');\n  await page.getByRole('button', { name: 'Sign in' }).click();\n  await expect(page).toHaveURL(/dashboard/);`,
    );
    const findings = auditSpecQuality(source, { hasCredentials: true });
    expect(findings).toEqual([
      expect.objectContaining({ code: 'invented-login-credential', severity: 'hard' }),
    ]);
  });

  it('falls back to checking the first two fills when no fill line has a recognizable email/password label', () => {
    const source = block(
      'succeeds with valid input',
      `  await page.locator('#field1').fill('someone@example.com');\n  await page.locator('#field2').fill('hunter2');\n  await page.getByRole('button', { name: 'Sign in' }).click();\n  await expect(page).toHaveURL(/dashboard/);`,
    );
    const findings = auditSpecQuality(source, { hasCredentials: true });
    expect(findings).toEqual([
      expect.objectContaining({ code: 'invented-login-credential', severity: 'hard' }),
    ]);
  });

  it('does not flag a deliberate invalid-credentials (negative) login scenario for a literal wrong password', () => {
    const source = block(
      'fails with an incorrect password',
      `  await page.getByLabel('Email').fill(process.env.HEALIX_TIERB_EMAIL!);\n  await page.getByLabel('Password').fill('definitely-wrong-password');\n  await page.getByRole('button', { name: 'Sign in' }).click();\n  await expect(page.getByText('Invalid credentials')).toBeVisible();`,
    );
    expect(auditSpecQuality(source, { hasCredentials: true })).toEqual([]);
  });

  it('does not flag a registration/signup form that invents a Date.now()-based email for uniqueness', () => {
    const source = block(
      'registers successfully with a unique email',
      `  await page.getByLabel('Email').fill(\`email-\${Date.now()}@example.com\`);\n  await page.getByLabel('Password').fill('some-password');\n  await page.getByRole('button', { name: 'Register' }).click();\n  await expect(page).toHaveURL(/welcome/);`,
    );
    expect(auditSpecQuality(source, { hasCredentials: true })).toEqual([]);
  });

  it('flags a negative-path test asserting a control becomes enabled as a soft (warn) finding', () => {
    const source = block(
      'shows error for invalid input',
      `  await page.getByLabel('Email').fill('not-an-email');\n  await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled();`,
    );
    const findings = auditSpecQuality(source);
    expect(findings).toEqual([
      expect.objectContaining({ code: 'disabled-button-race-risk', severity: 'warn' }),
    ]);
  });

  it('does not flag an enabled-assertion in a positive-path test', () => {
    const source = block(
      'submits successfully',
      `  await page.getByLabel('Email').fill('test@example.com');\n  await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled();`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('hard-fails a negative-path test that fills invalid input then clicks a submit control with no disabled/enabled assertion at all', () => {
    const source = block(
      'shows validation error for invalid email',
      `  await page.getByLabel('Email').fill('not-an-email');\n  await page.locator('button[data-testid="login-submit"]').click();\n  await expect(page.getByText('Invalid email')).toBeVisible();`,
    );
    const findings = auditSpecQuality(source);
    expect(findings).toEqual([
      expect.objectContaining({ code: 'disabled-button-click-race', severity: 'hard' }),
    ]);
  });

  it('does not hard-fail the click-race shape when the block asserts the control stays disabled', () => {
    const source = block(
      'shows validation error for invalid email',
      `  await page.getByLabel('Email').fill('not-an-email');\n  await expect(page.locator('button[data-testid="login-submit"]')).toBeDisabled();`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('does not hard-fail a negative-path test whose click target has no submit-like hint', () => {
    const source = block(
      'shows an error toast for an invalid coupon code',
      `  await page.getByLabel('Coupon code').fill('not-a-code');\n  await page.getByRole('button', { name: 'Apply' }).click();\n  await expect(page.getByText('Invalid code')).toBeVisible();`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('does not hard-fail a positive-path test that fills and clicks a submit control', () => {
    const source = block(
      'submits successfully',
      `  await page.getByLabel('Email').fill('test@example.com');\n  await page.locator('button[data-testid="login-submit"]').click();\n  await expect(page).toHaveURL(/dashboard/);`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it("flags a blur-titled scenario that fills a field and asserts the message's visibility with no explicit blur trigger", () => {
    const source = block(
      'Empty password on blur shows Password is required',
      `  await page.getByLabel('Password').fill('');\n  await expect(page.getByText('Password is required')).toBeVisible();`,
    );
    const findings = auditSpecQuality(source);
    expect(findings).toEqual([
      expect.objectContaining({ code: 'unblurred-validation-assertion', severity: 'warn' }),
    ]);
  });

  it('does not flag the blur shape when the test explicitly triggers blur before asserting', () => {
    const source = block(
      'Empty password on blur shows Password is required',
      `  await page.getByLabel('Password').fill('');\n  await page.getByLabel('Password').blur();\n  await expect(page.getByText('Password is required')).toBeVisible();`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('does not flag the blur shape when blur is triggered via Tab instead', () => {
    const source = block(
      'Empty password on blur shows Password is required',
      `  await page.getByLabel('Password').fill('');\n  await page.keyboard.press('Tab');\n  await expect(page.getByText('Password is required')).toBeVisible();`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('does not flag a fill+visibility-assertion test whose title has no blur mention', () => {
    const source = block(
      'shows an inline error for an invalid coupon code',
      `  await page.getByLabel('Coupon code').fill('bad-code');\n  await expect(page.getByText('Invalid code')).toBeVisible();`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('flags a click on a bare repeatable-role locator with no name filter as an ambiguous-locator-risk warn', () => {
    const source = block(
      'navigates via the baz link',
      `  await page.getByRole('link').click();\n  await expect(page).toHaveURL(/baz/);`,
    );
    const findings = auditSpecQuality(source);
    expect(findings).toEqual([expect.objectContaining({ code: 'ambiguous-locator-risk', severity: 'warn' })]);
  });

  it('does not flag a role locator narrowed with a name filter', () => {
    const source = block(
      'navigates via the baz link',
      `  await page.getByRole('link', { name: 'Baz' }).click();\n  await expect(page).toHaveURL(/baz/);`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('does not flag a bare role locator chained with .first()', () => {
    const source = block(
      'navigates via the baz link',
      `  await page.getByRole('link').first().click();\n  await expect(page).toHaveURL(/baz/);`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('flags a click on a short getByText locator as an ambiguous-locator-risk warn', () => {
    const source = block(
      'clicks baz',
      `  await page.getByText('baz').click();\n  await expect(page).toHaveURL(/baz/);`,
    );
    const findings = auditSpecQuality(source);
    expect(findings).toEqual([expect.objectContaining({ code: 'ambiguous-locator-risk', severity: 'warn' })]);
  });

  it('does not flag a long, sentence-length getByText locator', () => {
    const source = block(
      'shows the welcome message',
      `  await page.getByText('Welcome back, please choose an option below').click();\n  await expect(page).toHaveURL(/home/);`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('flags a click on a bare CSS class locator as an ambiguous-locator-risk warn', () => {
    const source = block(
      'clicks the alert',
      `  await page.locator('.alert').click();\n  await expect(page).toHaveURL(/alert/);`,
    );
    const findings = auditSpecQuality(source);
    expect(findings).toEqual([expect.objectContaining({ code: 'ambiguous-locator-risk', severity: 'warn' })]);
  });

  it('does not flag a locator scoped by a data-testid attribute selector', () => {
    const source = block(
      'clicks the alert',
      `  await page.locator('[data-testid="alert-banner"]').click();\n  await expect(page).toHaveURL(/alert/);`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('flags a negative-path API test asserting a fixed 200 status as unvalidated-status-code-assumption', () => {
    const source = block(
      'rejects an invalid username with an error',
      `  const response = await request.post('/authenticate', { data: { username: 'nope', password: 'x' } });\n  expect(response.status()).toBe(200);`,
    );
    const findings = auditSpecQuality(source);
    expect(findings).toEqual([
      expect.objectContaining({ code: 'unvalidated-status-code-assumption', severity: 'warn' }),
    ]);
  });

  it('does not flag a positive-path API test asserting a fixed 200 status', () => {
    const source = block(
      'authenticates successfully with valid credentials',
      `  const response = await request.post('/authenticate', { data: { username: 'ok', password: 'x' } });\n  expect(response.status()).toBe(200);`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('does not flag a negative-path API test asserting a non-success status', () => {
    const source = block(
      'rejects an invalid username with an error',
      `  const response = await request.post('/authenticate', { data: { username: 'nope', password: 'x' } });\n  expect(response.status()).toBe(401);`,
    );
    expect(auditSpecQuality(source)).toEqual([]);
  });

  it('audits each block independently across a multi-test file', () => {
    const source = `${HEADER}test('good', async ({ page }) => {\n  await expect(page).toHaveTitle(/Home/);\n});\n\ntest('bad', async ({ page }) => {\n  await page.click('button');\n});\n`;
    const findings = auditSpecQuality(source);
    expect(findings).toHaveLength(1);
    expect(findings[0].testTitle).toBe('bad');
  });

  describe('unattended-destructive-action (Cluster C)', () => {
    it('flags a click on a "Delete account"-named control not wrapped in test.fixme, as HARD', () => {
      const source = block(
        'deletes the account',
        `  await page.getByRole('button', { name: 'Delete account' }).click();\n  await expect(page).toHaveURL(/goodbye/);`,
      );
      const findings = auditSpecQuality(source);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'unattended-destructive-action', severity: 'hard' }),
        ]),
      );
    });

    it('flags a click on a "Pay now"-named control via getByText', () => {
      const source = block(
        'completes the purchase',
        `  await page.getByText('Pay now').click();\n  await expect(page).toHaveURL(/receipt/);`,
      );
      const findings = auditSpecQuality(source);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'unattended-destructive-action', severity: 'hard' }),
        ]),
      );
    });

    it('does not flag the same click when the whole test is wrapped in test.fixme(...)', () => {
      const source = `${HEADER}test.fixme('deletes the account — requires a destructive/irreversible action Healix will not execute automatically; run manually', async ({ page }) => {\n  await page.getByRole('button', { name: 'Delete account' }).click();\n});\n`;
      const findings = auditSpecQuality(source);
      expect(findings.some((f) => f.code === 'unattended-destructive-action')).toBe(false);
    });

    it('does not flag a click on a reversible/safe action ("Save", "Submit", "Logout") — narrow-scope boundary', () => {
      const source = block(
        'saves settings',
        `  await page.getByRole('button', { name: 'Save' }).click();\n  await expect(page).toHaveURL(/settings/);`,
      );
      expect(auditSpecQuality(source).some((f) => f.code === 'unattended-destructive-action')).toBe(false);
    });

    it('does not flag an unrelated CSS/testid selector merely containing "delete" as a substring elsewhere on the line', () => {
      // Only the accessible-name/text argument of getByRole/getByText/getByLabel is checked —
      // an unrelated bare CSS selector must never trigger this HARD finding.
      const source = block(
        'clicks a button',
        `  await page.locator('.delete-icon-wrapper').click();\n  await expect(page).toHaveURL(/x/);`,
      );
      expect(auditSpecQuality(source).some((f) => f.code === 'unattended-destructive-action')).toBe(false);
    });
  });

  describe('unscoped-modal-assertion (Cluster E)', () => {
    it('flags an unscoped getByText assertion when the block also references a dialog elsewhere', () => {
      const source = block(
        'shows the delete confirmation',
        `  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();\n  await expect(page.getByText('Delete your account?')).toBeVisible();`,
      );
      const findings = auditSpecQuality(source);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'unscoped-modal-assertion', severity: 'warn' }),
        ]),
      );
    });

    it('does not flag the same assertion when it is itself scoped to the dialog', () => {
      const source = block(
        'shows the delete confirmation',
        `  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();\n  await expect(page.getByRole('dialog').getByText('Delete your account?')).toBeVisible();`,
      );
      expect(auditSpecQuality(source).some((f) => f.code === 'unscoped-modal-assertion')).toBe(false);
    });

    it('does not flag a getByText assertion when the block never references a dialog at all', () => {
      const source = block(
        'shows a banner',
        `  await expect(page.getByText('Delete your account?')).toBeVisible();`,
      );
      expect(auditSpecQuality(source).some((f) => f.code === 'unscoped-modal-assertion')).toBe(false);
    });
  });

  describe('weak-positive-navigation-assertion', () => {
    it('hard-fails a positive-titled test whose only navigation evidence is not.toHaveURL after a submit-like click — this is the exact shape that let a real login-failure redirect to /login/errorpage still report "passed"', () => {
      const source = block(
        'succeeds with valid input',
        `  await page.locator('button[data-testid="login-submit"]').click();\n  await expect(page).not.toHaveURL(/\\/login$/);`,
      );
      const findings = auditSpecQuality(source);
      expect(findings).toEqual([
        expect.objectContaining({ code: 'weak-positive-navigation-assertion', severity: 'hard' }),
      ]);
    });

    it('does NOT flag a test correctly asserting the user stayed on the current page (no submit-like click at all) — the same assertion shape is legitimate with this opposite intent', () => {
      const source = block(
        'canceling keeps the user on the form',
        `  await page.getByRole('button', { name: 'Cancel' }).click();\n  await expect(page).not.toHaveURL(/\\/dashboard/);`,
      );
      expect(auditSpecQuality(source).some((f) => f.code === 'weak-positive-navigation-assertion')).toBe(
        false,
      );
    });

    it('does not flag it when a real, specific toHaveURL assertion is also present', () => {
      const source = block(
        'succeeds with valid input',
        `  await page.locator('button[data-testid="login-submit"]').click();\n  await expect(page).not.toHaveURL(/\\/login$/);\n  await expect(page).toHaveURL(/\\/dashboard\\/vouchers/);`,
      );
      expect(auditSpecQuality(source).some((f) => f.code === 'weak-positive-navigation-assertion')).toBe(
        false,
      );
    });

    it('does not flag a negative-titled scenario using the same coarse check (a wrong/unknown destination legitimately has no better option)', () => {
      const source = block(
        'shows an error for an invalid password',
        `  await page.locator('button[data-testid="login-submit"]').click();\n  await expect(page).not.toHaveURL(/\\/dashboard/);`,
      );
      expect(auditSpecQuality(source).some((f) => f.code === 'weak-positive-navigation-assertion')).toBe(
        false,
      );
    });

    it('does not flag a neutrally-titled "stays put" test whose click happens to match SUBMIT_CLICK_RE (e.g. a "Save filter" control) — the title never claims a redirect/login/signup happened', () => {
      const source = block(
        'applying a filter does not navigate away from the search results',
        `  await page.getByRole('button', { name: 'Save filter' }).click();\n  await expect(page).not.toHaveURL(/\\/search-results/);`,
      );
      expect(auditSpecQuality(source).some((f) => f.code === 'weak-positive-navigation-assertion')).toBe(
        false,
      );
    });

    it('does not flag a test that already proves the real destination via page CONTENT instead of a URL — even though it also kept a merely-supplementary not.toHaveURL', () => {
      const source = block(
        'succeeds with valid input',
        `  await page.locator('button[data-testid="login-submit"]').click();\n  await expect(page).not.toHaveURL(/\\/login$/);\n  await expect(page.getByText('Vouchers')).toBeVisible();`,
      );
      expect(auditSpecQuality(source).some((f) => f.code === 'weak-positive-navigation-assertion')).toBe(
        false,
      );
    });

    it('does not flag a block with no toHaveURL assertion at all', () => {
      const source = block(
        'succeeds with valid input',
        `  await expect(page.getByText('Welcome')).toBeVisible();`,
      );
      expect(auditSpecQuality(source).some((f) => f.code === 'weak-positive-navigation-assertion')).toBe(
        false,
      );
    });
  });
});

describe('pruneHardFindings', () => {
  it('returns null when there are no hard findings', () => {
    const source = block_('good', `  await expect(page).toHaveTitle(/Home/);`);
    expect(pruneHardFindings(source, [])).toBeNull();
  });

  it('removes only the block(s) with hard findings, keeping the rest intact and parseable-shaped', () => {
    const source = `${HEADER}test('good', async ({ page }) => {\n  await expect(page).toHaveTitle(/Home/);\n});\n\ntest('bad', async ({ page }) => {\n  await page.click('button');\n});\n`;
    const findings = auditSpecQuality(source);
    const pruned = pruneHardFindings(source, findings);
    expect(pruned).not.toBeNull();
    expect(pruned).toContain(`test('good'`);
    expect(pruned).not.toContain(`test('bad'`);
    // Re-auditing the pruned result should find nothing left to flag.
    expect(auditSpecQuality(pruned as string)).toEqual([]);
  });

  it('removing every block leaves a file with no test(...) calls (caller decides that is not worth shipping)', () => {
    const source = `${HEADER}test('bad', async ({ page }) => {\n  await page.click('button');\n});\n`;
    const findings = auditSpecQuality(source);
    const pruned = pruneHardFindings(source, findings);
    expect(pruned).not.toBeNull();
    expect(/\btest\s*\(/.test(pruned as string)).toBe(false);
  });

  it('actually prunes a weak-positive-navigation-assertion block end to end, not just flags it', () => {
    const source = `${HEADER}test('succeeds with valid input', async ({ page }) => {\n  await page.locator('button[data-testid="login-submit"]').click();\n  await expect(page).not.toHaveURL(/\\/login$/);\n});\n\ntest('renders the login form', async ({ page }) => {\n  await expect(page.getByLabel('Email')).toBeVisible();\n});\n`;
    const findings = auditSpecQuality(source);
    const pruned = pruneHardFindings(source, findings);
    expect(pruned).not.toBeNull();
    expect(pruned).not.toContain('succeeds with valid input');
    expect(pruned).toContain('renders the login form');
  });
});

function block_(title: string, body: string): string {
  return `${HEADER}test('${title}', async ({ page }) => {\n${body}\n});\n`;
}
