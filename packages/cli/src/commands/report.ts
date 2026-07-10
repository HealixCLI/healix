import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import pc from 'picocolors';
import { getStore, projectsDir, type TestCase, type TestStatus } from '@healix/core';
import { reportPathFor } from '../lib/helpers.js';

function storeUnavailable(): void {
  console.log('');
  console.log(pc.yellow('  ⚠ Local storage is unavailable on this runtime. Run `healix doctor`.'));
  console.log('');
}

function statusColor(status: TestStatus | null): (s: string) => string {
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

function statusSymbol(status: TestStatus | null): string {
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

function tally(tests: TestCase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tests) {
    const key = t.status ?? 'pending';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function registerReport(program: Command): void {
  program
    .command('report <runId>')
    .description('Show the summary for a completed (or in-progress) run')
    .option('--json', 'print the run report JSON (reports/report.json) to stdout')
    .action(async (runId: string, opts: { json?: boolean }) => {
      const store = await getStore();
      if (!store) {
        if (opts.json) {
          console.error(
            'Local storage is unavailable on this runtime (node:sqlite missing). Run `healix doctor`.',
          );
          process.exitCode = 1;
          return;
        }
        return storeUnavailable();
      }

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
        const reportPath = reportPathFor(projectsDir(), run.projectId, run.id);
        try {
          const raw = await readFile(reportPath, 'utf8');
          // Round-trip through JSON.parse so stdout is guaranteed valid JSON.
          console.log(JSON.stringify(JSON.parse(raw), null, 2));
        } catch {
          console.error(`No report has been written for run ${runId} (expected at ${reportPath}).`);
          process.exitCode = 1;
        }
        return;
      }

      const tests = store.listTests(runId);
      const counts = tally(tests);

      console.log('');
      console.log(`  ${pc.bold('Run')} ${pc.dim(run.id)}`);
      const runStatusColor =
        run.status === 'passed' ? pc.green : run.status === 'failed' ? pc.red : pc.yellow;
      console.log(`    ${pc.dim('project')}   ${run.projectId}`);
      console.log(`    ${pc.dim('status')}    ${runStatusColor(run.status)}`);
      console.log(`    ${pc.dim('provider')}  ${run.provider ?? pc.dim('—')}`);
      console.log(`    ${pc.dim('mode')}      ${run.mode ?? pc.dim('—')}`);
      console.log(`    ${pc.dim('started')}   ${run.startedAt ?? pc.dim('—')}`);
      console.log(`    ${pc.dim('finished')}  ${run.finishedAt ?? pc.dim('—')}`);

      console.log('');
      console.log(pc.bold('  Tests'));
      if (tests.length === 0) {
        console.log(pc.dim('    (no tests recorded for this run)'));
      } else {
        for (const t of tests) {
          const color = statusColor(t.status);
          const tier = t.tier ? pc.dim(` [${t.tier}]`) : '';
          const tag = t.reqTag ? pc.dim(` (${t.reqTag})`) : '';
          console.log(`    ${color(statusSymbol(t.status))} ${t.title}${tier}${tag}`);
        }
        console.log('');
        const summaryParts = Object.entries(counts).map(([k, v]) =>
          statusColor(k as TestStatus)(`${v} ${k}`),
        );
        console.log(`    ${pc.dim('totals:')} ${summaryParts.join(pc.dim(' · '))}`);
      }
      console.log('');
    });
}
