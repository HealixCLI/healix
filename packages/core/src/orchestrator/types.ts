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
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  reportPath?: string;
  suite?: SuiteBundle;
  outcome?: ExecOutcome;
}

/** Drives the resumable run lifecycle: plan → approve → explore → generate → execute → triage → report → export. */
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
