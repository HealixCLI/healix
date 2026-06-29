import type { RunStatus, TestStatus } from '@healix/core';
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
  error: 'err',
  cancelled: 'muted',
};

export function runStatusTone(status: RunStatus): BadgeTone {
  return RUN_STATUS_TONE[status] ?? 'default';
}

/** A run is finished (terminal) when no further phase transitions are expected. */
export function isTerminalRun(status: RunStatus): boolean {
  return status === 'passed' || status === 'failed' || status === 'error' || status === 'cancelled';
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

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Trim a (possibly nested) artifact path to its leaf name for tidy lists. */
export function artifactLeaf(rel: string): string {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? rel;
}
