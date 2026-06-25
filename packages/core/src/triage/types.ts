import type { ProviderAdapter } from '../providers/types.js';

export type Verdict = 'test_is_wrong' | 'app_is_wrong' | 'environment' | 'flaky' | 'ambiguous';

export interface TriageInput {
  title: string;
  error: string;
  specSource?: string;
  reqTag?: string;
  tracePath?: string;
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
  analyze(input: TriageInput, provider: ProviderAdapter): Promise<TriageResult>;
}
