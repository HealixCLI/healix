/**
 * Unit tests for the pre-execution spec validation gate:
 *   - attemptBracketRepair: a bounded tokenizer-based repair for unclosed
 *     brackets/strings/template literals/block comments — must not touch
 *     already-balanced source, and must never "fix" a mismatched bracket.
 *   - validateSuite: a clean spec passes through untouched; a repairable
 *     syntax defect gets fixed and accepted; an unfixable one is quarantined
 *     (moved out of its tier dir, excluded from the result) rather than
 *     silently shipped; cancellation degrades to "ship unvalidated", never
 *     mass-quarantine.
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from 'node:child_process';
import type { GeneratedSpec, TestModeContext } from '../types.js';
import { attemptBracketRepair, validateSuite } from './validate.js';

describe('attemptBracketRepair', () => {
  it('returns null for already-balanced source (nothing to repair)', () => {
    const source = `import { test, expect } from '@playwright/test';\ntest('x', async ({ page }) => { await expect(page).toHaveTitle('Home'); });\n`;
    expect(attemptBracketRepair(source)).toBeNull();
  });

  it('closes a missing closing brace/paren at EOF', () => {
    const broken = `test('x', async ({ page }) => {\n  await expect(page).toHaveTitle('Home');\n`;
    const fixed = attemptBracketRepair(broken);
    expect(fixed).not.toBeNull();
    expect(fixed).toBe(`${broken}})`);
  });

  it('closes an unterminated single-quoted string, then the brackets still open at that point', () => {
    // Everything from the unterminated quote onward (including the `});` that
    // was clearly MEANT to close the block) is swallowed as string content —
    // a real tokenizer has no way to know otherwise. The repair closes the
    // string first, then whatever brackets are still genuinely open.
    const broken = `test('x', async () => {\n  const s = 'unterminated\n});`;
    const fixed = attemptBracketRepair(broken);
    expect(fixed).toBe(`${broken}'})`);
  });

  it('closes an unterminated template literal', () => {
    const broken = 'const msg = `hello ${name}';
    const fixed = attemptBracketRepair(broken);
    expect(fixed).toBe('const msg = `hello ${name}`');
  });

  it('closes an unterminated block comment', () => {
    const broken = '/* leftover comment\nconst x = 1;';
    const fixed = attemptBracketRepair(broken);
    expect(fixed).toBe(`${broken}*/`);
  });

  it('ignores brackets/quotes that appear inside comments and strings', () => {
    // The unmatched "(" and unterminated-looking quote here are both inside a
    // line comment — the tokenizer must not "repair" text that was never live code.
    const source = "test('x', async () => {\n  // note: an unmatched ( and an unterminated '\n  return;\n});";
    expect(attemptBracketRepair(source)).toBeNull();
  });

  it('does not attempt to fix a mismatched (as opposed to missing) bracket', () => {
    // "(" closed by "]" is a MISMATCH, not a missing closer — repair must not
    // silently rewrite it into something that merely parses.
    const source = 'foo(1, 2]';
    // The opener "(" is still open (its matching ")" was never seen), so the
    // repair appends ")" — it does not touch or remove the stray "]".
    expect(attemptBracketRepair(source)).toBe('foo(1, 2])');
  });
});

// ---- validateSuite() ---------------------------------------------------------

function makeFakeChild(
  code: number | null,
  stdout = '',
  stderr = '',
): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => boolean;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

/** Queue exit codes for successive `npx playwright test --list <file>` calls, by call order. */
function queueSpawnResults(results: Array<{ code: number | null; stderr?: string }>): void {
  const spawnMock = vi.mocked(spawn);
  spawnMock.mockReset();
  for (const r of results) {
    spawnMock.mockImplementationOnce(
      () => makeFakeChild(r.code, '', r.stderr ?? '') as unknown as ReturnType<typeof spawn>,
    );
  }
}

const CLEAN_SPEC_SOURCE = `import { test, expect } from '@playwright/test';\n\ntest('[REQ:REQ-1] works', async ({ page }) => {\n  await page.goto('/');\n  await expect(page).toHaveTitle(/Home/);\n});\n`;

describe('validateSuite', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'healix-validate-'));
    // Simulate deps already installed by default, so existing parse-check
    // expectations (call counts/order) aren't disturbed by ensureSuiteDeps.
    // Tests that care about the install path itself override this below.
    await mkdir(join(projectDir, 'node_modules', '@playwright'), { recursive: true });
  });

  afterEach(async () => {
    vi.mocked(spawn).mockReset();
  });

  function makeCtx(overrides: Partial<TestModeContext> = {}): TestModeContext {
    return {
      projectDir,
      provider: {} as TestModeContext['provider'],
      target: {} as TestModeContext['target'],
      browser: {} as TestModeContext['browser'],
      ...overrides,
    };
  }

  async function writeSpec(relPath: string, contents: string): Promise<GeneratedSpec> {
    const absPath = join(projectDir, relPath);
    await mkdir(join(projectDir, 'tests', 'tierA-public'), { recursive: true });
    await writeFile(absPath, contents, 'utf-8');
    return { path: absPath, title: '[REQ:REQ-1] works', reqTag: 'REQ-1', tier: 'tierA-public', contents };
  }

  it('accepts a clean spec untouched (single --list call, exit 0)', async () => {
    const spec = await writeSpec('tests/tierA-public/works.spec.ts', CLEAN_SPEC_SOURCE);
    queueSpawnResults([{ code: 0 }]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.ok).toEqual([spec]);
    expect(result.repaired).toEqual([]);
    expect(result.quarantined).toEqual([]);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('repairs a syntactically broken spec and accepts it once the repair re-passes', async () => {
    const broken = CLEAN_SPEC_SOURCE.replace(/\}\);\s*$/, ''); // drop the final "});" close
    const spec = await writeSpec('tests/tierA-public/broken.spec.ts', broken);
    // First --list fails (broken), second (after repair) succeeds.
    queueSpawnResults([{ code: 1, stderr: 'SyntaxError: Unexpected end of input' }, { code: 0 }]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.ok).toEqual([]);
    expect(result.quarantined).toEqual([]);
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0].contents).not.toBe(broken);
    // The repaired content was actually written to disk (execute() reads from disk).
    expect(await readFile(spec.path, 'utf-8')).toBe(result.repaired[0].contents);
  });

  it('quarantines a spec that still fails after the repair attempt, restoring original content on disk', async () => {
    // Not repairable by bracket-balancing: valid brackets throughout, but content
    // that will never satisfy the fake `--list` gate (always fails below).
    const spec = await writeSpec('tests/tierA-public/unfixable.spec.ts', CLEAN_SPEC_SOURCE);
    // First call fails, and since attemptBracketRepair(CLEAN_SPEC_SOURCE) returns
    // null (nothing unbalanced to fix), no second call is ever made.
    queueSpawnResults([{ code: 1, stderr: 'SyntaxError: something else entirely' }]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.ok).toEqual([]);
    expect(result.repaired).toEqual([]);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0].spec.path).toBe(spec.path);
    expect(result.quarantined[0].reason).toContain('SyntaxError');

    // Moved out of its tier dir — Playwright's testDir glob will never see it.
    await expect(readFile(spec.path, 'utf-8')).rejects.toThrow();
    const quarantinedContents = await readFile(
      join(projectDir, 'tests', '_quarantine', 'unfixable.spec.ts'),
      'utf-8',
    );
    expect(quarantinedContents).toBe(CLEAN_SPEC_SOURCE);
  });

  it('restores the original content on disk when a repair attempt does not actually fix the parse error', async () => {
    const broken = `${CLEAN_SPEC_SOURCE.slice(0, -2)}`;
    const spec = await writeSpec('tests/tierA-public/still-broken.spec.ts', broken);
    // Both the original AND the repaired attempt fail --list.
    queueSpawnResults([
      { code: 1, stderr: 'SyntaxError: first' },
      { code: 1, stderr: 'SyntaxError: still broken after repair' },
    ]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.repaired).toEqual([]);
    expect(result.quarantined).toHaveLength(1);
    const quarantinedContents = await readFile(
      join(projectDir, 'tests', '_quarantine', 'still-broken.spec.ts'),
      'utf-8',
    );
    // Quarantined file reflects the ORIGINAL model output, not the failed repair attempt.
    expect(quarantinedContents).toBe(broken);
  });

  it('returns every spec as ok, unvalidated, when the signal is already aborted (fail-open, matches execute())', async () => {
    const spec = await writeSpec('tests/tierA-public/works.spec.ts', CLEAN_SPEC_SOURCE);
    const controller = new AbortController();
    controller.abort();

    const result = await validateSuite(makeCtx({ signal: controller.signal }), [spec]);

    expect(result.ok).toEqual([spec]);
    expect(result.quarantined).toEqual([]);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('degrades to shipping the remainder unvalidated (not quarantined) when cancelled mid-loop', async () => {
    const specA = await writeSpec('tests/tierA-public/a.spec.ts', CLEAN_SPEC_SOURCE);
    const specB = await writeSpec('tests/tierA-public/b.spec.ts', CLEAN_SPEC_SOURCE);
    const controller = new AbortController();

    // Abort right after the first spec's --list call settles, before the loop
    // reaches the second spec.
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockReset();
    spawnMock.mockImplementationOnce(() => {
      const child = makeFakeChild(0);
      queueMicrotask(() => controller.abort());
      return child as unknown as ReturnType<typeof spawn>;
    });

    const result = await validateSuite(makeCtx({ signal: controller.signal }), [specA, specB]);

    expect(result.ok.map((s) => s.path).sort()).toEqual([specA.path, specB.path].sort());
    expect(result.quarantined).toEqual([]);
    // Only one spawn call for specA — specB was never probed once cancelled.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('installs suite deps before the first parse-check when node_modules is missing (regression: was previously quarantining every spec as "fails to parse")', async () => {
    await rm(join(projectDir, 'node_modules'), { recursive: true, force: true });
    const spec = await writeSpec('tests/tierA-public/works.spec.ts', CLEAN_SPEC_SOURCE);
    // First spawn: `npm install` (ensureSuiteDeps). Second spawn: `playwright test --list`.
    queueSpawnResults([{ code: 0 }, { code: 0 }]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.ok).toEqual([spec]);
    expect(result.quarantined).toEqual([]);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe('npm');
    expect(vi.mocked(spawn).mock.calls[1][0]).toBe('npx');
  });

  it('ships remaining specs unvalidated (not quarantined) when the parse-check failure indicates missing deps rather than a syntax defect', async () => {
    const specA = await writeSpec('tests/tierA-public/a.spec.ts', CLEAN_SPEC_SOURCE);
    const specB = await writeSpec('tests/tierA-public/b.spec.ts', CLEAN_SPEC_SOURCE);
    // node_modules/@playwright exists (from beforeEach), so ensureSuiteDeps
    // no-ops, but the parse-check itself still reports a missing-module error
    // (e.g. a corrupted/partial install) — this must not be treated as a
    // per-spec syntax defect and mass-quarantined.
    queueSpawnResults([{ code: 1, stderr: "Cannot find package '@playwright/test'" }]);

    const result = await validateSuite(makeCtx(), [specA, specB]);

    expect(result.ok.map((s) => s.path).sort()).toEqual([specA.path, specB.path].sort());
    expect(result.quarantined).toEqual([]);
    expect(result.repaired).toEqual([]);
    // Only one probe was made before recognizing the missing-deps signal and bailing out.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  // ---- Phase A/B: static quality audit + block-level pruning -----------------

  const SOURCE_WITH_ONE_BAD_BLOCK = `import { test, expect } from '@playwright/test';\n\ntest('[REQ:REQ-1] good', async ({ page }) => {\n  await page.goto('/');\n  await expect(page).toHaveTitle(/Home/);\n});\n\ntest('[REQ:REQ-1] bad', async ({ page }) => {\n  await page.click('button');\n});\n`;

  it('ships a spec untouched when the quality audit finds nothing (no extra --list call)', async () => {
    const spec = await writeSpec('tests/tierA-public/clean.spec.ts', CLEAN_SPEC_SOURCE);
    queueSpawnResults([{ code: 0 }]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.ok).toEqual([spec]);
    expect(result.repaired).toEqual([]);
    expect(result.quarantined).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('prunes only the block(s) with a hard quality finding and ships the rest as repaired', async () => {
    const spec = await writeSpec('tests/tierA-public/mixed.spec.ts', SOURCE_WITH_ONE_BAD_BLOCK);
    // First --list call: the original parses fine. Second --list call: the
    // pruned (post-audit) file re-parses fine too.
    queueSpawnResults([{ code: 0 }, { code: 0 }]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.ok).toEqual([]);
    expect(result.quarantined).toEqual([]);
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0].contents).toContain("'[REQ:REQ-1] good'");
    expect(result.repaired[0].contents).not.toContain("'[REQ:REQ-1] bad'");
    // The pruned content was actually written to disk.
    expect(await readFile(spec.path, 'utf-8')).toBe(result.repaired[0].contents);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('quarantines the whole spec (not just a block) when pruning would leave nothing runnable', async () => {
    const allBadSource = `import { test, expect } from '@playwright/test';\n\ntest('[REQ:REQ-1] bad', async ({ page }) => {\n  await page.click('button');\n});\n`;
    const spec = await writeSpec('tests/tierA-public/all-bad.spec.ts', allBadSource);
    queueSpawnResults([{ code: 0 }]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.ok).toEqual([]);
    expect(result.repaired).toEqual([]);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0].category).toBe('quality');
    expect(result.quarantined[0].reason).toContain('Quality audit');
    // Original content preserved in quarantine (not silently mutated).
    const quarantinedContents = await readFile(
      join(projectDir, 'tests', '_quarantine', 'all-bad.spec.ts'),
      'utf-8',
    );
    expect(quarantinedContents).toBe(allBadSource);
    // Only the original --list call — pruning to zero tests is never re-probed.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('rolls back pruning and quarantines the ORIGINAL content when the pruned file fails to re-parse', async () => {
    const spec = await writeSpec('tests/tierA-public/mixed2.spec.ts', SOURCE_WITH_ONE_BAD_BLOCK);
    // Original parses fine; the pruned version (second --list call) fails for
    // some unrelated reason — pruning must not be trusted blindly.
    queueSpawnResults([{ code: 0 }, { code: 1, stderr: 'SyntaxError: unexpected after prune' }]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.ok).toEqual([]);
    expect(result.repaired).toEqual([]);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0].category).toBe('quality');
    // Disk reflects the quarantine move of the ORIGINAL (pre-prune) content.
    const quarantinedContents = await readFile(
      join(projectDir, 'tests', '_quarantine', 'mixed2.spec.ts'),
      'utf-8',
    );
    expect(quarantinedContents).toBe(SOURCE_WITH_ONE_BAD_BLOCK);
  });

  it('ships a spec with soft findings as ok, surfaced via result.warnings, without blocking it', async () => {
    const source = `import { test, expect } from '@playwright/test';\n\ntest('[REQ:REQ-1] nav', async ({ page }) => {\n  await expect(page).toHaveURL('http://localhost:4202/home');\n});\n`;
    const spec = await writeSpec('tests/tierA-public/soft.spec.ts', source);
    queueSpawnResults([{ code: 0 }]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.ok).toEqual([spec]);
    expect(result.quarantined).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].findings[0].code).toBe('absolute-url-assertion');
  });

  // ---- Phase C: codegen-defect classification for source-grounded specs -----

  it('classifies an unrepairable parse failure on a [SRC:...]-cited spec as a codegen-defect', async () => {
    // Brackets are already balanced (attemptBracketRepair returns null, nothing to fix),
    // so this goes straight to quarantine on the first parse failure.
    const balancedButBadSource = `import { test, expect } from '@playwright/test';\n// [SRC:src/routes/login.ts]\ntest('[REQ:REQ-1] works', async ({ page }) => {\n  await expect(page).toHaveTitle(/Home/);\n});\n`;
    const spec = await writeSpec('tests/tierA-public/src-cited.spec.ts', balancedButBadSource);
    queueSpawnResults([{ code: 1, stderr: 'SyntaxError: something structurally wrong' }]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0].category).toBe('codegen-defect');
  });

  it('classifies an unrepairable parse failure on a spec without [SRC:...] as an ordinary parse failure', async () => {
    const spec = await writeSpec('tests/tierA-public/no-src.spec.ts', CLEAN_SPEC_SOURCE);
    queueSpawnResults([{ code: 1, stderr: 'SyntaxError: something structurally wrong' }]);

    const result = await validateSuite(makeCtx(), [spec]);

    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0].category).toBe('parse');
  });
});
