/**
 * Triage engine — deterministic classifier first, two-hypothesis AI analysis
 * second (ported from TestBot's failure-triage pipeline).
 *
 * `classify` is synchronous, cheap, and deterministic: it runs a first-match
 * rule chain over the error text/title and always returns a verdict (defaulting
 * to low-confidence `ambiguous`).
 *
 * `analyze` escalates to the configured provider with a grounded two-hypothesis
 * prompt, parses the fenced-JSON reply robustly, and falls back to `classify`
 * whenever the provider errors, times out, or returns an unparseable reply.
 */
import type { ProviderAdapter } from '../providers/types.js';
import type { UsageRecorder } from '../providers/usage.js';
import type { TriageEngine, TriageInput, TriageResult } from './types.js';
import { classifyByRules } from './rules.js';
import { buildTriagePrompt, parseTriageReply } from './prompt.js';

export * from './types.js';

/** Provider call budget for a single triage analysis. */
const ANALYZE_TIMEOUT_MS = 120_000;

/**
 * Blend an AI verdict with the deterministic baseline. The AI's verdict,
 * confidence, and rationale always win (it had the richest context and is only
 * reached when its reply parsed cleanly); the rule baseline contributes only a
 * suggestedPatch when the AI omitted one, so a deterministic fix is never lost.
 */
function reconcile(ai: TriageResult, rule: TriageResult): TriageResult {
  const merged: TriageResult = {
    verdict: ai.verdict,
    confidence: ai.confidence,
    rationale: ai.rationale,
  };
  // Carry the rule's patch forward only when the AI supplied none.
  const patch = ai.suggestedPatch ?? rule.suggestedPatch;
  if (typeof patch === 'string' && patch.length > 0) {
    merged.suggestedPatch = patch;
  }
  return merged;
}

export function createTriageEngine(): TriageEngine {
  return {
    classify(input: TriageInput): TriageResult {
      return classifyByRules(input);
    },

    async analyze(
      input: TriageInput,
      provider: ProviderAdapter,
      signal?: AbortSignal,
      onUsage?: UsageRecorder,
      cwd?: string,
    ): Promise<TriageResult> {
      // Deterministic baseline is always computed: it is the fallback and also
      // seeds a suggestedPatch the AI may omit.
      const baseline = classifyByRules(input);

      let prompt: string;
      try {
        prompt = buildTriagePrompt(input);
      } catch {
        return baseline;
      }

      let reply: Awaited<ReturnType<ProviderAdapter['complete']>>;
      try {
        reply = await provider.complete(prompt, {
          timeoutMs: ANALYZE_TIMEOUT_MS,
          cwd,
          signal,
          taskType: 'triage',
        });
        onUsage?.('triage', input.title, provider.id, reply.raw);
      } catch {
        // Provider threw (process error, etc.) — never leak; fall back.
        return baseline;
      }

      if (!reply || reply.ok !== true || !reply.text) {
        return baseline;
      }

      const parsed = parseTriageReply(reply.text);
      if (!parsed) {
        return baseline;
      }

      return reconcile(parsed, baseline);
    },
  };
}
