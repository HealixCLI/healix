/**
 * Shared KB-evidence lookup for TriageInput — pulls the durable
 * requirement/mock/exploration/execution-evidence rows a failing test's KB
 * data already carries, instead of the narrow truncated strings triage used
 * to build from a live in-memory ExecOutcome.
 *
 * A single shared builder (rather than each call site re-deriving its own
 * evidence) is what guarantees the orchestrator's inline TRIAGE phase and
 * Retry-pass's own fresh-triage step (§7a) produce equally rich TriageInput
 * from the same durable tables — see docs/design/kb-foundation-evidence-persistence.md.
 */
import type { HealixStore } from '../storage/store.js';
import type { ExplorationSummary, MockResponseRow, Requirement, ResultEvidence } from '../storage/types.js';
import type { TriageExplorationContext, TriageMockEvidence, TriageRequirementContext } from './types.js';

/** Per-run KB rows, fetched ONCE and reused across every failing test in that run/batch — avoids re-querying the same run-scoped tables per failure. */
export interface KbRunContext {
  requirements: Requirement[];
  mockResponsesById: Map<string, MockResponseRow>;
  explorationSummaries: ExplorationSummary[];
}

export function loadKbRunContext(store: HealixStore, runId: string): KbRunContext {
  return {
    requirements: store.listRequirements(runId),
    mockResponsesById: new Map(store.listMockResponses(runId).map((m) => [m.id, m])),
    explorationSummaries: store.listExplorationSummaries(runId),
  };
}

/** Dedup a requirement by its tag — requirements are seeded one row per distinct (run_id, tag), so an exact tag match is authoritative. */
export function buildRequirementContext(
  ctx: KbRunContext,
  reqTag: string | null | undefined,
): TriageRequirementContext | undefined {
  const tag = reqTag?.trim();
  if (!tag) return undefined;
  const req = ctx.requirements.find((r) => r.tag === tag);
  if (!req) return undefined;
  return { tag: req.tag, ...(req.description ? { description: req.description } : {}) };
}

/**
 * Every mock target this specific test exercised — test_mock_usage is
 * genuinely per-test (unlike mock_responses' run-scoped rows), so this is
 * the only lookup here that needs a store call per test rather than the
 * shared KbRunContext.
 */
export function buildMockEvidence(
  store: HealixStore,
  ctx: KbRunContext,
  testId: string | null | undefined,
): TriageMockEvidence[] | undefined {
  if (!testId) return undefined;
  const usage = store.listMockUsageForTest(testId);
  if (usage.length === 0) return undefined;
  const entries: TriageMockEvidence[] = [];
  for (const u of usage) {
    const mock = ctx.mockResponsesById.get(u.mockResponseId);
    if (!mock) continue;
    entries.push({
      category: mock.category,
      method: mock.method,
      pathPattern: mock.pathPattern,
      mockStatus: mock.mockStatus,
      mockBody: mock.mockBodyJson,
      observedStatus: mock.observedStatus,
      observedBody: mock.observedBodyJson,
    });
  }
  return entries.length > 0 ? entries : undefined;
}

/** Parse a result row's persisted evidence_json — malformed/absent JSON yields undefined rather than throwing, same as every other best-effort KB read here. */
export function buildExecutionEvidence(evidenceJson: string | null | undefined): ResultEvidence | undefined {
  if (!evidenceJson) return undefined;
  try {
    const parsed = JSON.parse(evidenceJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ResultEvidence;
    }
  } catch {
    /* malformed row; treat as absent */
  }
  return undefined;
}

/** Escapes regex metacharacters so a route string can be embedded literally in a RegExp — same small helper duplicated locally in target/dependencies.ts and export/sanitize.ts. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Routes at or below this length (in practice, just "/") are too generic for
 * a bare substring check — see buildExplorationContext's doc comment.
 */
const SHORT_ROUTE_LENGTH = 2;

/**
 * Best-effort match of a failing test to the exploration_summaries row for
 * the route it targets. There is no explicit test→route link anywhere in
 * the schema, so this scans the caller-supplied text (spec source, error
 * output — wherever a `page.goto(...)`/navigated URL would appear) for the
 * longest exploration route string it contains; the longest match wins so a
 * short, generic route (e.g. "/") never shadows a more specific one also
 * present in the text.
 *
 * A normal, specific route (length > SHORT_ROUTE_LENGTH, e.g. "/login") keeps
 * the plain substring check — a coincidental exact match of a real multi-
 * character path is already vanishingly rare. A short, generic route like
 * "/" is a different story: a bare slash shows up constantly in text that
 * has nothing to do with navigation (file paths, imports, unrelated URLs, a
 * stack frame), so `text.includes(route)` alone makes it a near-universal
 * false positive. For routes this short, require it to appear as an actual
 * quoted literal instead — `page.goto('/')`, `navigate("/")`, an error like
 * `Expected URL: '/'` — which a genuine navigation reference always is, but
 * a coincidental slash elsewhere in the text never is.
 */
export function buildExplorationContext(
  ctx: KbRunContext,
  haystacks: Array<string | null | undefined>,
): TriageExplorationContext | undefined {
  let best: ExplorationSummary | undefined;
  let bestLen = 0;
  for (const text of haystacks) {
    if (!text) continue;
    for (const summary of ctx.explorationSummaries) {
      const route = summary.route.trim();
      if (route.length === 0 || route.length <= bestLen) continue;
      const isMatch =
        route.length > SHORT_ROUTE_LENGTH
          ? text.includes(route)
          : new RegExp(`['"\`]\\s*${escapeRegExp(route)}`).test(text);
      if (isMatch) {
        best = summary;
        bestLen = route.length;
      }
    }
  }
  if (!best) return undefined;
  return {
    route: best.route,
    ...(best.selectorsJson ? { selectors: best.selectorsJson } : {}),
    ...(best.formsJson ? { forms: best.formsJson } : {}),
    ...(best.authPattern ? { authPattern: best.authPattern } : {}),
  };
}

/** Everything buildKbTriageEvidence needs beyond the shared per-run KbRunContext — the per-test identifiers/text it joins against. */
export interface KbEvidenceParams {
  reqTag?: string | null;
  testId?: string | null;
  evidenceJson?: string | null;
  /** Text to search for a route match — typically the test's spec source and error output. */
  routeHaystacks: Array<string | null | undefined>;
}

/** The KB-sourced subset of TriageInput — spread this into a TriageInput alongside the existing title/error/reqTag/etc. fields. */
export interface KbTriageEvidence {
  requirement?: TriageRequirementContext;
  mockEvidence?: TriageMockEvidence[];
  executionEvidence?: ResultEvidence;
  explorationContext?: TriageExplorationContext;
}

/** Assemble every KB-sourced TriageInput field for one failing test, from a shared per-run KbRunContext. */
export function buildKbTriageEvidence(
  store: HealixStore,
  ctx: KbRunContext,
  params: KbEvidenceParams,
): KbTriageEvidence {
  const out: KbTriageEvidence = {};
  const requirement = buildRequirementContext(ctx, params.reqTag);
  if (requirement) out.requirement = requirement;
  const mockEvidence = buildMockEvidence(store, ctx, params.testId);
  if (mockEvidence) out.mockEvidence = mockEvidence;
  const executionEvidence = buildExecutionEvidence(params.evidenceJson);
  if (executionEvidence) out.executionEvidence = executionEvidence;
  const explorationContext = buildExplorationContext(ctx, params.routeHaystacks);
  if (explorationContext) out.explorationContext = explorationContext;
  return out;
}
