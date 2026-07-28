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
  return { ...actual, runCli: vi.fn(), which: vi.fn() };
});

// readModelConfigOverrides hits the filesystem (appDataDir()); keep it
// deterministic/offline in unit tests, with resolveModelAndEffort's pure
// merge logic left real so its own defaults still apply.
vi.mock('./model-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./model-config.js')>();
  return { ...actual, readModelConfigOverrides: vi.fn() };
});

import { runCli, which } from '../exec/run-cli.js';
import { readModelConfigOverrides } from './model-config.js';
import { ClaudeProvider, parseClaudeJson, parseClaudeStreamJson } from './claude.js';

const readOverridesMock = vi.mocked(readModelConfigOverrides);

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
// which() shells out to the real PATH — CI runners don't have the `claude`
// binary installed, so leaving this unmocked makes detect() (and anything
// that calls it, like health()) non-deterministic across environments.
// Force it to report installed so detect()/health() always reach runCli.
const whichMock = vi.mocked(which);
whichMock.mockResolvedValue('/usr/local/bin/claude');
beforeEach(() => {
  runCliMock.mockClear();
  whichMock.mockClear();
  whichMock.mockResolvedValue('/usr/local/bin/claude');
  readOverridesMock.mockReset();
  readOverridesMock.mockResolvedValue(null);
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

describe('parseClaudeStreamJson (tolerant --output-format stream-json JSONL parsing)', () => {
  const RESULT = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'HEALIX_OK',
    duration_ms: 1234,
  };
  const INIT_EVENT = { type: 'system', subtype: 'init', model: 'claude-sonnet-4-5', session_id: 'abc' };
  const DELTA_EVENT = { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'partial' } } };

  it('extracts the final result line, ignoring init/delta progress events before it', () => {
    const stdout = [JSON.stringify(INIT_EVENT), JSON.stringify(DELTA_EVENT), JSON.stringify(RESULT)].join('\n');
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed).toMatchObject({ is_error: false, result: 'HEALIX_OK' });
  });

  it('parses a single-line result with no preceding stream events (back-compat with blob-shaped fixtures)', () => {
    const parsed = parseClaudeStreamJson(`${JSON.stringify(RESULT)}\n`);
    expect(parsed).toMatchObject({ is_error: false, result: 'HEALIX_OK' });
  });

  it('tolerates an update banner sharing a line with an early progress event', () => {
    const stdout = [
      `Update available! 2.1.6 → 2.2.0 ${JSON.stringify(INIT_EVENT)}`,
      JSON.stringify(RESULT),
    ].join('\n');
    expect(parseClaudeStreamJson(stdout)?.result).toBe('HEALIX_OK');
  });

  it('picks the LAST is_error-carrying line if more than one appears', () => {
    const stale = { ...RESULT, result: 'stale' };
    const stdout = [JSON.stringify(stale), JSON.stringify(RESULT)].join('\n');
    expect(parseClaudeStreamJson(stdout)?.result).toBe('HEALIX_OK');
  });

  it('handles braces inside string values on a single JSONL line', () => {
    const tricky = { ...RESULT, result: 'literal } brace { inside a string' };
    const stdout = [JSON.stringify(INIT_EVENT), JSON.stringify(tricky)].join('\n');
    expect(parseClaudeStreamJson(stdout)?.result).toBe('literal } brace { inside a string');
  });

  it('returns null when the stream was cut off before a result event (killed by idle/hard timeout)', () => {
    const stdout = [JSON.stringify(INIT_EVENT), JSON.stringify(DELTA_EVENT)].join('\n');
    expect(parseClaudeStreamJson(stdout)).toBeNull();
  });

  it('falls back to the whole-blob parser for a pretty-printed multi-line JSON object (no JSONL result line)', () => {
    const stdout = `${JSON.stringify(RESULT, null, 2)}\n`;
    expect(parseClaudeStreamJson(stdout)?.result).toBe('HEALIX_OK');
  });

  it('returns null for garbage, empty and truncated output', () => {
    expect(parseClaudeStreamJson('')).toBeNull();
    expect(parseClaudeStreamJson('   \n  ')).toBeNull();
    expect(parseClaudeStreamJson('complete garbage, no json anywhere')).toBeNull();
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
    expect(args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
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
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'plan',
    ]);
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
    expect(args).toEqual([
      '-p',
      '--permission-mode',
      'plan',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]);
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

  it('defaults to a 25-minute absolute-backstop timeout and a 60s idle timeout when no override is given', async () => {
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
    expect(callOpts?.timeoutMs).toBe(25 * 60_000);
    expect(callOpts?.idleTimeoutMs).toBe(60_000);
  });

  it('honours an explicit timeoutMs override for the hard backstop, leaving the idle timeout untouched', async () => {
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
    expect(callOpts?.idleTimeoutMs).toBe(60_000);
  });

  it('a timed-out completion reports whether the idle or hard timer fired', async () => {
    runCliMock.mockResolvedValueOnce({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      timeoutKind: 'idle',
      aborted: false,
      durationMs: 1,
    });
    const res = await provider.complete('prompt');
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('no output for 60000ms');
  });
});

describe('ClaudeProvider — per-task-type model/effort routing', () => {
  const provider = new ClaudeProvider();
  const okStdout = JSON.stringify({ is_error: false, result: 'ok' });

  beforeEach(() => {
    runCliMock.mockResolvedValue({
      code: 0,
      stdout: okStdout,
      stderr: '',
      timedOut: false,
      aborted: false,
      durationMs: 1,
    });
  });

  it('complete() omits --model/--effort when no taskType is given (back-compat)', async () => {
    await provider.complete('prompt');
    const [, args] = runCliMock.mock.calls[0]!;
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  it('complete() appends --model/--effort resolved from the hardcoded default for a given taskType', async () => {
    const res = await provider.complete('prompt', { taskType: 'triage' });
    const [, args] = runCliMock.mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['--model', 'haiku', '--effort', 'high']));
    expect(res.model).toBe('haiku');
    expect(res.effort).toBe('high');
  });

  it('complete() prefers a user override over the hardcoded default', async () => {
    readOverridesMock.mockResolvedValue({ triage: { model: 'sonnet' } });
    const res = await provider.complete('prompt', { taskType: 'triage' });
    const [, args] = runCliMock.mock.calls[0]!;
    // model overridden to sonnet; effort falls back to the default (high) since unset.
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'high']));
    expect(res.model).toBe('sonnet');
    expect(res.effort).toBe('high');
  });

  it('plan() resolves model/effort from taskType the same way complete() does', async () => {
    const res = await provider.plan('task', { taskType: 'plan-generate' });
    const [, args] = runCliMock.mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'high']));
    expect(res.model).toBe('sonnet');
    expect(res.effort).toBe('high');
  });

  it('health() resolves the health-probe task type internally', async () => {
    await provider.health();
    const [, args] = runCliMock.mock.calls.at(-1)!;
    expect(args).toEqual(expect.arrayContaining(['--model', 'haiku', '--effort', 'low']));
  });

  it('health() streams via stream-json and arms a 20s idle timeout', async () => {
    await provider.health();
    const [, args, callOpts] = runCliMock.mock.calls.at(-1)!;
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose', '--include-partial-messages']));
    expect(callOpts?.idleTimeoutMs).toBe(20_000);
  });

  it('a failed/timed-out completion still surfaces the resolved model/effort', async () => {
    runCliMock.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: '',
      timedOut: true,
      aborted: false,
      durationMs: 1,
    });
    const res = await provider.complete('prompt', { taskType: 'mock-response' });
    expect(res.ok).toBe(false);
    expect(res.model).toBe('haiku');
    expect(res.effort).toBe('high');
  });
});
