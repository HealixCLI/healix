/// <reference types="vite/client" />
import type {
  DoctorReport,
  HealthResult,
  PlanApprovalResult,
  Project,
  NewProject,
  ProviderId,
  Run,
  RunSummary,
  SuiteBundle,
  TestPlanItem,
} from '@healix/core';
import type {
  ActiveRunSnapshot,
  PickPrdFileResult,
  ProviderLoginResult,
  ProviderSummary,
  QueuedRunSummary,
  ReviseItemResult,
  RunDetail,
  StartRunArgs,
  StartRunResult,
  RunChannelMessage,
  SuiteDiffSummary,
  TestCaseHistory,
  ProjectMetrics,
} from './lib/ipc-types';

export interface HealixBridge {
  doctor: (args?: { probe?: boolean }) => Promise<DoctorReport>;
  providers: () => Promise<ProviderSummary[]>;

  listProjects: () => Promise<Project[]>;
  createProject: (input: NewProject) => Promise<Project>;
  updateProject: (id: string, input: NewProject) => Promise<Project>;
  deleteProject: (id: string) => Promise<{ ok: true; assetsRemoved: boolean }>;
  archiveProject: (id: string, archived: boolean) => Promise<{ ok: true }>;

  startRun: (args: StartRunArgs) => Promise<StartRunResult>;
  approveRun: (runId: string, decision: PlanApprovalResult) => Promise<{ settled: boolean }>;
  cancelRun: (runId: string) => Promise<{ cancelled: boolean }>;
  pauseRun: (runId: string) => Promise<{ paused: boolean }>;
  resumeRun: (
    runId: string,
  ) => Promise<{ resumed: true; summary: RunSummary } | { resumed: false; reason: string }>;
  getActiveRun: () => Promise<ActiveRunSnapshot | null>;

  // ---- run queue ----
  listQueue: () => Promise<QueuedRunSummary[]>;
  queueRemove: (queueEntryId: string) => Promise<{ removed: boolean }>;

  // ---- per-item plan revision ----
  reviseItem: (args: {
    projectId: string;
    item: TestPlanItem;
    suggestion: string;
  }) => Promise<ReviseItemResult>;

  exportSuite: (args: {
    suiteDir: string;
    outDir?: string;
    sanitize?: boolean;
    zip?: boolean;
  }) => Promise<SuiteBundle>;
  revealPath: (target: string) => Promise<{ ok: boolean }>;
  showItemInFolder: (target: string) => Promise<{ ok: boolean }>;

  // ---- PRD file upload ----
  pickPrdFile: () => Promise<PickPrdFileResult>;

  // ---- provider connect / live health ----
  providerLogin: (id: ProviderId) => Promise<ProviderLoginResult>;
  providerHealth: (id: ProviderId, probe?: boolean) => Promise<HealthResult>;

  // ---- run history ----
  listRuns: (projectId?: string) => Promise<Run[]>;
  runDetail: (runId: string) => Promise<RunDetail>;
  lastSuccessfulRun: (projectId: string) => Promise<Run | null>;
  suiteDiff: (runId: string) => Promise<SuiteDiffSummary | null>;
  caseHistory: (projectId: string, key: { reqTag?: string; title?: string }) => Promise<TestCaseHistory>;
  projectMetrics: (projectId: string) => Promise<ProjectMetrics | null>;

  onRunEvent: (cb: (msg: RunChannelMessage) => void) => () => void;
}

declare global {
  interface Window {
    healix: HealixBridge;
  }
}
