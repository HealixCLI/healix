/**
 * Unit tests for OpenAIProvider (the M0 Codex stub) — fully offline.
 *
 * complete() and plan() are deliberate stubs: they must resolve to ok:false
 * results WITHOUT throwing and without spawning the Codex CLI. detect() may
 * shell out to `which codex` (harmless/fast and works whether or not codex is
 * installed); we only assert it resolves to the documented DetectResult shape.
 */
import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from './openai.js';

describe('OpenAIProvider static shape', () => {
  const provider = new OpenAIProvider();

  it('exposes the expected id, label and capabilities', () => {
    expect(provider.id).toBe('openai');
    expect(provider.label).toBe('OpenAI (Codex CLI)');
    expect(provider.capabilities).toEqual(['codegen', 'plan', 'triage']);
    // OpenAI/Codex does not advertise computer-use.
    expect(provider.capabilities).not.toContain('computer-use');
  });
});

describe('OpenAIProvider M0 stubs (no CLI, no throw)', () => {
  const provider = new OpenAIProvider();

  it('complete() returns an ok:false stub result without throwing', async () => {
    const result = await provider.complete('anything at all');
    expect(result.provider).toBe('openai');
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
    expect(result.raw).toBeNull();
    expect(result.detail).toMatch(/not implemented/i);
  });

  it('complete() ignores options and still stubs out cleanly', async () => {
    const result = await provider.complete('prompt', { mode: 'plan', timeoutMs: 5, cwd: '/tmp' });
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
  });

  it('plan() returns an ok:false stub result without throwing', async () => {
    const result = await provider.plan();
    expect(result.provider).toBe('openai');
    expect(result.ok).toBe(false);
    expect(result.plan).toBe('');
    expect(result.raw).toBeNull();
    expect(result.detail).toMatch(/not implemented/i);
  });
});

describe('OpenAIProvider.detect (shape only)', () => {
  const provider = new OpenAIProvider();

  it('resolves to a DetectResult with a boolean installed flag', async () => {
    const det = await provider.detect();
    expect(typeof det.installed).toBe('boolean');
    // binPath/version are string-or-null regardless of whether codex exists.
    expect(det.binPath === null || typeof det.binPath === 'string').toBe(true);
    expect(det.version === null || typeof det.version === 'string').toBe(true);
    // When the CLI is absent the contract is a fully-null result.
    if (!det.installed) {
      expect(det.binPath).toBeNull();
      expect(det.version).toBeNull();
    }
  });
});
