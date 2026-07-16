import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Run, RunStatus, TestCase, TestResult } from '@healix/core';
import {
  anyProviderReady,
  doctorExitCode,
  isTerminalRunStatus,
  providersHealthExitCode,
  reportPathFor,
  runExitCode,
  shapeRunShow,
  TERMINAL_RUN_STATUSES,
} from './helpers.js';

const readyAuthed = { status: 'ready', authenticated: true };
const readyUnauthed = { status: 'ready', authenticated: false };
const missing = { status: 'cli-missing', authenticated: false };

describe('isTerminalRunStatus', () => {
  it.each(['passed', 'failed', 'error', 'cancelled'] as RunStatus[])('%s is terminal', (s) => {
    expect(isTerminalRunStatus(s)).toBe(true);
  });

  it.each([
    'pending',
    'planning',
    'awaiting-approval',
    'exploring',
    'generating',
    'executing',
    'triaging',
    'reporting',
  ] as RunStatus[])('%s is not terminal', (s) => {
    expect(isTerminalRunStatus(s)).toBe(false);
  });

  it('matches the exported constant', () => {
    for (const s of TERMINAL_RUN_STATUSES) expect(isTerminalRunStatus(s)).toBe(true);
  });
});

describe('anyProviderReady', () => {
  it('is true when some provider is ready + authenticated', () => {
    expect(anyProviderReady([missing, readyAuthed])).toBe(true);
  });

  it('is false for ready-but-unauthenticated, missing, or empty', () => {
    expect(anyProviderReady([readyUnauthed])).toBe(false);
    expect(anyProviderReady([missing])).toBe(false);
    expect(anyProviderReady([])).toBe(false);
  });
});

describe('doctorExitCode', () => {
  const providers = (...installed: boolean[]) => installed.map((i) => ({ installed: i }));

  it('fails when the DB is unavailable, regardless of providers', () => {
    expect(
      doctorExitCode({ db: { available: false }, providers: providers(true), ready: true }, { probe: true }),
    ).toBe(1);
    expect(
      doctorExitCode({ db: { available: false }, providers: providers(true), ready: true }, { probe: false }),
    ).toBe(1);
  });

  it('when probing, fails unless some provider is ready + authenticated', () => {
    expect(
      doctorExitCode({ db: { available: true }, providers: providers(true), ready: false }, { probe: true }),
    ).toBe(1);
    expect(
      doctorExitCode({ db: { available: true }, providers: providers(true), ready: true }, { probe: true }),
    ).toBe(0);
  });

  it('with --no-probe, fails only when no provider CLI is installed', () => {
    expect(
      doctorExitCode(
        { db: { available: true }, providers: providers(false, false), ready: false },
        { probe: false },
      ),
    ).toBe(1);
    expect(
      doctorExitCode(
        { db: { available: true }, providers: providers(false, true), ready: false },
        { probe: false },
      ),
    ).toBe(0);
    expect(doctorExitCode({ db: { available: true }, providers: [], ready: false }, { probe: false })).toBe(
      1,
    );
  });
});

describe('providersHealthExitCode', () => {
  it('is 0 when a provider is ready + authenticated', () => {
    expect(providersHealthExitCode([missing, readyAuthed])).toBe(0);
  });

  it('is 1 when nothing is ready + authenticated', () => {
    expect(providersHealthExitCode([missing, readyUnauthed])).toBe(1);
    expect(providersHealthExitCode([])).toBe(1);
  });
});

describe('runExitCode', () => {
  it('is 0 only for passed', () => {
    expect(runExitCode('passed')).toBe(0);
  });

  it.each(['failed', 'error', 'cancelled', 'pending', 'executing'] as RunStatus[])('%s exits 1', (s) => {
    expect(runExitCode(s)).toBe(1);
  });
});

describe('shapeRunShow', () => {
  it('bundles run + tests + results without reshaping them', () => {
    const run: Run = {
      id: 'r1',
      projectId: 'p1',
      status: 'passed',
      provider: 'claude',
      mode: 'playwright',
      startedAt: '2026-07-01T00:00:00.000Z',
      finishedAt: '2026-07-01T00:01:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      suiteMode: null,
      baseRunId: null,
    };
    const tests: TestCase[] = [
      { id: 't1', runId: 'r1', title: 'login', reqTag: null, tier: null, status: 'passed', specPath: null },
    ];
    const results: TestResult[] = [
      { id: 'res1', testId: 't1', status: 'passed', durationMs: 12, error: null, artifactsJson: null },
    ];

    expect(shapeRunShow(run, tests, results)).toEqual({ run, tests, results });
    // The shape must survive a JSON round-trip (it is printed with JSON.stringify).
    expect(JSON.parse(JSON.stringify(shapeRunShow(run, tests, results)))).toEqual({ run, tests, results });
  });
});

describe('reportPathFor', () => {
  it('builds the canonical reports/report.json path under the projects root', () => {
    expect(reportPathFor('/data/projects', 'p1', 'r1')).toBe(
      join('/data/projects', 'p1', 'runs', 'r1', 'reports', 'report.json'),
    );
  });
});
