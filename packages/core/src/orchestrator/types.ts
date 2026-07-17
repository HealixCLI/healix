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
   * still-passing test from the base run, copying that test's spec file forward
   * instead; 'reuse' skips planning/generation entirely and re-executes the base
   * run's passing tests as-is.
   */
  suiteMode?: SuiteMode;
  /**
   * Pin top-up/reuse to a specific prior run instead of auto-resolving to the
   * project's most recent 'passed' run.
   */
  baseRunId?: string;
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
