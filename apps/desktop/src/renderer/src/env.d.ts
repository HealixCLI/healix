/// <reference types="vite/client" />
import type {
  DoctorReport,
  HealthResult,
  Project,
  NewProject,
  ProviderId,
  Run,
  RunSummary,
  SuiteBundle,
} from '@healix/core';
import type {
  ProviderLoginResult,
  ProviderSummary,
  RunDetail,
  StartRunArgs,
  RunChannelMessage,
} from './lib/ipc-types';

export interface HealixBridge {
  doctor: (args?: { probe?: boolean }) => Promise<DoctorReport>;
  providers: () => Promise<ProviderSummary[]>;

  listProjects: () => Promise<Project[]>;
  createProject: (input: NewProject) => Promise<Project>;
  deleteProject: (id: string) => Promise<{ ok: true; assetsRemoved: boolean }>;
  archiveProject: (id: string, archived: boolean) => Promise<{ ok: true }>;

  startRun: (args: StartRunArgs) => Promise<RunSummary>;
  approveRun: (runId: string, ok: boolean) => Promise<{ settled: boolean }>;
  cancelRun: (runId: string) => Promise<{ cancelled: boolean }>;

  exportSuite: (args: {
    suiteDir: string;
    outDir?: string;
    sanitize?: boolean;
    zip?: boolean;
  }) => Promise<SuiteBundle>;
  revealPath: (target: string) => Promise<{ ok: boolean }>;
  showItemInFolder: (target: string) => Promise<{ ok: boolean }>;

  // ---- provider connect / live health ----
  providerLogin: (id: ProviderId) => Promise<ProviderLoginResult>;
  providerHealth: (id: ProviderId, probe?: boolean) => Promise<HealthResult>;

  // ---- run history ----
  listRuns: (projectId?: string) => Promise<Run[]>;
  runDetail: (runId: string) => Promise<RunDetail>;

  onRunEvent: (cb: (msg: RunChannelMessage) => void) => () => void;
}

declare global {
  interface Window {
    healix: HealixBridge;
  }
}
