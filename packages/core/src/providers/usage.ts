import type { ProviderId } from './types.js';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
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
 * costUSD, ... } }`, confirmed against a real `claude -p ... --output-format
 * json` response. A single completion can carry more than one model's entry
 * (observed in practice), so every model's tokens/cost are summed into one
 * total rather than picking just the first. Returns null for anything that
 * doesn't match — a timed-out/aborted completion (raw is the RawCommand, not
 * parsed JSON), or another provider's `raw` shape (e.g. OpenAI/Codex, which
 * doesn't report usage at all today).
 */
export function extractUsage(raw: unknown): UsageTotals | null {
  if (!raw || typeof raw !== 'object') return null;
  const modelUsage = (raw as { modelUsage?: unknown }).modelUsage;
  if (!modelUsage || typeof modelUsage !== 'object') return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawTokens = false;
  let sawCost = false;

  for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.inputTokens === 'number') {
      inputTokens += e.inputTokens;
      sawTokens = true;
    }
    if (typeof e.outputTokens === 'number') {
      outputTokens += e.outputTokens;
      sawTokens = true;
    }
    if (typeof e.costUSD === 'number') {
      costUsd += e.costUSD;
      sawCost = true;
    }
  }

  if (!sawTokens) return null;
  return { inputTokens, outputTokens, costUsd: sawCost ? costUsd : null };
}
