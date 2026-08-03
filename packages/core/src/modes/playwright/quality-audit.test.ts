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
});

function block_(title: string, body: string): string {
  return `${HEADER}test('${title}', async ({ page }) => {\n${body}\n});\n`;
}
