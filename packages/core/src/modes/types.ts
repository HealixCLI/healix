import type { ProviderAdapter } from '../providers/types.js';
import type { UsageRecorder } from '../providers/usage.js';
import type { ExternalDependency, MockResponse, TargetAdapter } from '../target/types.js';
import type { BrowserSurface } from '../browser/types.js';
import type { CrawlWithAuthResult, LoginCandidate, RoutePrefixInfo } from '../browser/crawler.js';
import type { ObservedEndpoint } from '../browser/network-capture.js';
import type { SourceContext } from '../target/source-context.js';
import type { ModeId, ProjectCredential, Tier, TestStatus } from '../storage/types.js';

/** Result of the multi-page/multi-role EXPLORE crawl, grounding GENERATE. */
export interface ExplorationArtifact {
  crawl: CrawlWithAuthResult;
  routing: RoutePrefixInfo;
  loginCandidates: LoginCandidate[];
  /** False when the crawl produced too little real context to trust (see assessExplorationUsefulness). */
  useful: boolean;
  uselessReason?: string;
  /** Fraction of routes with fewer than THIN_ROUTE_ELEMENT_THRESHOLD interactive elements — a
   * degradation signal distinct from `useful` (see assessExplorationUsefulness, F-03/F-06). Present
   * only when the crawl passed the hard useful/useless gate. */
  thinRouteRatio?: number;
  /** Real endpoints observed on the wire during the crawl — see GAP-046 and
   * `browser/network-capture.ts`'s `collectObservedEndpoints()`. */
  observedEndpoints: ObservedEndpoint[];
  /** Diagnostic summary of any region/config-driven seed fan-out performed beyond the primary
   * crawl — see `browser/seed-discovery.ts`. Absent when no additional seeds were derived. */
  seedsCrawled?: { url: string; label?: string; routeCount: number }[];
  /** Diagnostic record of the plan/endpoint-targeted gap-filling pass (see
   * `orchestrator/gap-fill.ts`), run once against whichever crawl came out of this artifact
   * (fresh or cache-reused). Absent when gap-fill found nothing to do or didn't run. */
  gapFillAttempts?: import('../orchestrator/gap-fill.js').GapFillAttempt[];
}

export type ExplorationMode = 'computer-use' | 'codegen';

/**
 * User-facing testing scope: what to test, as opposed to ExplorationMode
 * (how to explore it), which is now derived internally from the project's
 * config rather than chosen directly. Controls which tiers get planned,
 * generated, and executed.
 */
export type TestingScope = 'frontend' | 'backend' | 'both';

/** Tiers in scope for a given TestingScope selection. */
export function tiersForScope(scope: TestingScope): Tier[] {
  switch (scope) {
    case 'frontend':
      return ['tierA-public', 'tierB-auth'];
    case 'backend':
      return ['tierC-api'];
    case 'both':
      return ['tierA-public', 'tierB-auth', 'tierC-api'];
  }
}

/** Per-item plan review status. undefined is treated identically to 'pending' everywhere it's read. */
export type PlanItemStatus = 'pending' | 'approved' | 'rejected' | 'edited' | 'revised';

/**
 * One concrete test case within a plan item's feature. 'positive' (happy path) is
 * always required; 'negative' (invalid input/unauthorized/error path) and 'edge'
 * (boundary condition) are included only where applicable to the feature.
 */
export interface PlanScenario {
  kind: 'positive' | 'negative' | 'edge';
  description: string;
}

/** Snapshot of a plan item's content fields, used for before/after audit history. */
export interface PlanItemSnapshot {
  title: string;
  reqTag?: string;
  tier: Tier;
  intent: string;
  scenarios: PlanScenario[];
}

/** One manual edit event on a plan item, oldest-first in TestPlanItem.edits. */
export interface PlanItemEdit {
  before: PlanItemSnapshot;
  after: PlanItemSnapshot;
  editedAt: string;
}

/** One revise-with-suggestion event on a plan item, oldest-first in TestPlanItem.revisions. */
export interface PlanItemRevision {
  suggestion: string;
  before: PlanItemSnapshot;
  after: PlanItemSnapshot;
  revisedAt: string;
}

export interface TestPlanItem {
  id: string;
  title: string;
  reqTag?: string;
  tier: Tier;
  intent: string;
  /**
   * Concrete test cases to cover for this feature in one generated spec file.
   * Always has at least one 'positive' entry; 'negative'/'edge' entries are
   * present only when applicable to the feature.
   */
  scenarios: PlanScenario[];
  /**
   * Identity of the functionality-index unit (route/endpoint) this item targets,
   * when the plan was grounded on a functionality inventory. Used for coverage
   * matching; falls back to reqTag/title matching (see topup.ts's
   * computeIdentityKey) when absent.
   */
  unitKey?: string;
  /**
   * Per-item review status, set only by the approval-gate flow (never by
   * parsePlan/synthesizePlan). undefined means "not yet reviewed" and is
   * treated identically to 'pending' by every reader.
   */
  status?: PlanItemStatus;
  /**
   * The AI's original proposal for this item, captured the first time it is
   * edited or revised. Never overwritten again, so the first draft is always
   * recoverable even after multiple edits/revisions.
   */
  original?: PlanItemSnapshot;
  /** Audit trail of manual edits, oldest first. */
  edits?: PlanItemEdit[];
  /** Audit trail of revise-with-suggestion calls, oldest first. */
  revisions?: PlanItemRevision[];
  /**
   * Set only when a code-detected route-guard forced this item's tier post-hoc, overriding
   * whatever the model itself proposed — see orchestrator/plan.ts's applyAuthGuardTierOverrides.
   * Never set by the model; absent means no override was applied (including "none was needed").
   */
  tierOverride?: { from: Tier; to: Tier; reason: string };
}

export interface TestPlan {
  summary: string;
  items: TestPlanItem[];
  raw?: unknown;
  /**
   * How this plan's items were obtained. 'ai' when the model's own plan
   * completion(s) parsed successfully (even if some batches degraded — see
   * fallbackReason); 'fallback' when every attempt failed and the plan is
   * synthesizePlan()'s minimal hardcoded smoke plan; 'reuse' when suiteMode
   * 'reuse' replayed a prior run's suite with no AI planning at all.
   * Undefined for legacy/synthetic plans predating this field (e.g. tests).
   */
  planSource?: 'ai' | 'fallback' | 'reuse';
  /**
   * Present whenever planning degraded in some way — either the whole plan
   * is a fallback (planSource: 'fallback') or an otherwise-successful
   * batched plan (planSource: 'ai') had one or more batches fail outright.
   * Human-readable, meant for the report/UI, not machine parsing.
   */
  fallbackReason?: string;
}

/** True unless the item was explicitly rejected during per-item plan review. */
export function isPlanItemIncluded(item: TestPlanItem): boolean {
  return item.status !== 'rejected';
}

export interface GeneratedSpec {
  path: string;
  title: string;
  reqTag?: string;
  tier: Tier;
  contents: string;
  /**
   * The plan item this spec was generated for, set by the mode that produced
   * it. Unlike `reqTag`, which two DISTINCT items may legitimately share (e.g.
   * a UI-tier item and its tierC-api counterpart under the same requirement),
   * this is always unique — orchestrator/index.ts's registerSpecRows uses it
   * to resolve the exact originating item instead of guessing by reqTag, which
   * silently picks the wrong item whenever two share one. Absent for
   * carried-forward specs (copied bytes from a prior run — see
   * hydrateCarriedSpecs), which have no "originating item" in THIS run.
   */
  planItemId?: string;
}

/**
 * Why a spec got quarantined. 'parse' is the original (still-common) reason:
 * a syntax defect `attemptBracketRepair` couldn't fix. 'quality' is a static
 * quality-audit hard finding that survived block-level pruning (see
 * quality-audit.ts). 'codegen-defect' singles out a parse failure on a
 * source-grounded spec (one carrying a `[SRC:file]` citation) — that spec
 * was generated FROM a real file Healix already indexed, so a parse failure
 * there indicates a codegen bug rather than an ordinary model slip, and
 * should be surfaced louder than routine per-spec quarantine noise.
 */
export type QuarantineCategory = 'parse' | 'quality' | 'codegen-defect';

export interface QuarantinedSpec {
  spec: GeneratedSpec;
  reason: string;
  category?: QuarantineCategory;
}

/** One static quality-audit finding — see modes/playwright/quality-audit.ts. */
export type QualityFindingCode =
  | 'empty-assertion-block'
  | 'useless-wildcard-assertion'
  | 'hardcoded-credential-literal'
  | 'absolute-url-assertion'
  | 'disabled-button-race-risk'
  | 'disabled-button-click-race'
  | 'ambiguous-locator-risk'
  | 'unvalidated-status-code-assumption'
  | 'unattended-destructive-action'
  | 'unscoped-modal-assertion'
  | 'unblurred-validation-assertion';

export interface QualityFinding {
  code: QualityFindingCode;
  /** 'hard' findings block a test block (pruned, or the whole spec quarantined if pruning isn't viable); 'warn' findings are non-blocking signal only. */
  severity: 'hard' | 'warn';
  message: string;
  testTitle?: string;
  /** [start, end) character offsets of the enclosing test(...) block in the source — used to prune just that block rather than the whole file. */
  blockRange?: [number, number];
}

/** A spec that shipped (ok or repaired) but still carries non-blocking quality findings — surfaced to the report/UI as signal, never as a reason to fail the run. */
export interface QualityWarning {
  spec: GeneratedSpec;
  findings: QualityFinding[];
}

/** Result of a mode's pre-execution parse-check + quality-audit gate — see modes/playwright/validate.ts. */
export interface ValidationResult {
  ok: GeneratedSpec[];
  repaired: GeneratedSpec[];
  quarantined: QuarantinedSpec[];
  /** Specs in ok/repaired that still carry soft (non-blocking) quality findings. Always present; empty when there's nothing to report. */
  warnings: QualityWarning[];
}

/** One action/assertion step Playwright performed during a test — e.g. "click", "fill", "expect.toBeVisible". */
export interface ExecStepItem {
  title: string;
  durationMs: number;
  error?: string;
  /**
   * The raw actions (click/fill/expect/etc.) performed inside this step,
   * present only when this entry is a human-authored test.step(...) wrapper —
   * gives a high-level task name with the granular technical detail nested
   * underneath, instead of forcing a choice between the two.
   */
  steps?: ExecStepItem[];
}

export interface ExecResultItem {
  title: string;
  status: TestStatus;
  durationMs?: number;
  error?: string;
  artifacts?: string[];
  /** Step-by-step breakdown for this outcome, present for both passed and failed tests. Absent for older suites without the steps reporter. */
  steps?: ExecStepItem[];
  /**
   * The spec file this result came from (relative path, as reported by the
   * test runner) — when present, gives mergeExecOutcomes (coverage.ts) a
   * stable identity independent of title text, so two distinct generated
   * scenarios that coincidentally share wording (e.g. across gap-fill
   * iterations) aren't mistaken for the same re-executed test. Optional:
   * absent for synthetic/fallback result items that were never tied to a
   * real spec file.
   */
  specFile?: string;
  /**
   * Why a 'skipped' result was skipped — Playwright's own annotation
   * description from `test.skip(condition, 'reason')` (or `test.fixme(...)`),
   * when the test/suite provided one. Absent for a skip with no reason
   * given, or for any non-skipped status.
   */
  skipReason?: string;
  /**
   * Why no usable video is present for this (executed, non-skipped) result —
   * never a silent gap. Always a complete, ready-to-display message (callers
   * render it as-is, no prefix/suffix assembly needed) — see
   * UNEXPLAINED_MISSING_VIDEO_REASON for the one genuinely-unknown case.
   * Absent when a real, usable video IS present in `artifacts`, or for a
   * 'skipped' result (which never executed at all).
   */
  videoUnavailableReason?: string;
}

/**
 * ExecResultItem.videoUnavailableReason's value for the one genuinely
 * unexplained case: no video attachment exists at all for a browser-based
 * test, and nothing else (e.g. tierC-api) explains why. Exported as a named
 * constant — rather than every caller re-typing the literal string — so
 * emit-a-warning call sites can detect it by identity.
 */
export const UNEXPLAINED_MISSING_VIDEO_REASON = 'No video recorded.';

/**
 * A (dependency, method, path) tuple identifying exactly one mock_responses row — the SAME
 * identity that table's own UNIQUE(run_id, dependency_id, method, path_pattern) index uses.
 * method/pathPattern are null when a hit matched no SPECIFIC statically-detected endpoint
 * (an override with no corresponding registered endpoint, or a dependency's coarse
 * per-dependency generic default) — there's no single row those unambiguously belong to.
 * Lives here (not execute.ts) so coverage.ts's mergeExecOutcomes and orchestrator/index.ts
 * can use it without importing a Playwright-mode-specific module.
 */
export interface MockHitTuple {
  dependencyId: string;
  method: string | null;
  pathPattern: string | null;
}

/**
 * Stable string key for a MockHitTuple, normalizing null the same way store.ts's
 * upsertMockResponse does ('' — SQLite can't use null in a UNIQUE-index equality match) so a
 * caller building a lookup map from real mock_responses rows (store.listMockResponses) and a
 * caller building one from execute.ts's log-derived tuples always produce IDENTICAL keys for
 * the same real row, regardless of which side null vs. '' originated from.
 */
export function mockResponseTupleKey(
  dependencyId: string,
  method: string | null,
  pathPattern: string | null,
): string {
  return `${dependencyId} ${method ?? ''} ${pathPattern ?? ''}`;
}

export interface MockHitTally extends MockHitTuple {
  count: number;
}

export interface ExecOutcome {
  passed: number;
  failed: number;
  blocked: number;
  flaky: number;
  /**
   * Tests the runner recorded as `skipped` (TestStatus already had this
   * value — see storage/types.ts — but nothing here previously counted it).
   * See F-24 in the Set-2 fixtures/mock/auth-execution findings: a report
   * that only shows total/passed/failed/blocked/flaky leaves the fraction of
   * a suite that never actually ran invisible, since a reader has no
   * `skipped` figure to subtract out of `total`. Optional (rather than
   * matching the other counters' required-number style) purely so every
   * pre-existing ExecOutcome literal elsewhere in the codebase/tests doesn't
   * need a mechanical touch just to keep compiling; always populated by
   * execute.ts/coverage.ts — treat an absent value as 0. report.ts's own
   * "skipped" card recounts directly from `results` rather than trusting
   * this field, so the two stay in sync even if a caller ever forgets to
   * set it.
   */
  skipped?: number;
  results: ExecResultItem[];
  raw?: unknown;
  /**
   * Browser-level mock hits (page.route()/`request` fixture overrides — see
   * F-15), keyed by dependency id, tallied from execute.ts's
   * readMockRequestCounts(). Distinct from the orchestrator's separate,
   * launch-time mock HTTP server counts — the two mocking mechanisms are
   * unrelated, so the orchestrator merges both into one total for the report
   * rather than either silently overwriting the other. Optional/mode-specific:
   * a mode with no fixture-level mocking (or no mocking at all) simply omits it.
   */
  mockedRequestCounts?: Record<string, number>;
  /**
   * Same browser-level mock hits as mockedRequestCounts, but broken out per test — keyed by
   * `${specFile}#${title}` (the same identity apiEvidence/this file's own dedup keyOf() use)
   * — and tallied per EXACT (dependency, method, pathPattern) tuple rather than just
   * dependency id, from execute.ts's readMockRequestCountsByTest(). Feeds test_mock_usage
   * (see storage/schema.ts) — mockedRequestCounts above stays a run-level total for backward
   * compatibility (existing readers are untouched); this is the additional per-test
   * breakdown needed to resolve the specific mock_responses row a hit belongs to. Optional: a
   * mode with no fixture-level mocking (or an older log with no key on a line) simply omits
   * the affected entries.
   */
  mockedRequestCountsByTest?: Record<
    string,
    Array<{ dependencyId: string; method: string | null; pathPattern: string | null; count: number }>
  >;
  /**
   * Compact, prompt-ready summary of the actual HTTP call(s) a test made via
   * the `request` fixture — keyed by `${specFile}#${title}` (the same
   * identity execute.ts's own dedup keyOf() uses), from execute.ts's
   * readApiEvidence(). Lets triage see the REAL response a failing API-tier
   * assertion was checking against (which backend answered — Healix's own
   * mock or the real one — the status, a truncated body), instead of only the
   * one field Playwright's own error text happened to print. Optional: a test
   * that never called `request` (or a run predating this feature) simply has
   * no entry.
   */
  apiEvidence?: Record<string, string>;
  /**
   * Compact evidence that a test's own request(s) fell through the generated mock fixture
   * uninterecepted — hostname matched no detected dependency and no `mockOverride` matched
   * either — keyed the same way `apiEvidence` is, from execute.ts's readMockPassthroughLog().
   * A request that falls through hits the real (often unreachable, sandboxed) backend and
   * hangs to the outer Playwright test timeout, producing a bare "Test timeout exceeded" with
   * no other signal; this is what lets triage tell that apart from a genuinely slow app.
   * Optional: a test with no unintercepted call simply has no entry.
   */
  mockPassthrough?: Record<string, string>;
  /**
   * Each (dependency, method, pathPattern) tuple's LAST actually-served response —
   * status/body/headers as truly fulfilled by page.route()/the request fixture, not the
   * originally-generated mock_status/mock_body_json (which can differ per-call via a
   * per-test mockOverride()) — one entry per exact endpoint, from execute.ts's
   * readObservedMockResponses(). Feeds mock_responses.observed_* (see storage/schema.ts),
   * resolved to the EXACT row via the tuple, not just the dependency. "Observed" here means
   * "proven to have actually been served during this run," not a comparison against a
   * genuinely different real backend — tests run fully offline, so there is no live upstream
   * to compare against. Optional: a mode with no fixture-level mocking (or no mock hit at
   * all) simply omits it.
   */
  observedMockResponses?: Array<{
    dependencyId: string;
    method: string | null;
    pathPattern: string | null;
    status: number;
    bodyJson: string | null;
    headersJson: string | null;
  }>;
}

export interface SuiteBundle {
  dir: string;
  zipPath?: string;
  files: string[];
}

export interface TestModeContext {
  /** Working directory where the runnable suite is scaffolded/generated. */
  projectDir: string;
  repoPath?: string | null;
  baseUrl?: string | null;
  /** Test login identities for authenticated (tierB) flows — see storage's ProjectCredential. */
  credentials?: ProjectCredential[];
  provider: ProviderAdapter;
  target: TargetAdapter;
  browser: BrowserSurface;
  explorationMode?: ExplorationMode;
  /** Which tiers this run is in scope for; drives generation and execution. */
  testingScope?: TestingScope;
  /** Multi-page/multi-role EXPLORE crawl artifact; grounds generation. */
  exploration?: ExplorationArtifact;
  /** White-box static-analysis result (routes/endpoints/forms/auth patterns), set during PLAN; grounds generation and triage with real source-file citations. */
  sourceContext?: SourceContext;
  emit?: (phase: string, message: string, data?: unknown) => void;
  /** Reports a provider.complete() call's token/cost usage back to the run's store — see UsageRecorder. */
  onUsage?: UsageRecorder;
  /**
   * Reports a plan item's terminal GENERATE outcome (generated/dropped) back
   * to the run's Knowledge Base — see docs/design/retry-pass-coverage-kb-redesign.md.
   * Called from generate.ts's recordGenOutcome, the single funnel every
   * per-item terminal outcome already passes through. Optional: undefined
   * for callers/tests that don't need KB tracking (e.g. bare test contexts).
   */
  onKbItemOutcome?: (planItemId: string, status: 'generated' | 'dropped') => void;
  /**
   * Reports one plan item's escape-hatch reasons (the model's own explanation
   * for each `// TODO: unobserved element` marker left in its generated spec)
   * back to the run's Knowledge Base — see storage/schema.ts's
   * escape_hatch_gaps table. Called from generate.ts's recordGenOutcome, the
   * same funnel onKbItemOutcome uses, only when at least one reason was
   * extracted. Optional: undefined for callers/tests that don't need this
   * tracked (e.g. bare test contexts).
   */
  onEscapeHatchGap?: (planItemId: string, unitKey: string | null, reasons: string[]) => void;
  /** Cooperative cancellation for long mode phases (generate/execute). */
  signal?: AbortSignal;
  /**
   * True whenever PLAN's automatic dependency detection found at least one
   * external dependency for this (white-box) project — scaffold() writes a
   * page.route() fixture for 'route-intercept'/'both' dependencies, and
   * generate() directs specs to import test/expect from it instead of
   * '@playwright/test' directly. Always false for black-box projects (no
   * source to scan) or when detection found nothing to mock.
   */
  mockExternalDependencies?: boolean;
  /** Dependencies detected for this run (only set when mockExternalDependencies is true). */
  externalDependencies?: ExternalDependency[];
  /** Resolved canned response per dependency id (see externalDependencies), keyed by ExternalDependency.id. */
  mockResponses?: Record<string, MockResponse>;
  /**
   * Whether the approved plan contains at least one (non-rejected) tierB-auth
   * item. Undefined (not yet known, e.g. in tests that build a bare context)
   * is treated as true — the pre-existing "always scaffold auth-setup"
   * behavior — so this only ever narrows behavior for callers that
   * deliberately set it. See F-18: scaffold() uses this to skip registering
   * the `auth-setup` Playwright project when the plan has no auth surface at
   * all, instead of running it unconditionally and misreporting its
   * "no credentials configured" throw as an ordinary test failure.
   */
  hasTierBAuthPlanItems?: boolean;
}

/** Pluggable test engine. PlaywrightMode ships first; Selenium/XYZ follow. */
export interface TestMode {
  readonly id: ModeId;
  scaffold(ctx: TestModeContext): Promise<void>;
  generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]>;
  /** Pre-execution parse-check gate. Optional — a mode without one is treated as always-valid. */
  validate?(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ValidationResult>;
  execute(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome>;
  collectArtifacts(ctx: TestModeContext): Promise<{ dir: string; files: string[] }>;
  export(ctx: TestModeContext): Promise<SuiteBundle>;
}

/**
 * Thrown by a mode's generate() ONLY when every requested item failed at the
 * provider-communication level — never once got far enough to validate model
 * output. Shared across modes (not Playwright-specific) so the orchestrator
 * can catch it without depending on any one mode's implementation. See
 * orchestrator/checkpoint.ts's classifyTransientFailure for what happens next:
 * this is the signal to checkpoint+pause instead of hard-erroring on what
 * would otherwise look like "verified nothing."
 */
export class ProviderUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ProviderUnavailableError';
  }
}
