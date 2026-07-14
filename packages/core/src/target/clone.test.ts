import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../exec/run-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec/run-cli.js')>();
  return { ...actual, runCli: vi.fn() };
});
// mkdir is a no-op for these tests — they never touch the real filesystem.
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined) }));

import { runCli } from '../exec/run-cli.js';
import { cloneRepo, isGitRemoteUrl } from './clone.js';

const runCliMock = vi.mocked(runCli);

describe('isGitRemoteUrl', () => {
  it('accepts http(s), ssh, git-protocol, and scp-like git URLs', () => {
    expect(isGitRemoteUrl('https://github.com/acme/web-app')).toBe(true);
    expect(isGitRemoteUrl('https://github.com/acme/web-app.git')).toBe(true);
    expect(isGitRemoteUrl('http://internal.git/acme/web-app')).toBe(true);
    expect(isGitRemoteUrl('git@github.com:acme/web-app.git')).toBe(true);
    expect(isGitRemoteUrl('ssh://git@github.com/acme/web-app.git')).toBe(true);
    expect(isGitRemoteUrl('git://github.com/acme/web-app.git')).toBe(true);
    expect(isGitRemoteUrl('  https://github.com/acme/web-app  ')).toBe(true); // trims
  });

  it('rejects local filesystem paths', () => {
    expect(isGitRemoteUrl('/Users/me/code/acme')).toBe(false);
    expect(isGitRemoteUrl('C:\\code\\acme')).toBe(false);
    expect(isGitRemoteUrl('./relative/acme')).toBe(false);
    expect(isGitRemoteUrl('')).toBe(false);
  });
});

describe('cloneRepo', () => {
  beforeEach(() => {
    runCliMock.mockClear();
  });

  it('shallow-clones into a fresh slugged directory under destRoot', async () => {
    runCliMock.mockResolvedValueOnce({
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      durationMs: 10,
    });

    const destRoot = join('tmp-test-root', 'repos');
    const result = await cloneRepo('https://github.com/acme/web-app.git', destRoot);

    expect(runCliMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = runCliMock.mock.calls[0]!;
    expect(cmd).toBe('git');
    expect(args[0]).toBe('clone');
    expect(args).toContain('--');
    expect(args[args.length - 2]).toBe('https://github.com/acme/web-app.git');
    expect(opts?.timeoutMs).toBeGreaterThan(0);

    expect(result.path.startsWith(destRoot)).toBe(true);
    expect(result.path).toMatch(/web-app-[A-Za-z0-9_-]{8}$/);
  });

  it('throws a descriptive error when git clone fails', async () => {
    runCliMock.mockResolvedValueOnce({
      code: 128,
      stdout: '',
      stderr: 'fatal: repository not found',
      timedOut: false,
      aborted: false,
      durationMs: 10,
    });

    await expect(cloneRepo('https://github.com/acme/missing.git', '/data/repos')).rejects.toThrow(
      /repository not found/,
    );
  });
});
