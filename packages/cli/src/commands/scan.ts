import { resolve } from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import { createTargetAdapter, type DetectedProject, type RepoIndex } from '@healix/core';

function val(v: string | number | null): string {
  return v === null || v === '' ? pc.dim('—') : String(v);
}

function printDetected(d: DetectedProject): void {
  console.log('');
  console.log(pc.bold('  Detected project'));
  console.log(`    ${pc.dim('kind')}          ${val(d.kind)}`);
  console.log(`    ${pc.dim('framework')}     ${val(d.framework)}`);
  console.log(`    ${pc.dim('packageMgr')}    ${val(d.packageManager)}`);
  console.log(`    ${pc.dim('startCommand')}  ${val(d.startCommand)}`);
  console.log(`    ${pc.dim('port')}          ${val(d.port)}`);
  console.log(`    ${pc.dim('baseUrl')}       ${val(d.baseUrl)}`);
}

function printIndex(idx: RepoIndex): void {
  console.log('');
  console.log(pc.bold('  Repo index'));
  console.log(`    ${pc.dim('root')}    ${idx.root}`);
  console.log(`    ${pc.dim('files')}   ${idx.files.length}`);
  console.log('');
  console.log(pc.bold('  Summary'));
  for (const line of (idx.summary || pc.dim('(no summary)')).split('\n')) {
    console.log(`    ${line}`);
  }
  console.log('');
}

export function registerScan(program: Command): void {
  program
    .command('scan <repoPath>')
    .description('Detect framework/start command and index a repository')
    .option('--max-files <n>', 'maximum files to include in the index', (v) => Number.parseInt(v, 10))
    .action(async (repoPath: string, opts: { maxFiles?: number }) => {
      const abs = resolve(repoPath);
      const target = createTargetAdapter();
      console.log('');
      console.log(`  ${pc.bold('Scanning')} ${pc.dim(abs)}`);
      try {
        const detected = await target.detect(abs);
        printDetected(detected);

        const idx = await target.indexRepo(abs, opts.maxFiles ? { maxFiles: opts.maxFiles } : undefined);
        printIndex(idx);
      } catch (err) {
        console.log('');
        console.log(pc.red(`  ✖ Scan failed: ${err instanceof Error ? err.message : String(err)}`));
        console.log('');
        process.exitCode = 1;
      }
    });
}
