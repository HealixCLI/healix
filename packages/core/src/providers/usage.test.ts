import { describe, expect, it } from 'vitest';
import { extractUsage } from './usage.js';

describe('extractUsage', () => {
  it('sums tokens/cost across every model in a real Claude modelUsage shape', () => {
    const raw = {
      modelUsage: {
        'claude-haiku-4-5-20251001': { inputTokens: 521, outputTokens: 14, costUSD: 0.000591 },
        'claude-sonnet-5': { inputTokens: 2, outputTokens: 4, costUSD: 0.240834 },
      },
    };
    expect(extractUsage(raw)).toEqual({
      inputTokens: 523,
      outputTokens: 18,
      costUsd: 0.241425,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('sums cache-creation/cache-read tokens across every model, confirmed against a real CLI response shape', () => {
    // Real field names/shape observed from a live `claude -p ... --output-format
    // json` call: modelUsage[model].cacheCreationInputTokens/cacheReadInputTokens,
    // only present/non-zero on the entry that actually wrote to or read from the
    // prompt cache for that call.
    const raw = {
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 530,
          outputTokens: 13,
          costUSD: 0.000595,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        'claude-sonnet-5': {
          inputTokens: 2,
          outputTokens: 9,
          costUSD: 0.067923,
          cacheCreationInputTokens: 9637,
          cacheReadInputTokens: 33201,
        },
      },
    };
    const result = extractUsage(raw);
    expect(result?.cacheCreationInputTokens).toBe(9637);
    expect(result?.cacheReadInputTokens).toBe(33201);
    // The requested model (sonnet) has far fewer input/output tokens than the
    // incidental haiku entry (2+9=11 vs 530+13=543), but its cache activity
    // (9637+33201=42838) makes its total weight dominant — proving the model
    // pick isn't fooled by a heavily-cached call's small fresh-token count.
    expect(result?.model).toBe('claude-sonnet-5');
  });

  it('picks the model with the most fresh tokens when neither entry has cache activity', () => {
    const raw = {
      modelUsage: {
        'claude-haiku-4-5-20251001': { inputTokens: 8, outputTokens: 2 },
        'claude-sonnet-5': { inputTokens: 400, outputTokens: 900 },
      },
    };
    expect(extractUsage(raw)?.model).toBe('claude-sonnet-5');
  });

  it('returns null when raw has no modelUsage at all (e.g. a RawCommand from a timeout/abort)', () => {
    expect(extractUsage({ code: null, signal: null, stdout: '', stderr: '', timedOut: true })).toBeNull();
    expect(extractUsage(null)).toBeNull();
    expect(extractUsage(undefined)).toBeNull();
    expect(extractUsage('not an object')).toBeNull();
  });

  it('returns null when modelUsage exists but no entry has token fields', () => {
    expect(extractUsage({ modelUsage: {} })).toBeNull();
    expect(extractUsage({ modelUsage: { 'some-model': { contextWindow: 200000 } } })).toBeNull();
  });

  it('reports costUsd as null (not 0) when tokens are present but no entry reports a cost', () => {
    const raw = { modelUsage: { 'some-model': { inputTokens: 10, outputTokens: 5 } } };
    expect(extractUsage(raw)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      costUsd: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      model: 'some-model',
    });
  });

  it('reports cache tokens as null (not 0) when no entry reports any cache activity', () => {
    const raw = { modelUsage: { 'some-model': { inputTokens: 10, outputTokens: 5 } } };
    const result = extractUsage(raw);
    expect(result?.cacheCreationInputTokens).toBeNull();
    expect(result?.cacheReadInputTokens).toBeNull();
  });
});
