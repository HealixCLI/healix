/**
 * Unit tests for ClaudeProvider — deterministic, no real Claude CLI calls.
 *
 * The Claude adapter's interesting behaviour (health probe, complete, plan)
 * all shell out to the live `claude` binary, which is non-deterministic and
 * out of scope for an offline unit test. There are no exported pure parsing
 * helpers to test in isolation, so per the M0 testing guidance we assert:
 *   - the static adapter shape (id / label / capabilities), and
 *   - that detect() resolves to a DetectResult-shaped object with a boolean
 *     `installed` flag. detect() only ever runs `which claude` (+ `--version`
 *     if present) which is fast and harmless, and the assertions hold whether
 *     or not the CLI is installed on the host.
 */
import { describe, expect, it } from 'vitest';
import { ClaudeProvider } from './claude.js';

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
