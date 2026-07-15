import type { ProviderAdapter } from '../providers/types.js';
import type { TargetAdapter } from '../target/types.js';
import type { BrowserSurface, DomSnapshot } from '../browser/types.js';
import type { ModeId, Tier, TestStatus } from '../storage/types.js';

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
  /** Login identifier (username or email) for authenticated (tierB) flows. */
  testUsername?: string | null;
  testPassword?: string | null;
  provider: ProviderAdapter;
  target: TargetAdapter;
  browser: BrowserSurface;
  explorationMode?: ExplorationMode;
  /** Which tiers this run is in scope for; drives generation and execution. */
  testingScope?: TestingScope;
  /** DOM snapshot captured during computer-use exploration; grounds generation. */
  snapshot?: DomSnapshot;
  emit?: (phase: string, message: string, data?: unknown) => void;
  /** Cooperative cancellation for long mode phases (generate/execute). */
  signal?: AbortSignal;
}

/** Pluggable test engine. PlaywrightMode ships first; Selenium/XYZ follow. */
export interface TestMode {
  readonly id: ModeId;
  scaffold(ctx: TestModeContext): Promise<void>;
  generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]>;
  execute(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome>;
  collectArtifacts(ctx: TestModeContext): Promise<{ dir: string; files: string[] }>;
  export(ctx: TestModeContext): Promise<SuiteBundle>;
}
