import type { ProviderAdapter, ProviderId } from '../providers/types.js';
import type { ModeId, RunStatus, SuiteMode } from '../storage/types.js';
import type {
  ExecOutcome,
  ExplorationMode,
  SuiteBundle,
  TestingScope,
  TestMode,
  TestPlan,
} from '../modes/types.js';
import type { TargetAdapter } from '../target/types.js';
import type { BrowserSurface } from '../browser/types.js';
import type { HealixStore } from '../storage/store.js';

export type OrchestratorPhase =
  | 'plan'
  | 'approve'
  | 'explore'
  | 'generate'
  | 'execute'
  | 'triage'
  | 'report'
  | 'export'
  | 'done';

export interface RunOptions {
  projectId: string;
  provider?: ProviderId;
  /**
   * Which tiers to plan/generate/execute. The user-facing control — replaces
   * choosing ExplorationMode directly. Defaults to 'both' (all tiers, current
   * behavior) when omitted.
   */
  testingScope?: TestingScope;
  /**
   * How to explore/ground generation (white-box repo reading vs. black-box
   * live browser). No longer a user choice: when omitted, the orchestrator
   * derives it from the project's repoPath/baseUrl. Still overridable
   * explicitly (tests, CLI) for callers that want to force one.
   */
  explorationMode?: ExplorationMode;
  /** Skip the human approval gate (e.g. CI). */
  autoApprove?: boolean;
  /** Optional PRD / acceptance-criteria text to ground generation. */
  prd?: string;
  /** How the `prd` text was produced — free typing, a prose file upload, or a parsed spreadsheet. */
  prdSourceKind?: 'text' | 'file' | 'spreadsheet';
  /** Original uploaded file name, when `prd` came from a file/spreadsheet upload. */
  prdFileName?: string;
  /** Sheet names included in `prd`, when `prdSourceKind` is 'spreadsheet'. */
  prdSelectedSheets?: string[];
  /**
   * Freeform additional instructions from the user, steering HOW the plan is
   * built rather than describing WHAT the app does (that's the PRD's job) —
   * e.g. "focus on accessibility", "skip mobile viewport checks", "prefer
   * data-testid selectors". Passed to the planning provider verbatim.
   */
  instructions?: string;
  /**
   * Suite lifecycle strategy: 'fresh' regenerates everything (default, current
   * behavior, byte-identical when omitted); 'topup' plans as normal but skips
   * AI-generating any item that matches (by reqTag, else normalized title) a
   * test from the base run — regardless of that test's prior status — copying
   * its spec file forward instead; 'reuse' skips planning/generation entirely
   * and re-executes every test from the base run as-is.
   */
  suiteMode?: SuiteMode;
  /**
   * Pin top-up/reuse to a specific prior run instead of auto-resolving to the
   * project's most recent 'passed' run.
   */
  baseRunId?: string;
  /**
   * Opt-in for the coverage feedback loop's ITERATIVE re-plan/generate/execute
   * retry (see index.ts's "COVERAGE FEEDBACK LOOP" section) — off by default,
   * since each iteration can add a full extra plan+generate+execute cycle (up
   * to COVERAGE_MAX_ITERATIONS). Coverage is still MEASURED once regardless of
   * this flag (the report always needs a real number to show); this only gates
   * whether the loop retries to chase the target higher. No effect in 'reuse'
   * mode, which never plans/generates at all.
   */
  coverageLoopEnabled?: boolean;
  /**
   * Overrides the coverage loop's target ratio (0-1) when coverageLoopEnabled
   * is true. Defaults to FRESH_COVERAGE_TARGET/TOPUP_COVERAGE_TARGET (coverage.ts)
   * per suiteMode when omitted.
   */
  coverageTarget?: number;
  /**
   * Targeted regeneration for results-page "Retry-pass"/"Repair" actions:
   * when set (requires suiteMode 'topup' and a resolvable base run), planning
   * skips AI entirely and reuses ONLY the base run's plan items whose id is
   * in this list, instead of the full re-plan. Generation's existing
   * base-run diff (topup.ts's diffAgainstBase) then naturally regenerates
   * just those items and carries everything else forward untouched. Ids that
   * don't match anything in the base plan are silently ignored; if none
   * match at all, falls back to a full re-plan.
   */
  retryItemIds?: string[];
  /**
   * Proactive spend ceiling(s) for this run's AI usage. Checked after every
   * recorded usage row (plan/gap-fill plan, generate, triage); once running
   * cost/tokens for the run reaches either configured limit, the run pauses
   * cleanly (pauseReason: 'budget-exceeded') before its next PLAN/GENERATE/
   * TRIAGE dispatch — the same clean checkpoint-and-stop path a manual pause
   * uses — rather than continuing to spend unbounded. Either knob alone is
   * enough to trip the ceiling; omit both to run with no ceiling (default).
   */
  maxCostUsd?: number;
  /** Combined input+output token ceiling — see maxCostUsd. */
  maxTokens?: number;
  /**
   * Overrides EXPLORE's crawl budget (see browser/crawler.ts's CrawlOptions) for this run —
   * `maxRoutes` (default 60) and/or `wallClockBudgetMs` (default 90_000). Either can be set
   * independently; omit both to use the crawler's own defaults. Useful for a larger app whose
   * real route-cluster count exceeds the default cap.
   */
  crawlBudget?: { maxRoutes?: number; wallClockBudgetMs?: number };
  /**
   * Cooperative cancellation. When aborted, the run stops at the next phase
   * boundary (and in-flight provider/suite work is killed), the run row is
   * marked 'cancelled', and run() resolves with that summary — it never rejects.
   */
  signal?: AbortSignal;
}

export interface OrchestratorEvent {
  phase: OrchestratorPhase | string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

/**
 * The finalized outcome of per-item plan review: 'proceed' carries the plan
 * as the reviewer left it (items may be approved/rejected/edited/revised —
 * see TestPlanItem.status), 'cancel' aborts the run entirely.
 */
export type PlanApprovalResult = { decision: 'proceed'; plan: TestPlan } | { decision: 'cancel' };

/** Presents the proposed plan to a human reviewer and returns their finalized decision. */
export type ApprovalGate = (plan: TestPlan) => Promise<PlanApprovalResult>;

export interface OrchestratorHooks {
  onEvent?: (e: OrchestratorEvent) => void;
  onPlan?: ApprovalGate;
  /** Receives live browser frames (PNG) during computer-use exploration, for UI mirroring. */
  onFrame?: (png: Buffer) => void;
  /**
   * Fires once, immediately after the orchestrator creates the canonical run row,
   * so callers can correlate events/approval to the real runId WITHOUT pre-creating
   * a duplicate run of their own.
   */
  onRunCreated?: (runId: string) => void;
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  reportPath?: string;
  suite?: SuiteBundle;
  outcome?: ExecOutcome;
}

/**
 * Drives the run lifecycle: plan → approve → explore → generate → execute →
 * triage → report → export. Every phase is checkpointed to SQLite. A run that
 * pauses (manually, or automatically on a network/credits interruption) also
 * leaves a `checkpoint.json` (see orchestrator/checkpoint.ts) that `resume()`
 * uses to continue without re-planning or redoing already-generated/executed
 * work — see resume()'s own doc comment for exactly what is/isn't redone.
 */
export interface Orchestrator {
  run(opts: RunOptions, hooks?: OrchestratorHooks): Promise<RunSummary>;
  /**
   * Continue a paused run from its last checkpoint. Redoes the cheap phases
   * (launch/explore) from scratch but skips already-generated specs and
   * already-completed execution tiers. Fails with status 'error' if the run
   * has no checkpoint (nothing to resume from).
   */
  resume(runId: string, hooks?: OrchestratorHooks, signal?: AbortSignal): Promise<RunSummary>;
}

/**
 * Dependency-injection seam for testability. Every field is optional; when a
 * field is omitted the orchestrator resolves the same default it uses today, so
 * `createOrchestrator()` with no overrides behaves exactly as before.
 */
export interface OrchestratorOverrides {
  /** When set, used directly for all provider work (bypasses ProviderRouter). */
  provider?: ProviderAdapter;
  /** Resolve a test mode by id. Default: getTestMode. */
  getMode?: (id: ModeId) => TestMode;
  /** Construct the target adapter. Default: createTargetAdapter. */
  makeTarget?: () => TargetAdapter;
  /** Construct the browser surface. Default: createBrowserSurface. */
  makeBrowser?: () => BrowserSurface;
  /** Persistence store. Default: await getStore(). */
  store?: HealixStore;
  /**
   * Run an external CLI (used by launch recovery to install dependencies).
   * Default: runCli. Injectable so tests can observe/stub the install rung.
   */
  execCli?: (
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; cwd?: string },
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}
