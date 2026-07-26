import type { ProviderAdapter } from '../providers/types.js';
import type { UsageRecorder } from '../providers/usage.js';

export type Verdict = 'test_is_wrong' | 'app_is_wrong' | 'environment' | 'flaky' | 'ambiguous';

export interface TriageInput {
  title: string;
  error: string;
  specSource?: string;
  reqTag?: string;
  tracePath?: string;
  /** Relative path of the source-context unit (see target/source-index.ts) the failing test's plan item mapped to, when known. */
  sourceFile?: string;
  /** That file's content (or a leading slice of it) — first-party repo code, cited normally rather than fenced as untrusted. */
  sourceExcerpt?: string;
}

export interface TriageResult {
  verdict: Verdict;
  confidence: number;
  rationale: string;
  /**
   * Recommended fix, present when the model could be concrete. Its shape
   * depends on `verdict`: for `test_is_wrong` it's a corrected test code
   * snippet; for `app_is_wrong` it's a prose recommendation for engineers
   * (likely root cause + where to look), not literal app source — the
   * triage engine never sees the app's codebase. Omitted for
   * environment/flaky/ambiguous, where there is no code-level fix.
   */
  suggestedPatch?: string;
}

/** One failure entered into a batched analyze() call, keyed by a caller-assigned id (stable across the batch/split-retry lifecycle — not the test's own reqTag/title, which may repeat or be absent). */
export interface TriageBatchItem {
  id: string;
  input: TriageInput;
}

/** Deterministic classifier first, AI hypothesis second (ported from TestBot failure-triage). */
export interface TriageEngine {
  classify(input: TriageInput): TriageResult;
  /**
   * `signal` lets the caller cancel the underlying provider call (and kill its
   * CLI child process) when its own patience runs out, instead of abandoning
   * it to keep running in the background untracked.
   */
  analyze(
    input: TriageInput,
    provider: ProviderAdapter,
    signal?: AbortSignal,
    onUsage?: UsageRecorder,
    cwd?: string,
  ): Promise<TriageResult>;
  /**
   * Analyze several failures in ONE provider call instead of N separate ones —
   * each item still gets its own evidence block in the prompt, but the fixed
   * instructions/schema preamble is only paid once per batch.
   *
   * `results` is keyed by each item's `id`; an id absent from it means that
   * one item's entry within an otherwise-parseable reply was missing or
   * malformed — the caller falls back to `classify()`'s baseline for it,
   * exactly as it already does for a solo `analyze()` timeout/failure.
   *
   * `truncated` is true only when the reply genuinely attempted a JSON array
   * but was cut off mid-object (see prompt.ts's looksLikeTruncatedBatchReply)
   * — the ONE case worth halving the batch and retrying (smaller output has a
   * real chance of not truncating). A reply with no array-like structure at
   * all (garbled text, a stub response) is NOT truncated — a smaller batch
   * has no reason to fix that, so the caller should not retry-split for it.
   */
  analyzeBatch(
    items: TriageBatchItem[],
    provider: ProviderAdapter,
    signal?: AbortSignal,
    onUsage?: UsageRecorder,
    cwd?: string,
  ): Promise<{ results: Map<string, TriageResult>; truncated: boolean }>;
}
