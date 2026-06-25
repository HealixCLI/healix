import type {
  ExplorationMode,
  OrchestratorEvent,
  ProviderId,
  RunSummary,
  TestPlan,
} from '@healix/core';

export interface ProviderSummary {
  id: string;
  label: string;
  capabilities: string[];
}

export interface StartRunArgs {
  projectId: string;
  mode?: ExplorationMode;
  provider?: ProviderId;
  autoApprove?: boolean;
  prd?: string;
}

/** Discriminated lifecycle messages delivered to onRunEvent subscribers. */
export type RunChannelMessage =
  | { channel: 'run:started'; payload: { runId: string; projectId: string } }
  | { channel: 'run:event'; payload: { runId: string; event: OrchestratorEvent } }
  | { channel: 'run:plan'; payload: { runId: string; plan: TestPlan } }
  | { channel: 'run:done'; payload: { runId: string; summary: RunSummary } };
