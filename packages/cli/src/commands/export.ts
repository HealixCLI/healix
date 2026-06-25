import { resolve, join } from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import { exportSuite, getStore, projectsDir } from '@healix/core';

function storeUnavailable(): void {
  console.log('');
  console.log(pc.yellow('  ⚠ Local storage is unavailable on this runtime. Run `healix doctor`.'));
  console.log('');
}

export function registerExport(program: Command): void {
  program
    .command('export <runId>')
    .description('Export a run’s generated suite as a standalone, runnable bundle')
    .requiredOption('--out <dir>', 'destination directory for the exported bundle')
    .option('--no-sanitize', 'do not strip secrets / local absolute paths')
    .option('--no-zip', 'do not produce a .zip archive')
    .action(async (runId: string, opts: { out: string; sanitize?: boolean; zip?: boolean }) => {
      const store = await getStore();
      if (!store) return storeUnavailable();

      const run = store.getRun(runId);
      if (!run) {
        console.log('');
        console.log(pc.red(`  ✖ No run found with id ${pc.bold(runId)}.`));
        console.log('');
        process.exitCode = 1;
        return;
      }

      const suiteDir = join(projectsDir(), run.projectId, 'runs', run.id, 'suite');
      const outDir = resolve(opts.out);

      console.log('');
      console.log(`  ${pc.bold('Exporting')} ${pc.dim(suiteDir)}`);
      console.log(`  ${pc.dim('→')} ${outDir}`);

      try {
        const bundle = await exportSuite({
          suiteDir,
          outDir,
          sanitize: opts.sanitize !== false,
          zip: opts.zip !== false,
        });
        console.log('');
        console.log(`  ${pc.green('✔')} Exported ${pc.dim(`${bundle.files.length} files`)}`);
        console.log(`    ${pc.dim('dir')}  ${bundle.dir}`);
        if (bundle.zipPath) console.log(`    ${pc.dim('zip')}  ${pc.bold(bundle.zipPath)}`);
        console.log('');
      } catch (err) {
        console.log('');
        console.log(pc.red(`  ✖ Export failed: ${err instanceof Error ? err.message : String(err)}`));
        console.log('');
        process.exitCode = 1;
      }
    });
}
