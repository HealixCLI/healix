import type { ProviderId } from '../providers/types.js';
import type { Verdict } from '../triage/types.js';

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
 * Why a 'paused' run stopped. 'manual' and 'budget-exceeded' are the reasons
 * boot-time reconciliation must never auto-resume — the user paused it on
 * purpose, or a self-imposed spend ceiling was reached and blindly resuming
 * would just hit the same ceiling again on the very next dispatch, so both
 * need a human decision (resume as-is, or raise the ceiling) rather than an
 * automatic retry. The other two ('network', 'credits-exhausted') are
 * transient interruptions Healix can safely retry on its own.
 */
export type PauseReason = 'manual' | 'network' | 'credits-exhausted' | 'crashed' | 'budget-exceeded';

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
  /** The generated spec file's full source (GeneratedSpec.contents) at GENERATE time — null for rows predating this column, or a fallback row with no known spec. */
  specCode: string | null;
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
  /** JSON array of {title, durationMs, error?} — the action/assertion steps Playwright performed. Null for older rows or when the reporter produced none. */
  stepsJson: string | null;
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

/** One captured provider.complete() call's token/cost usage within a run. */
export interface UsageRow {
  id: string;
  runId: string;
  phase: string;
  /** Human label scoping this row within its phase (e.g. a spec item's title, or 'gap-fill'). Null when the call site has none. */
  task: string | null;
  provider: ProviderId;
  /** Null when the provider/call reported no usage (e.g. a timeout, or a provider that doesn't report usage). */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Null when the call reported no cache activity at all (not every call writes to or reads from Anthropic's prompt cache). */
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  /** The dominant modelUsage entry (by input+output tokens) that served this call, e.g. 'claude-sonnet-5'. Null when the call reported no usage at all. */
  model: string | null;
  createdAt: string;
}

/** Input shape for recordUsage — id/createdAt are assigned on persist. */
export interface NewUsage {
  runId: string;
  phase: string;
  task?: string | null;
  provider: ProviderId;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  model?: string | null;
}

/** One run's total usage — a row in the Reports/Usage page's cross-run table. */
export interface UsageRunSummary {
  runId: string;
  runCreatedAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

/** One phase's usage aggregated across every run in scope — the Reports/Usage page's per-phase averages. */
export interface UsagePhaseSummary {
  phase: string;
  callCount: number;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  avgCostUsd: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCostUsd: number | null;
  avgCacheCreationInputTokens: number | null;
  avgCacheReadInputTokens: number | null;
  totalCacheCreationInputTokens: number | null;
  totalCacheReadInputTokens: number | null;
}

/** One model's usage aggregated across every run in scope — the Reports/Usage page's per-model totals. */
export interface UsageModelSummary {
  model: string;
  callCount: number;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  avgCostUsd: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCostUsd: number | null;
  avgCacheCreationInputTokens: number | null;
  avgCacheReadInputTokens: number | null;
  totalCacheCreationInputTokens: number | null;
  totalCacheReadInputTokens: number | null;
}

export interface UsageAggregate {
  perRun: UsageRunSummary[];
  perPhase: UsagePhaseSummary[];
  perModel: UsageModelSummary[];
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

/**
 * One triage verdict, FK-keyed to the `tests` row it's about (unlike
 * report.json's ReportTriageEntry, which is joined back to a result by
 * fuzzy title matching). Additive alongside report.json — not a replacement
 * — so existing title-joined report rendering is untouched; this is what
 * lets Repair/Fix-up (a later results-page action) query "which tests in
 * this run were triaged test_is_wrong" directly instead of re-deriving it.
 */
export interface TriageResultRow {
  id: string;
  testId: string;
  verdict: Verdict;
  confidence: number;
  rationale: string;
  suggestedPatch: string | null;
  createdAt: string;
}

/** Input shape for recordTriageResult — id/createdAt are assigned on persist. */
export interface NewTriageResult {
  testId: string;
  verdict: Verdict;
  confidence: number;
  rationale: string;
  suggestedPatch?: string | null;
}
