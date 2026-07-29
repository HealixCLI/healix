import type { AgentEvent, Run, RunStatus, TestStatus } from '@healix/core';
import type { BadgeTone } from '../components/ui/badge';

const RUN_STATUS_TONE: Partial<Record<RunStatus, BadgeTone>> = {
  pending: 'muted',
  planning: 'default',
  'awaiting-approval': 'warn',
  exploring: 'default',
  generating: 'default',
  executing: 'default',
  triaging: 'default',
  reporting: 'default',
  passed: 'ok',
  failed: 'err',
  blocked: 'warn',
  error: 'err',
  cancelled: 'muted',
};

export function runStatusTone(status: RunStatus): BadgeTone {
  return RUN_STATUS_TONE[status] ?? 'default';
}

/** Every run status, in pipeline order, for status-filter dropdowns. */
export const ALL_RUN_STATUSES: RunStatus[] = [
  'pending',
  'planning',
  'awaiting-approval',
  'exploring',
  'generating',
  'executing',
  'triaging',
  'reporting',
  'passed',
  'failed',
  'error',
  'cancelled',
];

/** Human-readable label for a run status, e.g. 'awaiting-approval' -> 'Awaiting Approval'. */
export function formatRunStatus(status: RunStatus): string {
  return status
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/** A run is finished (terminal) when no further phase transitions are expected. */
export function isTerminalRun(status: RunStatus): boolean {
  return (
    status === 'passed' ||
    status === 'failed' ||
    status === 'blocked' ||
    status === 'error' ||
    status === 'cancelled'
  );
}

const TEST_STATUS_TONE: Record<TestStatus, BadgeTone> = {
  passed: 'ok',
  failed: 'err',
  blocked: 'warn',
  flaky: 'warn',
  skipped: 'muted',
  pending: 'muted',
};

export function testStatusTone(status: TestStatus | null): BadgeTone {
  if (!status) return 'muted';
  return TEST_STATUS_TONE[status] ?? 'default';
}

const EVENT_LEVEL_COLOR: Record<'debug' | 'info' | 'warn' | 'error', string> = {
  debug: 'text-muted',
  info: 'text-fg',
  warn: 'text-warn',
  error: 'text-err',
};

export function eventLevelColor(level: 'debug' | 'info' | 'warn' | 'error'): string {
  return EVENT_LEVEL_COLOR[level];
}

/** Compact, locale-aware timestamp for list rows; falls back to the raw value. */
export function formatCreatedAt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Just the time portion for the console gutter. */
export function formatTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

/** Scales ms -> s -> min -> hr so a long run reads as "23m 52s" instead of a raw "1432.3s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = ms / 1000;
  // Round once, up front, so the sub-minute display and the minute/hour
  // branch boundary agree (otherwise e.g. 59.96s would print "60.0s" while
  // still taking the seconds-only branch instead of rolling over to "1m 0s").
  const roundedSeconds = Math.round(totalSeconds);
  if (roundedSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/** Human label for each AgentEvent phase code, in pipeline order. Phases with no label (e.g. 'launch', 'export', 'done') are folded into the total but not broken out individually. */
const STAGE_LABELS: Record<string, string> = {
  plan: 'Planning',
  approve: 'Approval wait',
  explore: 'Context gathering',
  generate: 'Test generation',
  execute: 'Execution',
  triage: 'Triage',
  report: 'Reporting',
};

export interface StageDuration {
  phase: string;
  label: string;
  ms: number;
}

/**
 * Per-stage wall-clock breakdown derived from AgentEvent timestamps. A
 * stage's duration runs from its first event to the first event of the next
 * known phase (or the last event overall, for the final stage) — this
 * captures real elapsed time between log lines, not just time spent logging.
 */
export function computeStageDurations(events: AgentEvent[]): StageDuration[] {
  const timed = events
    .map((e) => ({ phase: e.phase, t: new Date(e.createdAt).getTime() }))
    .filter((e) => !Number.isNaN(e.t))
    .sort((a, b) => a.t - b.t);
  if (timed.length === 0) return [];

  const firstSeen = new Map<string, number>();
  for (const e of timed) {
    if (e.phase in STAGE_LABELS && !firstSeen.has(e.phase)) firstSeen.set(e.phase, e.t);
  }
  const ordered = [...firstSeen.entries()].sort((a, b) => a[1] - b[1]);
  if (ordered.length === 0) return [];

  const lastEventTime = timed[timed.length - 1].t;
  return ordered.map(([phase, start], i) => {
    const end = i + 1 < ordered.length ? ordered[i + 1][1] : lastEventTime;
    return { phase, label: STAGE_LABELS[phase], ms: Math.max(0, end - start) };
  });
}

/** Total run duration: prefers the run's own started/finished timestamps, falling back to the event span. */
export function computeTotalDurationMs(
  run: Pick<Run, 'startedAt' | 'finishedAt'>,
  events: AgentEvent[],
): number | null {
  if (run.startedAt && run.finishedAt) {
    const start = new Date(run.startedAt).getTime();
    const end = new Date(run.finishedAt).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(end)) return Math.max(0, end - start);
  }
  const times = events.map((e) => new Date(e.createdAt).getTime()).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return null;
  return Math.max(0, Math.max(...times) - Math.min(...times));
}

/** Multi-line tooltip text for a stage breakdown, e.g. for a StatTile's hover title. */
export function formatStageBreakdown(stages: StageDuration[]): string {
  return stages.map((s) => `${s.label}: ${formatDuration(s.ms)}`).join('\n');
}

/** Trim a (possibly nested) artifact path to its leaf name for tidy lists. */
export function artifactLeaf(rel: string): string {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? rel;
}

// ---- Usage formatting (token/cost display for RunDetailPanel + ReportsUsageView) --

/** Formats a token count for display; '—' when null (the provider/call reported no usage). */
export function formatTokens(n: number | null): string {
  return n === null ? '—' : Math.round(n).toLocaleString();
}

/** Formats a USD cost for display; '—' when null (not every provider reports cost). */
export function formatCost(n: number | null): string {
  return n === null ? '—' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
}

/** Sums nullable numbers, staying null only when EVERY value is null (vs. 0 when some are 0/absent-but-known). */
export function sumNullable(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
}

// ---- Artifact media handling (screenshots / videos / traces) ----------------

export type ArtifactKind = 'image' | 'video' | 'trace' | 'other';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_EXT = /\.(webm|mp4|mov)$/i;

/** Classify an artifact file so the gallery knows how to render it. */
export function artifactKind(path: string): ArtifactKind {
  if (IMAGE_EXT.test(path)) return 'image';
  if (VIDEO_EXT.test(path)) return 'video';
  if (/trace\.zip$/i.test(path)) return 'trace';
  return 'other';
}

/**
 * Renderer-loadable URL for an absolute artifact path. Served by the main
 * process's healix-artifact:// protocol (restricted to the projects dir).
 */
export function artifactUrl(abs: string): string {
  return `healix-artifact://run/${encodeURIComponent(abs)}`;
}
