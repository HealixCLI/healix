import type { ProviderId } from './types.js';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  /**
   * The dominant model for this completion — the `modelUsage` key with the
   * highest total token weight (input + output + cache-creation + cache-read).
   * A single completion can report more than one model (e.g. an incidental
   * small Claude Code-internal call alongside the one actually requested via
   * `--model`), so picking by weight favors the model that did the real work
   * over a small internal side-call. Cache tokens are included in the weight
   * because a heavily-cached call can have a tiny `inputTokens` count (most of
   * its context came from the cache, not fresh input) while still being the
   * real request — input+output alone would then wrongly favor an incidental
   * call with no cache activity (confirmed against a real observed response
   * where the requested Sonnet call had inputTokens:2/outputTokens:9 but
   * cacheReadInputTokens:33201, versus an internal Haiku call with
   * inputTokens:530/outputTokens:13 and no cache activity at all — input+output
   * alone would have picked Haiku). Null if no entry has token fields.
   */
  model: string | null;
}

/**
 * Callback shape threaded through the orchestrator/generate/triage call sites
 * that make provider.complete() calls, so each can report its own usage back
 * to whatever persists it (the orchestrator's store.recordUsage), without
 * those lower-level functions needing to know about storage at all. `task` is
 * a human label scoping the call within its phase (e.g. a spec item's title,
 * or 'gap-fill') — null when the call site has no natural one.
 */
export type UsageRecorder = (phase: string, task: string | null, provider: ProviderId, raw: unknown) => void;

/**
 * Extract token/cost totals from a provider completion's `raw` field. Only the
 * Claude CLI's `--output-format json` shape is recognized today — it reports
 * per-model usage as `modelUsage: { [model]: { inputTokens, outputTokens,
 * costUSD, cacheCreationInputTokens, cacheReadInputTokens, ... } }`, confirmed
 * against a real `claude -p ... --output-format json` response (the cache
 * fields are only present/non-zero when Anthropic's prompt cache actually
 * wrote to or read from a cached prefix for that call). A single completion
 * can carry more than one model's entry (observed in practice), so every
 * model's tokens/cost/cache counts are summed into one total rather than
 * picking just the first. Returns null for anything that doesn't match — a
 * timed-out/aborted completion (raw is the RawCommand, not parsed JSON), or
 * another provider's `raw` shape (e.g. OpenAI/Codex, which doesn't report
 * usage at all today).
 */
export function extractUsage(raw: unknown): UsageTotals | null {
  if (!raw || typeof raw !== 'object') return null;
  const modelUsage = (raw as { modelUsage?: unknown }).modelUsage;
  if (!modelUsage || typeof modelUsage !== 'object') return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let sawTokens = false;
  let sawCost = false;
  let sawCacheTokens = false;
  let dominantModel: string | null = null;
  let dominantWeight = -1;

  for (const [modelName, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    let entryTokenWeight = 0;
    if (typeof e.inputTokens === 'number') {
      inputTokens += e.inputTokens;
      entryTokenWeight += e.inputTokens;
      sawTokens = true;
    }
    if (typeof e.outputTokens === 'number') {
      outputTokens += e.outputTokens;
      entryTokenWeight += e.outputTokens;
      sawTokens = true;
    }
    if (typeof e.costUSD === 'number') {
      costUsd += e.costUSD;
      sawCost = true;
    }
    if (typeof e.cacheCreationInputTokens === 'number') {
      cacheCreationInputTokens += e.cacheCreationInputTokens;
      entryTokenWeight += e.cacheCreationInputTokens;
      sawCacheTokens = true;
    }
    if (typeof e.cacheReadInputTokens === 'number') {
      cacheReadInputTokens += e.cacheReadInputTokens;
      entryTokenWeight += e.cacheReadInputTokens;
      sawCacheTokens = true;
    }
    if (entryTokenWeight > dominantWeight) {
      dominantWeight = entryTokenWeight;
      dominantModel = modelName;
    }
  }

  if (!sawTokens) return null;
  return {
    inputTokens,
    outputTokens,
    costUsd: sawCost ? costUsd : null,
    cacheCreationInputTokens: sawCacheTokens ? cacheCreationInputTokens : null,
    cacheReadInputTokens: sawCacheTokens ? cacheReadInputTokens : null,
    model: dominantModel,
  };
}
