import type {
  AgentEvent,
  ExplorationMode,
  OrchestratorEvent,
  ProviderId,
  Run,
  RunSummary,
  TestCase,
  TestResult,
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

/** Discriminated lifecycle messages delivered to onRunEvent subscribers. */
export type RunChannelMessage =
  | { channel: 'run:started'; payload: { runId: string; projectId: string } }
  | { channel: 'run:event'; payload: { runId: string; event: OrchestratorEvent } }
  | { channel: 'run:plan'; payload: { runId: string; plan: TestPlan } }
  | { channel: 'run:done'; payload: { runId: string; summary: RunSummary } }
  // Live browser mirror frame (JPEG, base64) for computer-use runs.
  | { channel: 'run:frame'; payload: { runId: string; frameBase64: string } };
