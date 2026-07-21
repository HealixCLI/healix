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

  it('audits each block independently across a multi-test file', () => {
    const source = `${HEADER}test('good', async ({ page }) => {\n  await expect(page).toHaveTitle(/Home/);\n});\n\ntest('bad', async ({ page }) => {\n  await page.click('button');\n});\n`;
    const findings = auditSpecQuality(source);
    expect(findings).toHaveLength(1);
    expect(findings[0].testTitle).toBe('bad');
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
