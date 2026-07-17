/**
 * Unit tests for OpenAIProvider (real Codex CLI adapter) — fully offline.
 *
 * We never invoke complete()/plan()/health(probe) here: those shell out to
 * `codex exec` and hit the network. Instead we test the pure JSONL parser
 * (parseCodexExec) plus the static shape and the offline detect() contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../exec/run-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec/run-cli.js')>();
  return { ...actual, runCli: vi.fn() };
});

import { runCli } from '../exec/run-cli.js';
import { OpenAIProvider, parseCodexExec } from './openai.js';

// Harmless default so the existing detect()/health() shape tests keep working
// on hosts where `codex` actually is on PATH; call-count assertions in the
// timeout tests below clear history first.
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

describe('OpenAIProvider.complete — default timeout (mocked runCli)', () => {
  const provider = new OpenAIProvider();
  const okStdout = '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}';

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
