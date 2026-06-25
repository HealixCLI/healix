import type { ProviderId } from '../providers/types.js';
import type { RunStatus } from '../storage/types.js';
import type { ExecOutcome, ExplorationMode, SuiteBundle, TestPlan } from '../modes/types.js';

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
