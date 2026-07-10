import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportSuite } from './index.js';

/**
 * Safety-focused export tests: captured auth state, runner reports, OS
 * metadata, and outward symlinks must never leak into a shareable bundle.
 */
describe('exportSuite safety', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'healix-export-safety-'));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  /** Scaffold a minimal suite with a couple of ordinary files. */
  async function makeSuite(name = 'suite'): Promise<string> {
    const suiteDir = path.join(workDir, name);
    await fs.mkdir(path.join(suiteDir, 'tests'), { recursive: true });
    await fs.writeFile(path.join(suiteDir, 'playwright.config.ts'), 'export default {};\n', 'utf8');
    await fs.writeFile(path.join(suiteDir, 'tests', 'login.spec.ts'), 'export const spec = 1;\n', 'utf8');
    return suiteDir;
  }

  it('excludes .auth dirs, root results.json / .last-run.json, and .DS_Store', async () => {
    const suiteDir = await makeSuite();

    // Live storageState with real cookies, written by the auth fixture.
    await fs.mkdir(path.join(suiteDir, 'fixtures', '.auth'), { recursive: true });
    await fs.writeFile(
      path.join(suiteDir, 'fixtures', '.auth', 'user.json'),
      JSON.stringify({ cookies: [{ name: 'session', value: 'live-session-cookie' }] }),
      'utf8',
    );
    // Playwright JSON report + run bookkeeping at the suite root.
    await fs.writeFile(path.join(suiteDir, 'results.json'), '{"suites":[]}', 'utf8');
    await fs.writeFile(path.join(suiteDir, '.last-run.json'), '{"status":"passed"}', 'utf8');
    // macOS Finder metadata at two depths.
    await fs.writeFile(path.join(suiteDir, '.DS_Store'), 'junk', 'utf8');
    await fs.writeFile(path.join(suiteDir, 'tests', '.DS_Store'), 'junk', 'utf8');
    // A NESTED results.json is user data and must survive (rule is root-only).
    await fs.mkdir(path.join(suiteDir, 'data'), { recursive: true });
    await fs.writeFile(path.join(suiteDir, 'data', 'results.json'), '{"benign":true}', 'utf8');

    const outDir = path.join(workDir, 'bundle');
    const bundle = await exportSuite({ suiteDir, outDir, zip: false });

    // None of the sensitive files appear in the manifest...
    expect(bundle.files).not.toContain('fixtures/.auth/user.json');
    expect(bundle.files.some((f) => f.split('/').includes('.auth'))).toBe(false);
    expect(bundle.files).not.toContain('results.json');
    expect(bundle.files).not.toContain('.last-run.json');
    expect(bundle.files.some((f) => f.endsWith('.DS_Store'))).toBe(false);

    // ...nor on disk in outDir.
    await expect(fs.stat(path.join(outDir, 'fixtures', '.auth'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(outDir, 'results.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(outDir, '.last-run.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Ordinary suite content still ships, including the nested results.json.
    expect(bundle.files).toContain('tests/login.spec.ts');
    expect(bundle.files).toContain('playwright.config.ts');
    expect(bundle.files).toContain('data/results.json');
    expect(bundle.skipped).toEqual([]);
  });

  it('skips symlinks escaping the suite root and reports them in `skipped`', async (ctx) => {
    const suiteDir = await makeSuite();

    // A secret OUTSIDE the suite, reachable only via a symlink inside it.
    const outsideDir = path.join(workDir, 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    const secretPath = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(secretPath, 'TOP-SECRET-EXTERNAL-CONTENT', 'utf8');

    try {
      await fs.symlink(secretPath, path.join(suiteDir, 'leak.txt'));
      await fs.symlink(outsideDir, path.join(suiteDir, 'leak-dir'));
    } catch {
      // Symlink creation unsupported on this platform (e.g. Windows without
      // the required privilege) — nothing meaningful to assert.
      ctx.skip();
      return;
    }

    const outDir = path.join(workDir, 'bundle');
    const bundle = await exportSuite({ suiteDir, outDir, zip: false });

    // Both outward links are skipped and reported.
    expect(bundle.skipped).toContain('leak.txt');
    expect(bundle.skipped).toContain('leak-dir');
    expect(bundle.files).not.toContain('leak.txt');
    expect(bundle.files.some((f) => f.startsWith('leak-dir'))).toBe(false);
    await expect(fs.stat(path.join(outDir, 'leak.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // The external content is not present anywhere in the bundle.
    for (const rel of bundle.files) {
      const content = await fs.readFile(path.join(outDir, rel), 'utf8').catch(() => '');
      expect(content).not.toContain('TOP-SECRET-EXTERNAL-CONTENT');
    }
  });

  it('still copies symlinks whose target stays inside the suite', async (ctx) => {
    const suiteDir = await makeSuite();
    await fs.writeFile(path.join(suiteDir, 'helper.ts'), 'export const inside = 42;\n', 'utf8');

    try {
      // Relative link, target inside the suite root.
      await fs.symlink('helper.ts', path.join(suiteDir, 'alias.ts'));
    } catch {
      ctx.skip();
      return;
    }

    const outDir = path.join(workDir, 'bundle');
    const bundle = await exportSuite({ suiteDir, outDir, zip: false });

    expect(bundle.files).toContain('alias.ts');
    expect(bundle.skipped).toEqual([]);
    const copied = await fs.readFile(path.join(outDir, 'alias.ts'), 'utf8');
    expect(copied).toContain('inside = 42');
  });
});
