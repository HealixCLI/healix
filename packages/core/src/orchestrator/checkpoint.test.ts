import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyTransientFailure,
  readCheckpoint,
  writeCheckpoint,
  type ResumeCheckpoint,
} from './checkpoint.js';

const tempDirs: string[] = [];

function makeRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-checkpoint-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE: ResumeCheckpoint = {
  runId: 'run_1',
  projectId: 'prj_1',
  phase: 'generate',
  runOptions: { testingScope: 'both', suiteMode: 'fresh' },
  plan: { summary: 'plan', items: [] },
  generatedItemIds: ['pli_1'],
  generatedSpecs: [{ path: 'tests/tierA-public/foo.spec.ts', title: 'Foo', tier: 'tierA-public' }],
  completedTiers: [],
  updatedAt: new Date(2024, 0, 1).toISOString(),
};

describe('checkpoint read/write', () => {
  it('round-trips a checkpoint to and from disk', async () => {
    const dir = makeRunDir();
    await writeCheckpoint(dir, SAMPLE);
    const read = await readCheckpoint(dir);
    expect(read).toEqual(SAMPLE);
  });

  it('returns null when no checkpoint exists', async () => {
    const dir = makeRunDir();
    expect(await readCheckpoint(dir)).toBeNull();
  });

  it('never throws when the directory is unwritable/missing', async () => {
    await expect(writeCheckpoint('/nonexistent/deeply/nested/path', SAMPLE)).resolves.toBeUndefined();
  });
});

describe('classifyTransientFailure', () => {
  it('classifies connection/DNS/timeout errors as network', () => {
    expect(classifyTransientFailure('connect ECONNREFUSED 127.0.0.1:443')).toBe('network');
    expect(classifyTransientFailure('getaddrinfo ENOTFOUND api.anthropic.com')).toBe('network');
    expect(
      classifyTransientFailure('request to https://api.anthropic.com failed, reason: fetch failed'),
    ).toBe('network');
    expect(classifyTransientFailure('socket hang up')).toBe('network');
  });

  it('classifies rate-limit/quota/credit errors as credits-exhausted', () => {
    expect(classifyTransientFailure('Error: rate limit exceeded, please try again later')).toBe(
      'credits-exhausted',
    );
    expect(classifyTransientFailure('429 Too Many Requests')).toBe('credits-exhausted');
    expect(classifyTransientFailure('Your account has insufficient credits to complete this request')).toBe(
      'credits-exhausted',
    );
  });

  it('returns null for a genuine bug/config error (must still hard-fail)', () => {
    expect(classifyTransientFailure('TypeError: Cannot read properties of undefined')).toBeNull();
    expect(classifyTransientFailure('Project not found: prj_bogus')).toBeNull();
    expect(classifyTransientFailure('')).toBeNull();
  });
});
