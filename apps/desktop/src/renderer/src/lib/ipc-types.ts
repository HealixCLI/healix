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
  UsageRow,
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
  /**
   * Freeform additional instructions from the user, steering HOW the plan is
   * built (e.g. "focus on accessibility", "prefer data-testid selectors") —
   * distinct from the PRD, which describes WHAT the app does.
   */
  instructions?: string;
  /** How `prd` was produced — free typing, a prose file upload, or a parsed spreadsheet. */
  prdSourceKind?: 'text' | 'file' | 'spreadsheet';
  /** Original uploaded file name, when `prd` came from a file/spreadsheet upload. */
  prdFileName?: string;
  /** Sheet names included in `prd`, when `prdSourceKind` is 'spreadsheet'. */
  prdSelectedSheets?: string[];
  /** Suite lifecycle: fresh (default), top-up an existing suite, or reuse one as-is. */
  suiteMode?: SuiteMode;
  /** Pin top-up/reuse to a specific prior run instead of the project's latest passed run. */
  baseRunId?: string;
  /**
   * Opt-in for the coverage feedback loop's iterative re-plan/generate/execute
   * retry — off by default (each iteration can add a full extra cycle, up to
   * 4). Coverage is still measured once regardless; this only gates whether
   * the loop retries to chase the target higher. No effect for suiteMode 'reuse'.
   */
  coverageLoopEnabled?: boolean;
  /** Overrides the coverage loop's target ratio (0-1) when coverageLoopEnabled is true. */
  coverageTarget?: number;
  /**
   * Targeted regeneration for the results-page Retry-pass/Repair actions:
   * when set (requires suiteMode 'topup'), only these base-run plan item ids
   * are regenerated — everything else is carried forward untouched.
   */
  retryItemIds?: string[];
}

/** Result of attempting to launch a provider's subscription login flow. */
export interface ProviderLoginResult {
  launched: boolean;
  command: string;
  detail: string;
}

/** Header-only preview of one worksheet, cheap enough to compute for every sheet in a workbook. */
export interface SheetPreview {
  name: string;
  rowCount: number;
  /** First ~8 column headers, truncated with an ellipsis marker if the sheet is wider. */
  headers: string[];
}

/** Result of the native "upload a PRD" file picker (pdf/doc/docx/md/txt/xlsx/xls/csv). */
export interface PickPrdFileResult {
  canceled: boolean;
  fileName?: string;
  text?: string;
  error?: string;
  /** True only when the workbook has more than one non-empty sheet and the renderer must show a picker. */
  needsSheetPicker?: boolean;
  /** Present alongside needsSheetPicker so the follow-up extractPrdSheets call knows which file to reread. */
  filePath?: string;
  /** Preview of every non-empty sheet, present alongside needsSheetPicker. */
  sheets?: SheetPreview[];
  /** Present when text came from a spreadsheet (single-sheet fast path or after picker selection). */
  sourceKind?: 'file' | 'spreadsheet';
  selectedSheets?: string[];
  /** Non-fatal notes (e.g. row-cap truncation) — distinct from `error`, which means the upload failed outright. */
  warnings?: string[];
}

/** Result of previewing an already-picked spreadsheet's sheets (re-opening the picker). */
export interface PreviewPrdSheetsResult {
  sheets?: SheetPreview[];
  error?: string;
}

/** Result of extracting the user's selected sheets from an already-picked spreadsheet. */
export interface ExtractPrdSheetsResult {
  sheets?: { name: string; content: string }[];
  warnings?: string[];
  error?: string;
}

/** Result of the native folder picker used to browse for a project's repo path. */
export interface PickRepoPathResult {
  canceled: boolean;
  path?: string;
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
  /**
   * The user-facing options (testingScope/suiteMode/provider/prd/instructions)
   * this run was started with, read from run-config.json — null when absent
   * (a run from before this feature existed, or the write failed).
   */
  runConfig: RunConfigSnapshot | null;
  /** Per-call token/cost usage captured during this run (plan/generate/triage) — feeds the Usage tab. */
  usage: UsageRow[];
}

/** The options a run was started with, permanently recorded (unlike the pausable checkpoint). */
export interface RunConfigSnapshot {
  testingScope?: TestingScope;
  suiteMode?: SuiteMode;
  provider?: ProviderId;
  prd?: string;
  instructions?: string;
  /** How `prd` was produced — free typing, a prose file upload, or a parsed spreadsheet. */
  prdSourceKind?: 'text' | 'file' | 'spreadsheet';
  /** Original uploaded file name, when `prd` came from a file/spreadsheet upload. */
  prdFileName?: string;
  /** Sheet names included in `prd`, when `prdSourceKind` is 'spreadsheet'. */
  prdSelectedSheets?: string[];
  /** Whether the coverage feedback loop's iterative retry was enabled for this run. */
  coverageLoopEnabled?: boolean;
  /** The coverage target this run used, when coverageLoopEnabled. */
  coverageTarget?: number;
  /** Plan item ids this run targeted for regeneration (Retry-pass/Repair), when set. */
  retryItemIds?: string[];
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
    /** 'ai_reviewed' | 'rule_fallback' — whether this verdict came from a genuine AI review or fell back to the deterministic rule baseline. */
    verdictSource?: string;
  };
}

export interface RunReportShape {
  triage?: ReportTriageEntryShape[];
  generatedAt?: string;
  /** Mirrors TestPlan.planSource/fallbackReason — see @healix/core's TestPlan. */
  planSource?: 'ai' | 'fallback' | 'reuse';
  fallbackReason?: string;
  generation?: { requestedItems: number; acceptedItems: number };
  coverage?: { ratio: number; target: number } | null;
  /** End-of-run AI synthesis across every triaged failure — see @healix/core's triage/grouping.ts. */
  groupingSummary?: string | null;
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
  const plan = v.plan && typeof v.plan === 'object' ? (v.plan as Record<string, unknown>) : undefined;
  const generation =
    v.generation && typeof v.generation === 'object' ? (v.generation as Record<string, unknown>) : undefined;
  const coverage =
    v.coverage && typeof v.coverage === 'object' ? (v.coverage as Record<string, unknown>) : undefined;
  return {
    triage,
    generatedAt: typeof v.generatedAt === 'string' ? v.generatedAt : undefined,
    planSource:
      plan && (plan.planSource === 'ai' || plan.planSource === 'fallback' || plan.planSource === 'reuse')
        ? plan.planSource
        : undefined,
    fallbackReason: plan && typeof plan.fallbackReason === 'string' ? plan.fallbackReason : undefined,
    generation:
      generation &&
      typeof generation.requestedItems === 'number' &&
      typeof generation.acceptedItems === 'number'
        ? { requestedItems: generation.requestedItems, acceptedItems: generation.acceptedItems }
        : undefined,
    coverage:
      coverage && typeof coverage.ratio === 'number' && typeof coverage.target === 'number'
        ? { ratio: coverage.ratio, target: coverage.target }
        : null,
    groupingSummary: typeof v.groupingSummary === 'string' ? v.groupingSummary : null,
  };
}

/**
 * Human-readable degradation notes for a parsed report, or an empty array
 * when nothing degraded — presentation-only mirror of @healix/core's
 * report.ts degradationNotes(), kept in sync manually since the renderer
 * only has the narrowed RunReportShape, not the full core RunReport type.
 */
export function reportDegradationNotes(report: RunReportShape | null): string[] {
  if (!report) return [];
  const notes: string[] = [];
  if (report.planSource === 'fallback') {
    notes.push(
      `AI planning failed; this run used a minimal fallback plan instead of a full AI-generated one` +
        (report.fallbackReason ? ` (reason: ${report.fallbackReason}).` : '.'),
    );
  } else if (report.fallbackReason) {
    notes.push(`Part of the plan could not be AI-generated (${report.fallbackReason}).`);
  }
  const gen = report.generation;
  if (gen && gen.acceptedItems < gen.requestedItems) {
    const dropped = gen.requestedItems - gen.acceptedItems;
    notes.push(
      `Generated ${gen.acceptedItems}/${gen.requestedItems} planned spec(s); ${dropped} dropped after failed generation attempts.`,
    );
  }
  const cov = report.coverage;
  if (cov && cov.ratio < cov.target) {
    notes.push(
      `Coverage-feedback loop stopped at ${Math.round(cov.ratio * 100)}% (target ${Math.round(cov.target * 100)}%).`,
    );
  }
  return notes;
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

/** A base-run plan item whose spec never got generated (Retry-pass) or whose test was triaged test_is_wrong (Repair) — a regeneration candidate. */
export interface GenerationGapItem {
  id: string;
  title: string;
  tier: string;
  reqTag?: string;
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
  | { channel: 'queue:updated'; payload: { queue: QueuedRunSummary[] } }
  // Broadcast to every window when a queued run fails to start (before it ever got its own runId).
  | { channel: 'queue:failed'; payload: { message: string } };
