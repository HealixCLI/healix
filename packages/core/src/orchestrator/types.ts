import type { ProviderAdapter, ProviderId } from '../providers/types.js';
import type { ModeId, RunStatus } from '../storage/types.js';
import type { ExecOutcome, ExplorationMode, SuiteBundle, TestMode, TestPlan } from '../modes/types.js';
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
  explorationMode?: ExplorationMode;
  /** Skip the human approval gate (e.g. CI). */
  autoApprove?: boolean;
  /** Optional PRD / acceptance-criteria text to ground generation. */
  prd?: string;
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

/** Returns true to approve the proposed plan, false to abort. */
export type ApprovalGate = (plan: TestPlan) => Promise<boolean>;

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
 * triage → report → export. Every phase is checkpointed to SQLite; resuming an
 * interrupted run is not implemented (a new run must be started).
 */
export interface Orchestrator {
  run(opts: RunOptions, hooks?: OrchestratorHooks): Promise<RunSummary>;
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
}
