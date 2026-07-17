import type { AuthPatternInfo } from './ast/auth-patterns.js';
import type { FormInfo } from './ast/forms.js';
import type { SelectorHint } from './ast/selectors.js';
import type { FunctionalityUnit } from './functionality-index.js';

/**
 * Full white-box static-analysis result for a repo: routes/endpoints (superset of the legacy
 * FunctionalityIndex, now provenance/schema-aware), plus forms/auth-patterns/selector-hints —
 * capabilities functionality-index.ts never had. This is the artifact meant to reach every
 * orchestrator phase (PLAN, GENERATE, EXPLORE, TRIAGE), not just PLAN.
 */
export interface SourceContext {
  units: FunctionalityUnit[];
  forms: FormInfo[];
  authPatterns: AuthPatternInfo[];
  selectorHints: SelectorHint[];
  /** Relative paths of every spec file (OpenAPI/Swagger/Postman) that contributed spec-provenance units. */
  specSources: string[];
  /** Short natural-language summary for prompt grounding, same shape as FunctionalityIndex.summary. */
  summary: string;
  truncated: boolean;
}
