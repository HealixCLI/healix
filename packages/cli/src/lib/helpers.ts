import { join } from 'node:path';
import type { Run, RunStatus, TestCase, TestResult } from '@healix/core';

/**
 * Pure helpers behind the CLI's exit-code and JSON-output decisions.
 * Kept free of runtime imports from @healix/core so they can be unit-tested
 * in isolation (types from core are erased at compile time).
 */

/** Run statuses that can no longer change. A terminal run cannot be cancelled. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['passed', 'failed', 'error', 'cancelled'];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** Structural subset of a provider HealthResult that exit-code decisions need. */
export interface ProviderReadiness {
  status: string;
  authenticated: boolean;
  installed: boolean;
}

/** True when at least one provider is ready and authenticated. */
export function anyProviderReady(
  providers: ReadonlyArray<Pick<ProviderReadiness, 'status' | 'authenticated'>>,
): boolean {
  return providers.some((p) => p.status === 'ready' && p.authenticated);
}

/** Structural subset of a DoctorReport that the doctor exit-code decision needs. */
export interface DoctorExitInput {
  db: { available: boolean };
  providers: ReadonlyArray<Pick<ProviderReadiness, 'installed'>>;
  /** True when some provider is ready + authenticated (computed by core). */
  ready: boolean;
}

/**
 * Exit code for `healix doctor`:
 * - an unavailable DB always fails;
 * - when probing, fail unless some provider is ready + authenticated;
 * - with --no-probe (no live auth round-trip), fail only when no provider CLI is installed.
 */
export function doctorExitCode(report: DoctorExitInput, opts: { probe: boolean }): 0 | 1 {
  if (!report.db.available) return 1;
  if (opts.probe) return report.ready ? 0 : 1;
  return report.providers.some((p) => p.installed) ? 0 : 1;
}

/** Exit code for `healix providers health`: fail when no provider is ready + authenticated. */
export function providersHealthExitCode(
  results: ReadonlyArray<Pick<ProviderReadiness, 'status' | 'authenticated'>>,
): 0 | 1 {
  return anyProviderReady(results) ? 0 : 1;
}

/**
 * Exit code for `healix run`: only a fully 'passed' run exits 0.
 * In particular a 'cancelled' run (e.g. a declined or non-TTY approval gate)
 * exits 1 so CI cannot silently "succeed" while doing nothing.
 */
export function runExitCode(status: RunStatus): 0 | 1 {
  return status === 'passed' ? 0 : 1;
}

/** JSON payload shape for `healix runs show --json`. */
export interface RunShowJson {
  run: Run;
  tests: TestCase[];
  results: TestResult[];
}

export function shapeRunShow(run: Run, tests: TestCase[], results: TestResult[]): RunShowJson {
  return { run, tests, results };
}

/** Canonical on-disk location of a run's JSON report, under the given projects root. */
export function reportPathFor(projectsRoot: string, projectId: string, runId: string): string {
  return join(projectsRoot, projectId, 'runs', runId, 'reports', 'report.json');
}
