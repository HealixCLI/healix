/// <reference types="vite/client" />
import type { DoctorReport, Project, NewProject, RunSummary, SuiteBundle } from '@healix/core';
import type {
  ProviderSummary,
  StartRunArgs,
  RunChannelMessage,
} from './lib/ipc-types';

export interface HealixBridge {
  doctor: (args?: { probe?: boolean }) => Promise<DoctorReport>;
  providers: () => Promise<ProviderSummary[]>;

  listProjects: () => Promise<Project[]>;
  createProject: (input: NewProject) => Promise<Project>;
  deleteProject: (id: string) => Promise<{ ok: true }>;

  startRun: (args: StartRunArgs) => Promise<RunSummary>;
  approveRun: (runId: string, ok: boolean) => Promise<{ settled: boolean }>;

  exportSuite: (args: {
    suiteDir: string;
    outDir?: string;
    sanitize?: boolean;
    zip?: boolean;
  }) => Promise<SuiteBundle>;
  revealPath: (target: string) => Promise<{ ok: boolean }>;

  onRunEvent: (cb: (msg: RunChannelMessage) => void) => () => void;
}

declare global {
  interface Window {
    healix: HealixBridge;
  }
}
