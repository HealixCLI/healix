import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@healix/core';
import {
  computeStageDurations,
  computeTotalDurationMs,
  formatDuration,
  formatStageBreakdown,
} from './run-format.js';

function event(phase: string, createdAt: string, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: `evt_${phase}_${createdAt}`,
    runId: 'run_1',
    phase,
    level: 'info',
    message: '',
    dataJson: null,
    createdAt,
    ...overrides,
  };
}

describe('formatDuration', () => {
  it('renders null/undefined as an em dash', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });

  it('renders sub-second durations in whole milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('renders sub-minute durations in seconds with one decimal', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1432)).toBe('1.4s');
    expect(formatDuration(59000)).toBe('59.0s');
  });

  it('rolls over to minutes at the 60s boundary, including when rounding pushes it there', () => {
    // 59.5s rounds to 60s, which must present as the next unit, not "60.0s".
    expect(formatDuration(59500)).toBe('1m 0s');
    expect(formatDuration(65000)).toBe('1m 5s');
  });

  it('renders minute-scale durations as "Xm Ys"', () => {
    // The reported case: 1432.3s of raw seconds should read as 23m 52s.
    expect(formatDuration(1_432_300)).toBe('23m 52s');
    expect(formatDuration(59 * 60_000 + 59_000)).toBe('59m 59s');
  });

  it('rolls over to hours at the 60-minute boundary and drops seconds', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h 0m');
    expect(formatDuration(60 * 60_000 + 2 * 60_000 + 3_000)).toBe('1h 2m');
  });
});

describe('computeTotalDurationMs', () => {
  it('returns null when there is no run timing and no events', () => {
    expect(computeTotalDurationMs({ startedAt: null, finishedAt: null }, [])).toBeNull();
  });

  it('prefers the run\'s own startedAt/finishedAt when both are present', () => {
    const ms = computeTotalDurationMs(
      { startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:05:00.000Z' },
      [event('plan', '2026-01-01T00:00:00.000Z'), event('execute', '2026-01-01T00:04:00.000Z')],
    );
    expect(ms).toBe(5 * 60_000);
  });

  it('falls back to the event span when startedAt/finishedAt are missing', () => {
    const ms = computeTotalDurationMs({ startedAt: null, finishedAt: null }, [
      event('plan', '2026-01-01T00:00:00.000Z'),
      event('execute', '2026-01-01T00:03:00.000Z'),
    ]);
    expect(ms).toBe(3 * 60_000);
  });

  it('falls back to the event span when only one of startedAt/finishedAt is present', () => {
    const ms = computeTotalDurationMs(
      { startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null },
      [event('plan', '2026-01-01T00:00:00.000Z'), event('execute', '2026-01-01T00:02:00.000Z')],
    );
    expect(ms).toBe(2 * 60_000);
  });

  it('computes the correct span from out-of-order events', () => {
    const ms = computeTotalDurationMs({ startedAt: null, finishedAt: null }, [
      event('execute', '2026-01-01T00:05:00.000Z'),
      event('plan', '2026-01-01T00:00:00.000Z'),
      event('triage', '2026-01-01T00:02:00.000Z'),
    ]);
    expect(ms).toBe(5 * 60_000);
  });

});

describe('computeStageDurations', () => {
  it('returns an empty list for no events', () => {
    expect(computeStageDurations([])).toEqual([]);
  });

  it('returns an empty list when no event phase is a known stage', () => {
    expect(computeStageDurations([event('launch', '2026-01-01T00:00:00.000Z'), event('done', '2026-01-01T00:01:00.000Z')])).toEqual(
      [],
    );
  });

  it('derives each stage\'s duration from its first event to the next stage\'s first event', () => {
    const stages = computeStageDurations([
      event('plan', '2026-01-01T00:00:00.000Z'),
      event('plan', '2026-01-01T00:00:30.000Z'),
      event('approve', '2026-01-01T00:01:00.000Z'),
      event('execute', '2026-01-01T00:01:10.000Z'),
    ]);
    expect(stages).toEqual([
      { phase: 'plan', label: 'Planning', ms: 60_000 },
      { phase: 'approve', label: 'Approval wait', ms: 10_000 },
      { phase: 'execute', label: 'Execution', ms: 0 },
    ]);
  });

  it('attributes the final known stage\'s duration up to the last event overall, not its own last event', () => {
    const stages = computeStageDurations([
      event('execute', '2026-01-01T00:00:00.000Z'),
      event('execute', '2026-01-01T00:00:10.000Z'),
      event('done', '2026-01-01T00:00:40.000Z'),
    ]);
    expect(stages).toEqual([{ phase: 'execute', label: 'Execution', ms: 40_000 }]);
  });

  it('sorts out-of-order events by timestamp before deriving stage order and durations', () => {
    const stages = computeStageDurations([
      event('execute', '2026-01-01T00:02:00.000Z'),
      event('plan', '2026-01-01T00:00:00.000Z'),
      event('approve', '2026-01-01T00:01:00.000Z'),
    ]);
    expect(stages.map((s) => s.phase)).toEqual(['plan', 'approve', 'execute']);
    expect(stages.map((s) => s.ms)).toEqual([60_000, 60_000, 0]);
  });

  it('ignores events with unparsable timestamps', () => {
    const stages = computeStageDurations([
      event('plan', 'not-a-date'),
      event('plan', '2026-01-01T00:00:00.000Z'),
      event('execute', '2026-01-01T00:01:00.000Z'),
    ]);
    expect(stages).toEqual([
      { phase: 'plan', label: 'Planning', ms: 60_000 },
      { phase: 'execute', label: 'Execution', ms: 0 },
    ]);
  });
});

describe('formatStageBreakdown', () => {
  it('renders an empty string for no stages', () => {
    expect(formatStageBreakdown([])).toBe('');
  });

  it('joins each stage\'s label and formatted duration on its own line', () => {
    const text = formatStageBreakdown([
      { phase: 'plan', label: 'Planning', ms: 1_432_300 },
      { phase: 'execute', label: 'Execution', ms: 500 },
    ]);
    expect(text).toBe('Planning: 23m 52s\nExecution: 500ms');
  });
});
