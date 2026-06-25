import type { ProviderId } from '../providers/types.js';

/** Test-engine identifier (Playwright first; Selenium/XYZ later). */
export type ModeId = 'playwright' | 'selenium' | (string & {});

export type AccessKind = 'white-box' | 'black-box';

export interface Project {
  id: string;
  name: string;
  mode: ModeId;
  repoPath: string | null;
  baseUrl: string | null;
  createdAt: string;
}

export type RunStatus =
  | 'pending'
  | 'planning'
  | 'awaiting-approval'
  | 'exploring'
  | 'generating'
  | 'executing'
  | 'triaging'
  | 'reporting'
  | 'passed'
  | 'failed'
  | 'error'
  | 'cancelled';

export interface Run {
  id: string;
  projectId: string;
  status: RunStatus;
  provider: ProviderId | null;
  mode: ModeId | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export type Tier = 'tierA-public' | 'tierB-auth' | 'tierC-api' | (string & {});
export type TestStatus = 'passed' | 'failed' | 'blocked' | 'flaky' | 'skipped' | 'pending';

export interface TestCase {
  id: string;
  runId: string;
  title: string;
  reqTag: string | null;
  tier: Tier | null;
  status: TestStatus | null;
}

export interface TestResult {
  id: string;
  testId: string;
  status: TestStatus;
  durationMs: number | null;
  error: string | null;
  artifactsJson: string | null;
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AgentEvent {
  id: string;
  runId: string;
  phase: string;
  level: EventLevel;
  message: string;
  dataJson: string | null;
  createdAt: string;
}

export interface NewProject {
  name: string;
  mode?: ModeId;
  repoPath?: string | null;
  baseUrl?: string | null;
}
