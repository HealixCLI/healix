import type { ProviderAdapter } from '../providers/types.js';
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
  /** Real endpoints observed on the wire during the crawl — see GAP-046 and
   * `browser/network-capture.ts`'s `collectObservedEndpoints()`. */
  observedEndpoints: ObservedEndpoint[];
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
  | 'disabled-button-race-risk';

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

export interface ExecResultItem {
  title: string;
  status: TestStatus;
  durationMs?: number;
  error?: string;
  artifacts?: string[];
}

export interface ExecOutcome {
  passed: number;
  failed: number;
  blocked: number;
  flaky: number;
  results: ExecResultItem[];
  raw?: unknown;
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
}

/** Pluggable test engine. PlaywrightMode ships first; Selenium/XYZ follow. */
export interface TestMode {
  readonly id: ModeId;
  scaffold(ctx: TestModeContext): Promise<void>;
  generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]>;
  /** Pre-execution parse-check gate. Optional — a mode without one is treated as always-valid. */
  validate?(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ValidationResult>;
  execute(ctx: TestModeContext, specs: GeneratedSpec[], opts?: { onlyTier?: Tier }): Promise<ExecOutcome>;
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
