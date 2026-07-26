import { createInterface } from 'node:readline';
import { Option, type Command } from 'commander';
import pc from 'picocolors';
import {
  createOrchestrator,
  type ExplorationMode,
  type OrchestratorEvent,
  type PlanApprovalResult,
  type ProviderId,
  type RunOptions,
  type RunSummary,
  type TestPlan,
} from '@healix/core';
import { runExitCode } from '../lib/helpers.js';
import { installInterruptHandler } from '../lib/interrupt.js';

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

/** Exported so `healix runs resume` (runs.ts) streams events identically. */
export function streamEvent(e: OrchestratorEvent): void {
  const color = PHASE_COLOR[e.phase] ?? pc.white;
  const tag = color(`[${e.phase}]`);
  console.log(`  ${tag} ${levelColor(e.level)(e.message)}`);
}

/**
 * Render the proposed plan and prompt for approval via stdin. The CLI keeps
 * a whole-plan y/N flow (no per-item terminal UX) — "yes" approves every
 * item as proposed; the orchestrator's own default-to-approved step handles
 * items with no explicit status.
 */
async function promptApproval(plan: TestPlan): Promise<PlanApprovalResult> {
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
    return { decision: 'cancel' };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((res) => rl.question(pc.bold('  Approve plan? (y/N) '), res));
    const ok = /^y(es)?$/i.test(answer.trim());
    console.log('');
    return ok ? { decision: 'proceed', plan } : { decision: 'cancel' };
  } finally {
    rl.close();
  }
}

/** Exported so `healix runs resume` (runs.ts) prints the same summary shape `healix run` does. */
export function printSummary(summary: RunSummary): void {
  console.log('');
  console.log(pc.bold('  Run summary'));
  console.log(`    ${pc.dim('runId')}    ${summary.runId}`);
  const statusColor =
    summary.status === 'passed' ? pc.green : summary.status === 'failed' ? pc.red : pc.yellow;
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
  console.log(
    pc.dim(`  See full history with \`healix runs show ${summary.runId}\` (or \`healix runs list\`).`),
  );
  console.log('');
}

export function registerRun(program: Command): void {
  program
    .command('run')
    .description('Plan, generate, execute, and report a test run for a project')
    .requiredOption('--project <id>', 'project id to run against')
    .addOption(new Option('--provider <provider>', 'AI provider').choices(['claude', 'openai']))
    .addOption(new Option('--mode <mode>', 'exploration mode').choices(['codegen', 'computer-use']))
    .option('--yes', 'auto-approve the plan (skip the approval gate)', false)
    .option('--prd <text>', 'PRD / acceptance-criteria text to ground generation')
    .option(
      '--max-cost-usd <amount>',
      'pause the run cleanly (resumable) once its total AI spend reaches this many dollars',
    )
    .option(
      '--max-tokens <count>',
      'pause the run cleanly (resumable) once its total input+output tokens reach this count',
    )
    .option(
      '--max-crawl-routes <count>',
      "override EXPLORE's hard cap on distinct routes visited (default 60)",
    )
    .option(
      '--crawl-budget-ms <ms>',
      "override EXPLORE's wall-clock crawl budget in milliseconds (default 120000)",
    )
    .action(
      async (opts: {
        project: string;
        provider?: string;
        mode?: string;
        yes?: boolean;
        prd?: string;
        maxCostUsd?: string;
        maxTokens?: string;
        maxCrawlRoutes?: string;
        crawlBudgetMs?: string;
      }) => {
        const runOpts: RunOptions = {
          projectId: opts.project,
          autoApprove: opts.yes === true,
        };
        if (opts.provider) runOpts.provider = opts.provider as ProviderId;
        if (opts.mode) runOpts.explorationMode = opts.mode as ExplorationMode;
        if (opts.prd) runOpts.prd = opts.prd;
        if (opts.maxCostUsd !== undefined) runOpts.maxCostUsd = Number(opts.maxCostUsd);
        if (opts.maxTokens !== undefined) runOpts.maxTokens = Number(opts.maxTokens);
        if (opts.maxCrawlRoutes !== undefined || opts.crawlBudgetMs !== undefined) {
          runOpts.crawlBudget = {
            ...(opts.maxCrawlRoutes !== undefined ? { maxRoutes: Number(opts.maxCrawlRoutes) } : {}),
            ...(opts.crawlBudgetMs !== undefined ? { wallClockBudgetMs: Number(opts.crawlBudgetMs) } : {}),
          };
        }

        // Ctrl+C previously just killed the process with no checkpoint
        // written at all — treating it as a pause request instead means the
        // orchestrator gets a chance to persist progress before exiting, and
        // `healix runs resume <runId>` can pick it back up.
        const interrupt = installInterruptHandler(() => {
          console.log('');
          console.log(pc.yellow('  ⚠ Interrupt received — pausing run (checkpoint will be saved)…'));
        });
        runOpts.signal = interrupt.signal;

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
          // Only a fully passed run exits 0 — a cancelled run (declined or
          // non-interactive approval gate) must not look like success in CI.
          process.exitCode = runExitCode(summary.status);
        } catch (err) {
          console.log('');
          console.log(pc.red(`  ✖ Run failed: ${err instanceof Error ? err.message : String(err)}`));
          console.log('');
          process.exitCode = 1;
        } finally {
          interrupt.dispose();
        }
      },
    );
}
