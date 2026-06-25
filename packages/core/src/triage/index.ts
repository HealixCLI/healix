import { notImplemented } from '../util/not-implemented.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { TriageEngine, TriageInput, TriageResult } from './types.js';

export * from './types.js';

/** Foundation stub — real classifier + AI analysis implemented in M3 (triage module). */
export function createTriageEngine(): TriageEngine {
  return {
    classify(_input: TriageInput): TriageResult {
      return notImplemented('TriageEngine.classify');
    },
    analyze(_input: TriageInput, _provider: ProviderAdapter): Promise<TriageResult> {
      return notImplemented('TriageEngine.analyze');
    },
  };
}
