import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import pc from 'picocolors';
import {
  getStore,
  projectsDir,
  type AgentEvent,
  type Run,
  type RunStatus,
  type TestCase,
  type TestStatus,
} from '@healix/core';
import { isTerminalRunStatus, reportPathFor, shapeRunShow } from '../lib/helpers.js';

/** Print a friendly hint when the local SQLite store is unavailable. */
function storeUnavailable(): void {
  console.log('');
  console.log(pc.yellow('  ⚠ Local storage is unavailable on this runtime.'));
  console.log(
    pc.dim(
      '    Healix needs node:sqlite (Node 22.5+ with --experimental-sqlite, or Node 23.4+). Run `healix doctor`.',
    ),
  );
  console.log('');
}

/** JSON-mode variant: keep stdout valid JSON — report the problem on stderr, exit 1. */
function storeUnavailableJson(): void {
  console.error('Local storage is unavailable on this runtime (node:sqlite missing). Run `healix doctor`.');
  process.exitCode = 1;
}

function fmtCell(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, ' ');
}

/** Color a run-level status (mirrors the lifecycle of orchestrator phases). */
function runStatusColor(status: RunStatus): (s: string) => string {
  switch (status) {
    case 'passed':
      return pc.green;
    case 'failed':
    case 'error':
      return pc.red;
    case 'cancelled':
      return pc.dim;
    case 'pending':
      return pc.cyan;
    default:
      return pc.yellow;
  }
}

/** Color a per-test status. */
function testStatusColor(status: TestStatus | null): (s: string) => string {
  switch (status) {
    case 'passed':
      return pc.green;
    case 'failed':
      return pc.red;
    case 'blocked':
    case 'flaky':
      return pc.yellow;
    case 'skipped':
      return pc.dim;
    default:
      return pc.cyan;
  }
}

function testStatusSymbol(status: TestStatus | null): string {
  switch (status) {
    case 'passed':
      return '✔';
    case 'failed':
      return '✖';
    case 'blocked':
      return '■';
    case 'flaky':
      return '~';
    case 'skipped':
      return '–';
    default:
      return '•';
  }
}

function fmtDuration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function printRunRow(run: Run): void {
  const id = fmtCell(run.id, 16);
  const project = fmtCell(run.projectId, 18);
  const status = fmtCell(run.status, 14);
  const mode = fmtCell(run.mode ?? '—', 12);
  const created = run.createdAt;
  console.log(
    `  ${pc.bold(id)}  ${project}  ${runStatusColor(run.status)(status)}  ${pc.cyan(mode)}  ${pc.dim(created)}`,
  );
}

export function registerRuns(program: Command): void {
  const cmd = program.command('runs').description('Inspect Healix run history');

  cmd
    .command('list')
    .description('List runs (optionally filtered by project)')
    .option('--project <id>', 'only show runs for this project id')
    .option('--json', 'output the runs as a JSON array')
    .action(async (opts: { project?: string; json?: boolean }) => {
      const store = await getStore();
      if (!store) return opts.json ? storeUnavailableJson() : storeUnavailable();

      const runs = store.listRuns(opts.project);
      if (opts.json) {
        console.log(JSON.stringify(runs, null, 2));
        return;
      }
      console.log('');
      if (runs.length === 0) {
        const where = opts.project ? ` for project ${pc.bold(opts.project)}` : '';
        console.log(pc.dim(`  No runs yet${where}. Start one with \`healix run --project <id>\`.`));
        console.log('');
        return;
      }
      console.log(
        `  ${pc.dim(fmtCell('RUN ID', 16))}  ${pc.dim(fmtCell('PROJECT', 18))}  ${pc.dim(fmtCell('STATUS', 14))}  ${pc.dim(
          fmtCell('MODE', 12),
        )}  ${pc.dim('CREATED')}`,
      );
      for (const run of runs) printRunRow(run);
      console.log('');
    });

  cmd
    .command('show <runId>')
    .description('Show a run: status, per-test results, phase events, and report path')
    .option('--json', 'output the run, its tests, and its results as JSON')
    .action(async (runId: string, opts: { json?: boolean }) => {
      const store = await getStore();
      if (!store) return opts.json ? storeUnavailableJson() : storeUnavailable();

      const run = store.getRun(runId);
      if (!run) {
        if (opts.json) {
          console.error(`No run found with id ${runId}.`);
        } else {
          console.log('');
          console.log(pc.red(`  ✖ No run found with id ${pc.bold(runId)}.`));
          console.log('');
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(
          JSON.stringify(shapeRunShow(run, store.listTests(runId), store.listResults(runId)), null, 2),
        );
        return;
      }

      // ---- run header ----
      console.log('');
      console.log(`  ${pc.bold('Run')} ${pc.dim(run.id)}`);
      console.log(`    ${pc.dim('project')}   ${run.projectId}`);
      console.log(`    ${pc.dim('status')}    ${runStatusColor(run.status)(run.status)}`);
      console.log(`    ${pc.dim('provider')}  ${run.provider ?? pc.dim('—')}`);
      console.log(`    ${pc.dim('mode')}      ${run.mode ?? pc.dim('—')}`);
      console.log(`    ${pc.dim('created')}   ${run.createdAt}`);
      console.log(`    ${pc.dim('started')}   ${run.startedAt ?? pc.dim('—')}`);
      console.log(`    ${pc.dim('finished')}  ${run.finishedAt ?? pc.dim('—')}`);
      if (run.suiteMode) {
        const based = run.baseRunId ? ` (based on ${run.baseRunId})` : '';
        console.log(`    ${pc.dim('suite')}     ${pc.cyan(run.suiteMode)}${pc.dim(based)}`);
      }

      // ---- results table (results joined with test metadata) ----
      const tests = store.listTests(runId);
      const results = store.listResults(runId);
      const testsById = new Map<string, TestCase>(tests.map((t) => [t.id, t]));

      console.log('');
      console.log(pc.bold('  Results'));
      if (results.length === 0 && tests.length === 0) {
        console.log(pc.dim('    (no tests or results recorded for this run)'));
      } else if (results.length === 0) {
        // Tests exist but have not executed yet — show their planned status.
        for (const t of tests) {
          const color = testStatusColor(t.status);
          const tier = t.tier ? pc.dim(` [${t.tier}]`) : '';
          const tag = t.reqTag ? pc.dim(` (${t.reqTag})`) : '';
          console.log(`    ${color(testStatusSymbol(t.status))} ${t.title}${tier}${tag}`);
        }
      } else {
        const counts: Record<string, number> = {};
        for (const r of results) {
          counts[r.status] = (counts[r.status] ?? 0) + 1;
          const test = testsById.get(r.testId);
          const title = test?.title ?? pc.dim(`(test ${r.testId})`);
          const tier = test?.tier ? pc.dim(` [${test.tier}]`) : '';
          const tag = test?.reqTag ? pc.dim(` (${test.reqTag})`) : '';
          const color = testStatusColor(r.status);
          const duration = pc.dim(fmtDuration(r.durationMs));
          console.log(`    ${color(testStatusSymbol(r.status))} ${title}${tier}${tag}  ${duration}`);
          if (r.error) console.log(`      ${pc.red(firstLine(r.error))}`);
        }
        console.log('');
        const summaryParts = Object.entries(counts).map(([k, v]) =>
          testStatusColor(k as TestStatus)(`${v} ${k}`),
        );
        console.log(`    ${pc.dim('totals:')} ${summaryParts.join(pc.dim(' · '))}`);
      }

      // ---- phase / event summary ----
      const events = store.listEvents(runId);
      console.log('');
      console.log(pc.bold('  Events'));
      if (events.length === 0) {
        console.log(pc.dim('    (no events recorded for this run)'));
      } else {
        printPhaseSummary(events);
      }

      // ---- report path ----
      const reportPath = reportPathFor(projectsDir(), run.projectId, run.id);
      console.log('');
      if (existsSync(reportPath)) {
        console.log(`  ${pc.dim('report')}  ${reportPath}`);
      } else {
        console.log(pc.dim(`  report   (not written yet — expected at ${reportPath})`));
      }
      console.log('');
    });

  /**
   * Mark an abandoned run as cancelled.
   *
   * This is a bookkeeping operation for runs whose driving process is gone
   * (crashed terminal, killed desktop app, …): it flips the stored status to
   * 'cancelled' and stamps finishedAt. It CANNOT signal a live orchestrator
   * process (yet) — a run that is actively executing will keep going.
   */
  cmd
    .command('cancel <runId>')
    .description('Mark an abandoned (non-terminal) run as cancelled — does not stop a live process')
    .action(async (runId: string) => {
      const store = await getStore();
      if (!store) {
        storeUnavailable();
        process.exitCode = 1;
        return;
      }

      const run = store.getRun(runId);
      if (!run) {
        console.log('');
        console.log(pc.red(`  ✖ No run found with id ${pc.bold(runId)}.`));
        console.log('');
        process.exitCode = 1;
        return;
      }

      if (isTerminalRunStatus(run.status)) {
        console.log('');
        console.log(pc.yellow(`  ⚠ Run ${pc.bold(runId)} is already ${run.status} — nothing to cancel.`));
        console.log('');
        process.exitCode = 1;
        return;
      }

      store.updateRunStatus(runId, 'cancelled', { finishedAt: new Date().toISOString() });
      console.log('');
      console.log(pc.green(`  ✔ Run ${pc.bold(runId)} marked as cancelled (was ${run.status}).`));
      console.log(pc.dim('    Note: this updates the stored status only; it cannot stop a live process.'));
      console.log('');
    });

  cmd
    .command('rm <runId>')
    .description('Delete a run and its recorded tests/results/events from the local store')
    .action(async (runId: string) => {
      const store = await getStore();
      if (!store) {
        storeUnavailable();
        process.exitCode = 1;
        return;
      }

      const run = store.getRun(runId);
      if (!run) {
        console.log('');
        console.log(pc.red(`  ✖ No run found with id ${pc.bold(runId)}.`));
        console.log('');
        process.exitCode = 1;
        return;
      }

      store.deleteRun(runId);
      console.log('');
      console.log(
        pc.green(`  ✔ Deleted run ${pc.bold(runId)} (project ${run.projectId}) from the local store.`),
      );
      console.log(pc.dim('    On-disk artifacts under the project folder are kept.'));
      console.log('');
    });
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}

/** Group events by phase and print a tidy per-phase count plus any warn/error lines. */
function printPhaseSummary(events: AgentEvent[]): void {
  const order: string[] = [];
  const byPhase = new Map<string, AgentEvent[]>();
  for (const e of events) {
    let bucket = byPhase.get(e.phase);
    if (!bucket) {
      bucket = [];
      byPhase.set(e.phase, bucket);
      order.push(e.phase);
    }
    bucket.push(e);
  }

  for (const phase of order) {
    const bucket = byPhase.get(phase) ?? [];
    const warns = bucket.filter((e) => e.level === 'warn').length;
    const errors = bucket.filter((e) => e.level === 'error').length;
    const annotations: string[] = [];
    if (warns > 0) annotations.push(pc.yellow(`${warns} warn`));
    if (errors > 0) annotations.push(pc.red(`${errors} error`));
    const suffix = annotations.length > 0 ? ` ${pc.dim('·')} ${annotations.join(pc.dim(' · '))}` : '';
    console.log(`    ${pc.cyan(fmtCell(phase, 12))} ${pc.dim(`${bucket.length} events`)}${suffix}`);
    for (const e of bucket) {
      if (e.level === 'warn' || e.level === 'error') {
        const color = e.level === 'error' ? pc.red : pc.yellow;
        console.log(`      ${color('•')} ${color(firstLine(e.message))}`);
      }
    }
  }
}
