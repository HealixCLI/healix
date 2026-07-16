import type {
  AgentEvent,
  OrchestratorEvent,
  PlanApprovalResult,
  ProviderId,
  Run,
  RunSummary,
  SuiteMode,
  TestCase,
  TestPlanItem,
  TestResult,
  TestingScope,
  TestPlan,
} from '@healix/core';

export interface ProviderSummary {
  id: string;
  label: string;
  capabilities: string[];
}

export interface StartRunArgs {
  projectId: string;
  /** What to test — drives tier selection; the underlying exploration
   * mechanism (codegen vs. computer-use) is derived internally. */
  testingScope?: TestingScope;
  provider?: ProviderId;
  autoApprove?: boolean;
  prd?: string;
  /** Suite lifecycle: fresh (default), top-up an existing suite, or reuse one as-is. */
  suiteMode?: SuiteMode;
  /** Pin top-up/reuse to a specific prior run instead of the project's latest passed run. */
  baseRunId?: string;
}

/** Result of attempting to launch a provider's subscription login flow. */
export interface ProviderLoginResult {
  launched: boolean;
  command: string;
  detail: string;
}

/** Result of the native "upload a PRD" file picker (pdf/doc/docx/md/txt). */
export interface PickPrdFileResult {
  canceled: boolean;
  fileName?: string;
  text?: string;
  error?: string;
}

/**
 * Detail bundle for a single historical run (store rows + parsed report.json).
 * `report` is the raw JSON from reports/report.json (unknown — narrow with
 * `asRunReport` before use); the rest mirror the core storage types.
 */
export interface RunDetail {
  run: Run | null;
  tests: TestCase[];
  results: TestResult[];
  events: AgentEvent[];
  report: unknown | null;
  suiteDir: string | null;
  artifacts: string[];
  /** Absolute path to the run's rendered HTML report, when present on disk. */
  reportHtmlPath: string | null;
  /**
   * The plan persisted to disk at plan/plan.json, when present. Used to
   * rebuild the approval gate for a run whose live state was lost (e.g. the
   * Runs view was navigated away from) but that is still genuinely parked
   * awaiting approval in the main process.
   */
  plan: TestPlan | null;
}

/**
 * Structural mirror of @healix/core's RunReport (not exported from the package).
 * Used only to narrow the `unknown` report payload for rendering the triage table.
 */
export interface ReportTriageEntryShape {
  title: string;
  error: string;
  triage: {
    verdict: string;
    confidence: number;
    rationale: string;
    suggestedPatch?: string;
  };
}

export interface RunReportShape {
  triage?: ReportTriageEntryShape[];
  generatedAt?: string;
}

/** Best-effort narrowing of the opaque report.json payload. Returns null when unusable. */
export function asRunReport(value: unknown): RunReportShape | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const triage = Array.isArray(v.triage)
    ? (v.triage.filter(
        (t): t is ReportTriageEntryShape =>
          !!t &&
          typeof t === 'object' &&
          typeof (t as Record<string, unknown>).title === 'string' &&
          !!(t as Record<string, unknown>).triage &&
          typeof (t as Record<string, unknown>).triage === 'object',
      ) as ReportTriageEntryShape[])
    : undefined;
  return {
    triage,
    generatedAt: typeof v.generatedAt === 'string' ? v.generatedAt : undefined,
  };
}

/** Added/carried/removed test counts for one run vs. the run it topped-up/reused from. */
export interface SuiteDiffSummary {
  runId: string;
  baseRunId: string | null;
  addedCount: number;
  carriedCount: number;
  removedCount: number;
  totalCount: number;
}

export interface TestCaseHistoryEntry {
  runId: string;
  runCreatedAt: string;
  suiteMode: SuiteMode | null;
  status: TestCase['status'];
  durationMs: number | null;
  specPath: string | null;
}

/** One test's lineage + pass/fail history, walked backward across a project's top-up/reuse run chain. */
export interface TestCaseHistory {
  identityKey: string;
  currentTitle: string;
  reqTag: string | null;
  runHistory: TestCaseHistoryEntry[];
}

export interface FailureTrendPoint {
  runId: string;
  runCreatedAt: string;
  passed: number;
  failed: number;
  blocked: number;
  total: number;
}

/** Project-level metrics for the dashboard Overview tab. */
export interface ProjectMetrics {
  totalRuns: number;
  lastRunAt: string | null;
  latestRunTestCount: number;
  passRate: number | null;
  failureTrend: FailureTrendPoint[];
}

/** Result of a plan:reviseItem call — the AI-regenerated item, or a surfaced error. */
export type ReviseItemResult = { ok: true; item: TestPlanItem } | { ok: false; detail: string };

/** Re-exported for call sites that only need the approve/cancel decision shape. */
export type { PlanApprovalResult };

/** Result of run:start — either it began executing immediately, or it was queued behind another run. */
export type StartRunResult =
  | { queued: false; summary: RunSummary }
  | { queued: true; queueEntryId: string; position: number };

/** One request waiting in the run queue, as broadcast to every renderer. */
export interface QueuedRunSummary {
  id: string;
  projectId: string;
  projectName: string;
  queuedAt: string;
  testingScope?: TestingScope;
  suiteMode?: SuiteMode;
}

/** The currently-executing run (if any), for a fresh renderer to hydrate its live view against. */
export interface ActiveRunSnapshot {
  runId: string;
  projectId: string;
}

/** Discriminated lifecycle messages delivered to onRunEvent subscribers. */
export type RunChannelMessage =
  | { channel: 'run:started'; payload: { runId: string; projectId: string } }
  | { channel: 'run:event'; payload: { runId: string; event: OrchestratorEvent } }
  | { channel: 'run:plan'; payload: { runId: string; plan: TestPlan } }
  | { channel: 'run:done'; payload: { runId: string; summary: RunSummary } }
  // Live browser mirror frame (JPEG, base64) for computer-use runs.
  | { channel: 'run:frame'; payload: { runId: string; frameBase64: string } }
  // Broadcast to every window whenever the pending-run queue changes.
  | { channel: 'queue:updated'; payload: { queue: QueuedRunSummary[] } };
