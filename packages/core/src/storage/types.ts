import type { ProviderId } from '../providers/types.js';

/** Test-engine identifier (Playwright first; Selenium/XYZ later). */
export type ModeId = 'playwright' | 'selenium' | (string & {});

export type AccessKind = 'white-box' | 'black-box';

/**
 * How a credential establishes its session:
 *  - 'form': the existing username/password + login-page-form flow.
 *  - 'url-token': no login form at all — the app authenticates a visit whose
 *    URL already carries a token (and optionally other params, e.g. a mobile
 *    number/locale), persisting it to localStorage/cookies on first load.
 *    Common in SPAs that are handed a deep link rather than a login page.
 */
export type CredentialAuthType = 'form' | 'url-token';

/**
 * One login identity for authenticated (tierB) test flows. A project can have
 * any number of these — e.g. an "admin" and a "customer" account for an app
 * with distinct roles. `role` is optional free text (not a fixed enum): when
 * set, Healix establishes a SEPARATE storageState for that credential and
 * generated tests can opt into it by name; the first credential with no role
 * (or simply the first one, if none is roleless) is the default session Tier
 * B tests get automatically, unchanged from today's single-credential behavior.
 */
export interface ProjectCredential {
  id: string;
  authType: CredentialAuthType;
  role: string | null;
  /** Used when authType is 'form'; empty string when 'url-token'. */
  username: string;
  /** Stored locally, same as repoPath/baseUrl — never sent to the AI provider. */
  password: string;
  /** Used when authType is 'url-token' — stored/decrypted like password. */
  token: string | null;
  /**
   * The path/fragment to visit, with `{token}` and `{<extraParams key>}`
   * placeholders substituted in — e.g. `#/token={token}&mobile={mobile}&lang=ar-sa`.
   * Resolved against the project's baseUrl.
   */
  urlTemplate: string | null;
  /** Additional named values substitutable into urlTemplate (e.g. { mobile: '9660456767657' }). */
  extraParams: Record<string, string> | null;
  /**
   * Optional text Healix waits to see DISAPPEAR after navigating (e.g. a
   * transient "Not found"/loading message the app shows before the token
   * resolves) — a best-effort signal that authentication actually landed,
   * not a hard gate: storageState is still captured either way.
   */
  authCheckText: string | null;
}

export interface Project {
  id: string;
  name: string;
  mode: ModeId;
  repoPath: string | null;
  baseUrl: string | null;
  createdAt: string;
  /** Soft-archive timestamp; null = active. Archived projects keep all data. */
  archivedAt: string | null;
  /** Test login identities for authenticated (tierB) flows — see ProjectCredential. */
  credentials: ProjectCredential[];
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
  /** The specific scenario's plan-time text (PlanScenario.description) — what this test verifies. Null when no scenario data was available. */
  description: string | null;
  /** The broader feature intent (TestPlanItem.intent) this test belongs to — why it exists. Null when no plan item was matched. */
  details: string | null;
}

export interface TestResult {
  id: string;
  testId: string;
  status: TestStatus;
  durationMs: number | null;
  error: string | null;
  artifactsJson: string | null;
  /** Mirrors the parent TestCase's description at result-persist time. */
  description: string | null;
  /** Mirrors the parent TestCase's details at result-persist time. */
  details: string | null;
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

/** Input shape for a single credential when creating/updating a project — no id yet, assigned on persist. */
export interface NewProjectCredential {
  authType?: CredentialAuthType;
  username?: string;
  password?: string;
  role?: string | null;
  token?: string | null;
  urlTemplate?: string | null;
  extraParams?: Record<string, string> | null;
  authCheckText?: string | null;
}

export interface NewProject {
  name: string;
  mode?: ModeId;
  repoPath?: string | null;
  baseUrl?: string | null;
  /** Replace-all semantics: the full desired credential set, not a delta. Omitted = leave/create with none. */
  credentials?: NewProjectCredential[];
}
