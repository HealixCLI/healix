import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zipDirectory } from './zip.js';

describe('zipDirectory', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'healix-zip-'));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('creates a non-empty .zip from a directory with files', async () => {
    const sourceDir = path.join(workDir, 'suite');
    await fs.mkdir(path.join(sourceDir, 'tests'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'README.md'), '# hello\n', 'utf8');
    await fs.writeFile(path.join(sourceDir, 'tests', 'login.spec.ts'), 'export const x = 1;\n', 'utf8');

    const zipPath = path.join(workDir, 'suite.zip');
    const result = await zipDirectory(sourceDir, zipPath);

    // Resolves with the absolute archive path and a positive byte count.
    expect(result.zipPath).toBe(path.resolve(zipPath));
    expect(result.bytes).toBeGreaterThan(0);

    // The archive exists on disk and is non-empty.
    const stat = await fs.stat(zipPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);

    // Sanity: a zip's local file header begins with the "PK\x03\x04" magic.
    const fd = await fs.open(zipPath, 'r');
    try {
      const buf = Buffer.alloc(4);
      await fd.read(buf, 0, 4, 0);
      expect(buf[0]).toBe(0x50); // 'P'
      expect(buf[1]).toBe(0x4b); // 'K'
    } finally {
      await fd.close();
    }
  });

  it('produces byte-identical archives for identical content (reproducible)', async () => {
    // Two separate trees with identical content but different mtimes; both
    // are named `suite` so the archive-root folder name matches too.
    const make = async (parent: string): Promise<string> => {
      const dir = path.join(workDir, parent, 'suite');
      await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
      await fs.writeFile(path.join(dir, 'README.md'), '# same content\n', 'utf8');
      await fs.writeFile(path.join(dir, 'tests', 'a.spec.ts'), 'export const a = 1;\n', 'utf8');
      return dir;
    };
    const dirA = await make('a');
    const dirB = await make('b');

    // Force clearly different on-disk mtimes for tree B.
    const past = new Date('2020-05-05T05:05:05Z');
    for (const rel of ['README.md', path.join('tests', 'a.spec.ts')]) {
      await fs.utimes(path.join(dirB, rel), past, past);
    }

    const zipA = await zipDirectory(dirA, path.join(workDir, 'a.zip'));
    const zipB = await zipDirectory(dirB, path.join(workDir, 'b.zip'));

    const [bufA, bufB] = await Promise.all([fs.readFile(zipA.zipPath), fs.readFile(zipB.zipPath)]);
    expect(bufA.length).toBeGreaterThan(0);
    expect(bufA.equals(bufB)).toBe(true);
  });

  it('rejects when the source directory does not exist (no silent empty zip)', async () => {
    const missing = path.join(workDir, 'does-not-exist');
    const zipPath = path.join(workDir, 'out.zip');

    await expect(zipDirectory(missing, zipPath)).rejects.toThrow(/not a directory/i);

    // A failed archive must not leave a stray output file behind.
    await expect(fs.stat(zipPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects when the source path is a file, not a directory', async () => {
    const filePath = path.join(workDir, 'plain.txt');
    await fs.writeFile(filePath, 'not a dir', 'utf8');
    const zipPath = path.join(workDir, 'file.zip');

    await expect(zipDirectory(filePath, zipPath)).rejects.toThrow(/not a directory/i);
  });
});
