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
  /** Soft-archive timestamp; null = active. Archived projects keep all data. */
  archivedAt: string | null;
  /** Login identifier (username or email) for authenticated (tierB) test flows. */
  testUsername: string | null;
  /** Password paired with testUsername. Stored locally, same as repoPath/baseUrl — never sent to the AI provider. */
  testPassword: string | null;
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
  /** Terminal: nothing failed, but ≥1 test was blocked (prerequisite such as Tier-B auth not met) — NOT a green run. */
  | 'blocked'
  | 'error'
  | 'cancelled'
  /**
   * Stopped short of a verdict, but resumable from a checkpoint (see
   * orchestrator/checkpoint.ts) — NOT terminal. Never reaped by
   * failOrphanedRuns(); see `pauseReason` for why it's here and whether it's
   * eligible for automatic resume.
   */
  | 'paused';

/**
 * Why a 'paused' run stopped. 'manual' is the only reason boot-time
 * reconciliation must never auto-resume — the user paused it on purpose and
 * must explicitly resume it themselves. The other three are transient
 * interruptions Healix can safely retry on its own.
 */
export type PauseReason = 'manual' | 'network' | 'credits-exhausted' | 'crashed';

/** How a run's suite was produced: fully regenerated, topped-up from a prior run, or re-executed as-is. */
export type SuiteMode = 'fresh' | 'topup' | 'reuse';

export interface Run {
  id: string;
  projectId: string;
  status: RunStatus;
  provider: ProviderId | null;
  mode: ModeId | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** Null for runs predating this feature. */
  suiteMode: SuiteMode | null;
  /** The prior run this one topped-up/reused from, if any. */
  baseRunId: string | null;
  /** Set only when status is 'paused'; null otherwise (including for runs predating this feature). */
  pauseReason: PauseReason | null;
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
  /** Relative path of this test's generated spec file within its own run's suite dir (e.g. 'tests/tierA-public/login.spec.ts'). Null for legacy rows. */
  specPath: string | null;
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
  testUsername?: string | null;
  testPassword?: string | null;
}
