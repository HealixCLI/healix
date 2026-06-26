import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { indexRepo } from './repo-index.js';

/** Temp dirs created during the suite, removed in afterEach. */
const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-repo-index-'));
  tempDirs.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('indexRepo', () => {
  it('skips node_modules and .git, returns relative paths, and emits a non-empty summary', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ name: 'app', dependencies: { vite: '^5.0.0' } }));
    write(dir, 'src/index.ts', 'export const a = 1;\n');
    write(dir, 'src/util.ts', 'export const b = 2;\n');
    write(dir, 'README.md', '# hello\n');
    // Must be skipped:
    write(dir, 'node_modules/left-pad/index.js', 'module.exports = () => {};\n');
    write(dir, 'node_modules/.bin/foo', '#!/bin/sh\n');
    write(dir, '.git/config', '[core]\n');
    write(dir, '.git/HEAD', 'ref: refs/heads/main\n');

    const index = await indexRepo(dir);

    // node_modules / .git contents never appear.
    expect(index.files.some((f) => f.startsWith('node_modules'))).toBe(false);
    expect(index.files.some((f) => f.includes('node_modules/'))).toBe(false);
    expect(index.files.some((f) => f.startsWith('.git'))).toBe(false);

    // Source files are present, expressed as relative POSIX paths.
    expect(index.files).toContain('package.json');
    expect(index.files).toContain('src/index.ts');
    expect(index.files).toContain('src/util.ts');

    // All paths are relative (never absolute / never escaping the root).
    for (const f of index.files) {
      expect(path.isAbsolute(f)).toBe(false);
      expect(f.startsWith('..')).toBe(false);
    }

    // root is the resolved absolute path; summary is non-empty.
    expect(index.root).toBe(path.resolve(dir));
    expect(index.summary.length).toBeGreaterThan(0);
    expect(index.summary).toContain('files indexed');
  });

  it('respects the maxFiles cap', async () => {
    const dir = makeRepo();
    for (let i = 0; i < 25; i++) {
      write(dir, `src/file-${String(i).padStart(3, '0')}.ts`, `export const x${i} = ${i};\n`);
    }

    const index = await indexRepo(dir, { maxFiles: 5 });

    expect(index.files.length).toBe(5);
    expect(index.summary).toContain('capped at 5');
  });

  it('returns all files when under the maxFiles cap (no truncation marker)', async () => {
    const dir = makeRepo();
    write(dir, 'a.ts', 'export const a = 1;\n');
    write(dir, 'b.ts', 'export const b = 2;\n');

    const index = await indexRepo(dir, { maxFiles: 400 });

    expect(index.files.length).toBe(2);
    expect(index.summary).not.toContain('capped at');
  });
});
