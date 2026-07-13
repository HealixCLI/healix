/**
 * Unit tests for runCli / extractSemver — hermetic: the only processes spawned
 * are `node -e` one-liners (via process.execPath, guaranteed present in the
 * test environment); no real AI CLI is ever invoked and nothing touches the
 * network.
 */
import { describe, expect, it } from 'vitest';
import { extractSemver, runCli } from './run-cli.js';

describe('runCli abort (AbortSignal)', () => {
  it('kills a long-running child and resolves quickly with aborted:true', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const start = Date.now();
    // Child would run for 10s on its own — the abort must cut it short.
    const r = await runCli(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
      timeoutMs: 30_000,
      signal: ctrl.signal,
    });
    expect(r.aborted).toBe(true);
    expect(r.code).toBeNull();
    expect(r.stderr.endsWith('[aborted]')).toBe(true);
    // Abort is not a timeout — the two kill reasons must stay distinguishable.
    expect(r.timedOut).toBe(false);
    // Resolved on the abort path, not by waiting out the child's 10s sleep.
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('resolves immediately without spawning when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    const r = await runCli(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
      signal: ctrl.signal,
    });
    expect(r.aborted).toBe(true);
    expect(r.code).toBeNull();
    expect(r.stderr.endsWith('[aborted]')).toBe(true);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('a run that completes normally reports aborted:false', async () => {
    const ctrl = new AbortController();
    // Avoids "..." and spaces: on Windows, shell:true concatenates cmd+args
    // with NO escaping (Node's DEP0190-flagged behavior), so cmd.exe eats
    // unquoted double-quotes and re-splits on whitespace before this even
    // reaches node — writing "hi" via char codes sidesteps both.
    const r = await runCli(process.execPath, ['-e', 'process.stdout.write(String.fromCharCode(104,105))'], {
      signal: ctrl.signal,
      timeoutMs: 15_000,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi');
    expect(r.aborted).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.stderr).not.toContain('[aborted]');
  });
});

describe('runCli cwd validation', () => {
  it('resolves with a clear error instead of spawning when cwd does not exist', async () => {
    const r = await runCli(process.execPath, ['-e', 'process.stdout.write("should not run")'], {
      cwd: 'C:\\this\\path\\does\\not\\exist\\healix-test',
      timeoutMs: 15_000,
    });
    expect(r.code).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.aborted).toBe(false);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('working directory does not exist');
  });

  it('spawns normally when cwd exists', async () => {
    const r = await runCli(process.execPath, ['-e', 'process.stdout.write(String.fromCharCode(104,105))'], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi');
  });
});

describe('runCli stdin handling', () => {
  it('does not crash on EPIPE when the child exits before reading stdin', async () => {
    // A child that exits instantly closes its stdin pipe while we are still
    // writing a large input — without the stdin 'error' swallow this raises an
    // unhandled EPIPE stream error and crashes the process.
    const r = await runCli(process.execPath, ['-e', 'process.exit(0)'], {
      input: 'x'.repeat(1024 * 1024),
      timeoutMs: 15_000,
    });
    expect(r.code).toBe(0);
    expect(r.aborted).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it('still pipes stdin to children that consume it', async () => {
    const r = await runCli(
      process.execPath,
      // Same escaping-avoidance rationale as above: no quotes, no arrow
      // functions (their `>` reads as cmd.exe output redirection when
      // unquoted), and no spaces at all — even the space after a `let`
      // keyword is enough for cmd.exe to split this into two tokens, so `d`
      // is an implicit global instead of a `let` declaration.
      ['-e', "d='';process.stdin.on('data',function(c){d+=c}).on('end',function(){process.stdout.write(d)})"],
      { input: 'hello-stdin', timeoutMs: 15_000 },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hello-stdin');
  });

  it('round-trips a large multi-line prompt with quotes and Windows paths without truncation', async () => {
    // Regression case for the Windows argv bug: a prompt this size/shape would
    // be mangled or truncated if passed as a single cmd.exe argv element
    // (~8KB command-line limit, plus newline/quote parsing issues). Piped via
    // stdin instead, it must survive byte-for-byte regardless of size.
    const prompt = [
      'line one',
      'line two with "double quotes" and a Windows path C:\\Users\\Test User\\repo',
      'x'.repeat(9000),
    ].join('\n');
    const r = await runCli(
      process.execPath,
      // Same escaping-avoidance rationale as above: no quotes, no arrow
      // functions (their `>` reads as cmd.exe output redirection when
      // unquoted), and no spaces at all — even the space after a `let`
      // keyword is enough for cmd.exe to split this into two tokens, so `d`
      // is an implicit global instead of a `let` declaration.
      ['-e', "d='';process.stdin.on('data',function(c){d+=c}).on('end',function(){process.stdout.write(d)})"],
      { input: prompt, timeoutMs: 15_000 },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(prompt);
  });
});

describe('extractSemver (--version output parsing)', () => {
  it('extracts from claude-style decorated output', () => {
    expect(extractSemver('2.1.6 (Claude Code)')).toBe('2.1.6');
  });

  it('extracts from codex-style prefixed output', () => {
    expect(extractSemver('codex-cli 0.142.4')).toBe('0.142.4');
  });

  it('keeps prerelease/build suffixes', () => {
    expect(extractSemver('tool 1.2.3-beta.1')).toBe('1.2.3-beta.1');
  });

  it('finds the version even after a banner line', () => {
    expect(extractSemver('A new release is available!\nclaude 3.0.0 (Claude Code)')).toBe('3.0.0');
  });

  it('returns null when nothing version-shaped is present', () => {
    expect(extractSemver('no version here')).toBeNull();
    expect(extractSemver('')).toBeNull();
  });
});
