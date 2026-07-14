import type { ProviderAdapter } from '../providers/types.js';

export type Verdict = 'test_is_wrong' | 'app_is_wrong' | 'environment' | 'flaky' | 'ambiguous';

export interface TriageInput {
  title: string;
  error: string;
  specSource?: string;
  reqTag?: string;
  tracePath?: string;
  /**
   * What the app actually exposes (observed interactive-element inventory from
   * exploration). Lets the analyzer distinguish "the app is missing X" from
   * "the test looked for X on the wrong page" — without it, a wrong-route test
   * failure reads exactly like a missing feature.
   */
  appContext?: string;
}

export interface TriageResult {
  verdict: Verdict;
  confidence: number;
  rationale: string;
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
  analyze(input: TriageInput, provider: ProviderAdapter, signal?: AbortSignal): Promise<TriageResult>;
}
