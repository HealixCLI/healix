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
    });
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
    expect(extractUsage(raw)).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: null });
  });
});
