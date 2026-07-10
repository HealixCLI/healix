/**
 * Unit tests for OpenAIProvider (real Codex CLI adapter) — fully offline.
 *
 * We never invoke complete()/plan()/health(probe) here: those shell out to
 * `codex exec` and hit the network. Instead we test the pure JSONL parser
 * (parseCodexExec) plus the static shape and the offline detect() contract.
 */
import { describe, expect, it } from 'vitest';
import { OpenAIProvider, parseCodexExec } from './openai.js';

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

describe('parseCodexExec (codex exec --json output)', () => {
  it('extracts the final assistant text on success', () => {
    const out = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"HEALIX_OK"}}',
      '{"type":"turn.completed"}',
    ].join('\n');
    const r = parseCodexExec(out);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('HEALIX_OK');
    expect(r.authError).toBe(false);
  });

  it('flags an expired/refused session as an auth error (not a generic error)', () => {
    const out = [
      '{"type":"turn.started"}',
      '{"type":"error","message":"Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."}',
      '{"type":"turn.failed","error":{"message":"refresh token was already used"}}',
    ].join('\n');
    const r = parseCodexExec(out);
    expect(r.authError).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('treats empty / non-JSON output as no usable response', () => {
    expect(parseCodexExec('').ok).toBe(false);
    expect(parseCodexExec('not json at all\n').ok).toBe(false);
  });

  it('prefers item.completed text over accumulated deltas (no double-counting)', () => {
    // The deltas stream partial copies of the SAME text the completed item
    // carries in full — appending both used to yield "HEALIX_OKHEALIX_OK".
    const out = [
      '{"type":"turn.started"}',
      '{"type":"agent_message.delta","delta":"HEALIX"}',
      '{"type":"agent_message.delta","delta":"_OK"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"HEALIX_OK"}}',
      '{"type":"turn.completed"}',
    ].join('\n');
    const r = parseCodexExec(out);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('HEALIX_OK');
  });

  it('falls back to accumulated deltas when no item.completed carries text', () => {
    // Truncated / older-CLI streams may never emit item.completed — the
    // stitched deltas are then the best available answer.
    const out = [
      '{"type":"agent_message.delta","delta":"HEALIX"}',
      '{"type":"agent_message.delta","delta":"_OK"}',
    ].join('\n');
    const r = parseCodexExec(out);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('HEALIX_OK');
  });

  it('ignores non-message item.completed payloads (e.g. reasoning items)', () => {
    // Reasoning/command items also carry `text`; only message items are the
    // assistant's reply.
    const out = [
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking about it..."}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"HEALIX_OK"}}',
    ].join('\n');
    const r = parseCodexExec(out);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('HEALIX_OK');
  });

  it('detects an auth failure surfaced only on stderr', () => {
    const r = parseCodexExec('', 'error: please sign in again');
    expect(r.authError).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe('OpenAIProvider.detect (offline shape)', () => {
  const provider = new OpenAIProvider();

  it('resolves to a DetectResult with a boolean installed flag', async () => {
    const det = await provider.detect();
    expect(typeof det.installed).toBe('boolean');
    expect(det.binPath === null || typeof det.binPath === 'string').toBe(true);
    expect(det.version === null || typeof det.version === 'string').toBe(true);
    if (!det.installed) {
      expect(det.binPath).toBeNull();
      expect(det.version).toBeNull();
    }
  });
});
