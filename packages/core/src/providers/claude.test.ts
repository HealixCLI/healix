/**
 * Unit tests for ClaudeProvider — deterministic, no real Claude CLI calls.
 *
 * The Claude adapter's live behaviour (health probe, complete, plan) shells
 * out to the real `claude` binary, which is non-deterministic and out of scope
 * for an offline unit test. We assert:
 *   - the pure JSON parsing helper (parseClaudeJson) that health/complete/plan
 *     share — including its tolerance of update banners on stdout,
 *   - the static adapter shape (id / label / capabilities), and
 *   - that detect() resolves to a DetectResult-shaped object with a boolean
 *     `installed` flag. detect() only ever runs `which claude` (+ `--version`
 *     if present) which is fast and harmless, and the assertions hold whether
 *     or not the CLI is installed on the host.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../exec/run-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec/run-cli.js')>();
  return { ...actual, runCli: vi.fn() };
});

import { runCli } from '../exec/run-cli.js';
import { ClaudeProvider, parseClaudeJson } from './claude.js';

// Module-wide mock: give it a harmless default so unrelated calls (e.g. the
// existing detect() test's `--version` probe) don't blow up, and clear call
// history before every test so call-count assertions in the new prompt-
// delivery tests below aren't polluted by calls other tests made.
const runCliMock = vi.mocked(runCli);
runCliMock.mockResolvedValue({
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: false,
  durationMs: 0,
});
beforeEach(() => {
  runCliMock.mockClear();
});

describe('parseClaudeJson (tolerant --output-format json parsing)', () => {
  /** Canned successful result object, as the CLI prints it. */
  const RESULT = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'HEALIX_OK',
    duration_ms: 1234,
  };

  it('parses clean JSON stdout (strict fast path)', () => {
    const parsed = parseClaudeJson(`${JSON.stringify(RESULT)}\n`);
    expect(parsed).toMatchObject({ is_error: false, subtype: 'success', result: 'HEALIX_OK' });
  });

  it('recovers the result object when an update banner precedes it', () => {
    // Real-world failure mode: the CLI prints a plain-text banner before the
    // JSON, strict JSON.parse throws, and a healthy auth probe was misread as
    // an auth error. The parser must skip the banner and find the object.
    const stdout = [
      'Update available! 2.1.6 → 2.2.0',
      'Run npm i -g @anthropic-ai/claude-code to update.',
      JSON.stringify(RESULT),
      '',
    ].join('\n');
    const parsed = parseClaudeJson(stdout);
    expect(parsed).toMatchObject({ is_error: false, result: 'HEALIX_OK' });
  });

  it('picks the LAST top-level object when noise contains earlier JSON', () => {
    const stdout = ['{"type":"banner","note":"ignore me"}', JSON.stringify(RESULT)].join('\n');
    expect(parseClaudeJson(stdout)?.result).toBe('HEALIX_OK');
  });

  it('handles nested objects and braces inside string values', () => {
    const tricky = {
      ...RESULT,
      result: 'literal } brace { inside a string',
      modelUsage: { 'claude-sonnet-4-5': { inputTokens: 1 } },
    };
    const stdout = `some banner line\n${JSON.stringify(tricky)}`;
    const parsed = parseClaudeJson(stdout);
    expect(parsed?.result).toBe('literal } brace { inside a string');
    expect(parsed?.modelUsage).toEqual(tricky.modelUsage);
  });

  it('falls back to the first { when noise shares the JSON line', () => {
    const stdout = `notice: ${JSON.stringify(RESULT)}`;
    expect(parseClaudeJson(stdout)?.result).toBe('HEALIX_OK');
  });

  it('returns null for garbage, empty and truncated output', () => {
    expect(parseClaudeJson('')).toBeNull();
    expect(parseClaudeJson('   \n  ')).toBeNull();
    expect(parseClaudeJson('complete garbage, no json anywhere')).toBeNull();
    // Truncated object never balances — must not throw, must not mis-parse.
    expect(parseClaudeJson('{"type":"result","result":"cut off')).toBeNull();
  });
});

describe('ClaudeProvider static shape', () => {
  const provider = new ClaudeProvider();

  it('exposes the expected id, label and capabilities', () => {
    expect(provider.id).toBe('claude');
    expect(provider.label).toBe('Claude (Claude Code CLI)');
    expect(provider.capabilities).toEqual(['computer-use', 'codegen', 'plan', 'triage']);
    // Claude is the computer-use capable provider.
    expect(provider.capabilities).toContain('computer-use');
  });
});

describe('ClaudeProvider.detect (shape only — no live probe)', () => {
  const provider = new ClaudeProvider();

  it('resolves to a DetectResult with a boolean installed flag', async () => {
    const det = await provider.detect();
    expect(typeof det.installed).toBe('boolean');
    expect(det.binPath === null || typeof det.binPath === 'string').toBe(true);
    expect(det.version === null || typeof det.version === 'string').toBe(true);
    // Absent CLI must yield a fully-null result per the adapter contract.
    if (!det.installed) {
      expect(det.binPath).toBeNull();
      expect(det.version).toBeNull();
    }
  });
});

describe('ClaudeProvider.complete / plan — prompt delivery (mocked runCli)', () => {
  const provider = new ClaudeProvider();
  const okStdout = JSON.stringify({ is_error: false, result: 'ok' });

  it('complete() sends the prompt via stdin, never in argv', async () => {
    runCliMock.mockResolvedValueOnce({
      code: 0,
      stdout: okStdout,
      stderr: '',
      timedOut: false,
      aborted: false,
      durationMs: 1,
    });
    const prompt = 'plain prompt';
    await provider.complete(prompt);

    expect(runCliMock).toHaveBeenCalledTimes(1);
    const [, args, callOpts] = runCliMock.mock.calls[0]!;
    expect(args).toEqual(['-p', '--output-format', 'json']);
    expect(args).not.toContain(prompt);
    expect(callOpts?.input).toBe(prompt);
  });

  it('complete() in plan/readOnly mode still sends the prompt via stdin', async () => {
    runCliMock.mockResolvedValueOnce({
      code: 0,
      stdout: okStdout,
      stderr: '',
      timedOut: false,
      aborted: false,
      durationMs: 1,
    });
    const prompt = 'plan-mode prompt';
    await provider.complete(prompt, { mode: 'plan' });

    const [, args, callOpts] = runCliMock.mock.calls[0]!;
    expect(args).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'plan']);
    expect(args).not.toContain(prompt);
    expect(callOpts?.input).toBe(prompt);
  });

  it('plan() sends the task via stdin, never in argv', async () => {
    runCliMock.mockResolvedValueOnce({
      code: 0,
      stdout: okStdout,
      stderr: '',
      timedOut: false,
      aborted: false,
      durationMs: 1,
    });
    const task = 'plan this task';
    await provider.plan(task);

    const [, args, callOpts] = runCliMock.mock.calls[0]!;
    expect(args).toEqual(['-p', '--permission-mode', 'plan', '--output-format', 'json']);
    expect(args).not.toContain(task);
    expect(callOpts?.input).toBe(task);
  });

  it('regression: a multi-line prompt with quotes and a Windows path never touches argv', async () => {
    // This is the exact shape that broke on Windows: embedded newlines/quotes/
    // backslash-paths mangled by cmd.exe when passed as a single argv element.
    runCliMock.mockResolvedValueOnce({
      code: 0,
      stdout: okStdout,
      stderr: '',
      timedOut: false,
      aborted: false,
      durationMs: 1,
    });
    const prompt = [
      'Repository path (white-box): C:\\Users\\Test User\\repo',
      'PRD / acceptance criteria to ground the plan:',
      '"""',
      'The app must handle "quoted" input & special chars like | and ^.',
      '"""',
    ].join('\n');
    await provider.complete(prompt, { mode: 'plan' });

    const [, args, callOpts] = runCliMock.mock.calls[0]!;
    for (const a of args) expect(a).not.toContain(prompt);
    expect(callOpts?.input).toBe(prompt);
  });

  it('defaults to a 300s timeout when no timeoutMs override is given', async () => {
    runCliMock.mockResolvedValueOnce({
      code: 0,
      stdout: okStdout,
      stderr: '',
      timedOut: false,
      aborted: false,
      durationMs: 1,
    });
    await provider.complete('prompt');
    const [, , callOpts] = runCliMock.mock.calls[0]!;
    expect(callOpts?.timeoutMs).toBe(300_000);
  });

  it('honours an explicit timeoutMs override instead of the default', async () => {
    runCliMock.mockResolvedValueOnce({
      code: 0,
      stdout: okStdout,
      stderr: '',
      timedOut: false,
      aborted: false,
      durationMs: 1,
    });
    await provider.complete('prompt', { timeoutMs: 42_000 });
    const [, , callOpts] = runCliMock.mock.calls[0]!;
    expect(callOpts?.timeoutMs).toBe(42_000);
  });
});
