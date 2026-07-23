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
}
