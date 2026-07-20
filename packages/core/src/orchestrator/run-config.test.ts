import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunConfigSnapshot, writeRunConfigSnapshot, type RunConfigSnapshot } from './run-config.js';

const tempDirs: string[] = [];

function makeRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-run-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE: RunConfigSnapshot = {
  testingScope: 'both',
  suiteMode: 'fresh',
  provider: 'claude',
  prd: 'Users must be able to reset their password.',
  instructions: 'Focus on accessibility; prefer data-testid selectors.',
};

describe('run-config read/write', () => {
  it('round-trips a snapshot to and from disk', async () => {
    const dir = makeRunDir();
    await writeRunConfigSnapshot(dir, SAMPLE);
    const read = await readRunConfigSnapshot(dir);
    expect(read).toEqual(SAMPLE);
  });

  it('returns null when no snapshot exists (predates this feature, or write failed)', async () => {
    const dir = makeRunDir();
    expect(await readRunConfigSnapshot(dir)).toBeNull();
  });

  it('round-trips every field being omitted (a minimal/default run)', async () => {
    const dir = makeRunDir();
    await writeRunConfigSnapshot(dir, {});
    expect(await readRunConfigSnapshot(dir)).toEqual({});
  });

  it('never throws when the directory is unwritable/missing', async () => {
    await expect(writeRunConfigSnapshot('/nonexistent/deeply/nested/path', SAMPLE)).resolves.toBeUndefined();
  });

  it('survives being overwritten (e.g. rewritten identically on resume)', async () => {
    const dir = makeRunDir();
    await writeRunConfigSnapshot(dir, SAMPLE);
    await writeRunConfigSnapshot(dir, SAMPLE);
    expect(await readRunConfigSnapshot(dir)).toEqual(SAMPLE);
  });
});
