/**
 * Unit tests for the triage prompt reply parser.
 *
 * `parseTriageReply` is the public surface over the module-private JSON
 * extractor and confidence clamp; we test both through it. The headline cases:
 *   - a plain ```json fenced block,
 *   - a bare {...} object with no fence,
 *   - REGRESSION: an object whose `suggestedPatch` value itself contains a
 *     nested triple-backtick fence (a regex-only extractor truncates at the
 *     inner fence; the balanced string/escape-aware scan must not),
 *   - confidence clamping: a 1–5 scale value is not collapsed to 0.0x, and a
 *     0–100 percentage maps into [0,1].
 */
import { describe, it, expect } from 'vitest';
import { parseTriageReply } from './prompt.js';

describe('parseTriageReply — JSON extraction', () => {
  it('parses a plain fenced ```json code block', () => {
    const reply = [
      'Here is my verdict:',
      '```json',
      '{',
      '  "verdict": "app_is_wrong",',
      '  "confidence": 0.8,',
      '  "rationale": "Rendered content did not match the spec."',
      '}',
      '```',
    ].join('\n');

    const result = parseTriageReply(reply);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('app_is_wrong');
    expect(result?.confidence).toBe(0.8);
    expect(result?.rationale).toBe('Rendered content did not match the spec.');
  });

  it('parses a bare {...} object with no surrounding fence', () => {
    const reply =
      '{"verdict":"environment","confidence":0.6,"rationale":"Server was unreachable."}';

    const result = parseTriageReply(reply);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('environment');
    expect(result?.confidence).toBe(0.6);
  });

  it('parses a bare object embedded in surrounding prose', () => {
    const reply =
      'After analysis I conclude: {"verdict":"flaky","confidence":0.4,"rationale":"Timing."} — done.';

    const result = parseTriageReply(reply);
    expect(result?.verdict).toBe('flaky');
    expect(result?.confidence).toBe(0.4);
  });

  it('REGRESSION: handles a suggestedPatch value containing a nested triple-backtick fence', () => {
    // The model wraps the whole reply in a ```json fence AND the suggestedPatch
    // string itself embeds a nested ``` fence. A naive `/```json([\s\S]*?)```/`
    // extractor stops at the first inner ``` and truncates mid-object; the
    // balanced, string/escape-aware scan must close on the real object end.
    const patch =
      'Use:\\n```ts\\nawait expect(page.getByRole(\'heading\')).toHaveText(\'Welcome\');\\n```';
    const reply = [
      '```json',
      '{',
      '  "verdict": "test_is_wrong",',
      '  "confidence": 0.72,',
      '  "rationale": "The expected heading text was stale.",',
      `  "suggestedPatch": "${patch}"`,
      '}',
      '```',
    ].join('\n');

    const result = parseTriageReply(reply);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('test_is_wrong');
    expect(result?.confidence).toBe(0.72);
    // The patch must survive intact, including the nested fence markers.
    expect(result?.suggestedPatch).toContain('```ts');
    expect(result?.suggestedPatch).toContain("toHaveText('Welcome')");
    expect(result?.suggestedPatch).toContain('```');
  });

  it('returns null when no usable verdict is present', () => {
    expect(parseTriageReply('no json here at all')).toBeNull();
    expect(parseTriageReply('{"foo":"bar"}')).toBeNull();
  });
});

describe('parseTriageReply — confidence clamping', () => {
  it('keeps an already-normalized [0,1] confidence unchanged', () => {
    const result = parseTriageReply(
      '{"verdict":"ambiguous","confidence":0.5,"rationale":"x"}',
    );
    expect(result?.confidence).toBe(0.5);
  });

  it('does NOT collapse a small 1–5 scale value to 0.0x', () => {
    // A model answering "2" on a 1–5 scale must not become 0.02.
    const result = parseTriageReply(
      '{"verdict":"app_is_wrong","confidence":2,"rationale":"x"}',
    );
    expect(result).not.toBeNull();
    expect(result?.confidence).not.toBeCloseTo(0.02, 5);
    // Out-of-range small integers clamp up to the ceiling rather than dividing.
    expect(result?.confidence).toBe(1);
  });

  it("does NOT collapse a '5' confidence to 0.05", () => {
    const result = parseTriageReply(
      '{"verdict":"flaky","confidence":5,"rationale":"x"}',
    );
    expect(result?.confidence).not.toBeCloseTo(0.05, 5);
    expect(result?.confidence).toBe(1);
  });

  it('maps a 0–100 percentage into [0,1]', () => {
    const result = parseTriageReply(
      '{"verdict":"app_is_wrong","confidence":85,"rationale":"x"}',
    );
    expect(result?.confidence).toBe(0.85);
  });

  it('maps a 100 percentage to 1.0', () => {
    const result = parseTriageReply(
      '{"verdict":"environment","confidence":100,"rationale":"x"}',
    );
    expect(result?.confidence).toBe(1);
  });

  it('clamps a negative confidence to 0', () => {
    const result = parseTriageReply(
      '{"verdict":"ambiguous","confidence":-3,"rationale":"x"}',
    );
    expect(result?.confidence).toBe(0);
  });

  it('falls back to 0.5 for a non-finite / missing confidence', () => {
    const result = parseTriageReply(
      '{"verdict":"ambiguous","rationale":"no confidence field"}',
    );
    expect(result?.confidence).toBe(0.5);
  });
});
