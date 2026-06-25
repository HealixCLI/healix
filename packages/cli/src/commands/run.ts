import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import pc from 'picocolors';
import {
  createOrchestrator,
  type ExplorationMode,
  type OrchestratorEvent,
  type ProviderId,
  type RunOptions,
  type RunSummary,
  type TestPlan,
} from '@healix/core';

const PHASE_COLOR: Record<string, (s: string) => string> = {
  plan: pc.magenta,
  approve: pc.yellow,
  explore: pc.cyan,
  generate: pc.blue,
  execute: pc.green,
  triage: pc.yellow,
  report: pc.cyan,
  export: pc.magenta,
  done: pc.green,
};

function levelColor(level: OrchestratorEvent['level']): (s: string) => string {
  switch (level) {
    case 'error':
      return pc.red;
    case 'warn':
      return pc.yellow;
    case 'debug':
      return pc.dim;
    default:
      return (s: string) => s;
  }
}

function streamEvent(e: OrchestratorEvent): void {
  const color = PHASE_COLOR[e.phase] ?? pc.white;
  const tag = color(`[${e.phase}]`);
  console.log(`  ${tag} ${levelColor(e.level)(e.message)}`);
}

/** Render the proposed plan and prompt for approval via stdin. Returns true to proceed. */
async function promptApproval(plan: TestPlan): Promise<boolean> {
  console.log('');
  console.log(pc.bold('  Proposed test plan'));
  console.log(`  ${pc.dim(plan.summary || '(no summary)')}`);
  console.log('');
  if (plan.items.length === 0) {
    console.log(pc.dim('  (no test items proposed)'));
  } else {
    for (const item of plan.items) {
      const tier = item.tier ? pc.dim(`[${item.tier}]`) : '';
      const tag = item.reqTag ? pc.dim(` (${item.reqTag})`) : '';
      console.log(`    ${pc.cyan('•')} ${pc.bold(item.title)} ${tier}${tag}`);
      if (item.intent) console.log(`      ${pc.dim(item.intent)}`);
    }
  }
  console.log('');

  if (!process.stdin.isTTY) {
    console.log(pc.yellow('  ⚠ No interactive terminal; declining plan. Re-run with --yes to auto-approve.'));
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((res) => rl.question(pc.bold('  Approve plan? (y/N) '), res));
    const ok = /^y(es)?$/i.test(answer.trim());
    console.log('');
    return ok;
  } finally {
    rl.close();
  }
}

function printSummary(summary: RunSummary): void {
  console.log('');
  console.log(pc.bold('  Run summary'));
  console.log(`    ${pc.dim('runId')}    ${summary.runId}`);
  const statusColor = summary.status === 'passed' ? pc.green : summary.status === 'failed' ? pc.red : pc.yellow;
  console.log(`    ${pc.dim('status')}   ${statusColor(summary.status)}`);

  const o = summary.outcome;
  if (o) {
    const parts = [
      pc.green(`${o.passed} passed`),
      o.failed > 0 ? pc.red(`${o.failed} failed`) : pc.dim(`${o.failed} failed`),
    ];
    if (o.blocked > 0) parts.push(pc.yellow(`${o.blocked} blocked`));
    if (o.flaky > 0) parts.push(pc.yellow(`${o.flaky} flaky`));
    console.log(`    ${pc.dim('results')}  ${parts.join(pc.dim(' · '))}`);
  }
  if (summary.reportPath) console.log(`    ${pc.dim('report')}   ${summary.reportPath}`);
  if (summary.suite?.dir) console.log(`    ${pc.dim('suite')}    ${summary.suite.dir}`);
  console.log('');
}

export function registerRun(program: Command): void {
  program
    .command('run')
    .description('Plan, generate, execute, and report a test run for a project')
    .requiredOption('--project <id>', 'project id to run against')
    .option('--provider <provider>', 'AI provider: claude | openai')
    .option('--mode <mode>', 'exploration mode: codegen | computer-use')
    .option('--yes', 'auto-approve the plan (skip the approval gate)', false)
    .option('--prd <text>', 'PRD / acceptance-criteria text to ground generation')
    .action(
      async (opts: { project: string; provider?: string; mode?: string; yes?: boolean; prd?: string }) => {
        const runOpts: RunOptions = {
          projectId: opts.project,
          autoApprove: opts.yes === true,
        };
        if (opts.provider) runOpts.provider = opts.provider as ProviderId;
        if (opts.mode) runOpts.explorationMode = opts.mode as ExplorationMode;
        if (opts.prd) runOpts.prd = opts.prd;

        const orchestrator = createOrchestrator();
        console.log('');
        console.log(`  ${pc.bold('Starting run')} ${pc.dim(`for project ${opts.project}`)}`);
        console.log('');

        try {
          const summary = await orchestrator.run(runOpts, {
            onEvent: streamEvent,
            onPlan: opts.yes ? undefined : promptApproval,
          });
          printSummary(summary);
          if (summary.status === 'failed' || summary.status === 'error') process.exitCode = 1;
        } catch (err) {
          console.log('');
          console.log(pc.red(`  ✖ Run failed: ${err instanceof Error ? err.message : String(err)}`));
          console.log('');
          process.exitCode = 1;
        }
      },
    );
}
