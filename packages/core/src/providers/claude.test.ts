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
import { describe, expect, it } from 'vitest';
import { ClaudeProvider, parseClaudeJson } from './claude.js';

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
