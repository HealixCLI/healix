import type { Command } from 'commander';
import pc from 'picocolors';
import { doctor } from '@healix/core';
import { doctorExitCode } from '../lib/helpers.js';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Check environment, local storage, and AI provider health')
    .option('--no-probe', 'skip the live provider auth round-trip (detection only)')
    .option('--json', 'output the doctor report as JSON')
    .action(async (opts: { probe?: boolean; json?: boolean }) => {
      const probe = opts.probe !== false;

      if (opts.json) {
        const rep = await doctor({ probe });
        console.log(JSON.stringify(rep, null, 2));
        process.exitCode = doctorExitCode(rep, { probe });
        return;
      }

      console.log(pc.bold('\n  Healix doctor\n'));

      const rep = await doctor({ probe });

      console.log(`  ${pc.dim('Node')}      ${rep.node}  ${pc.dim(`(${rep.platform})`)}`);
      console.log(`  ${pc.dim('App data')}  ${rep.appDataDir}`);
      const dbState = rep.db.available ? pc.green('ready') : pc.red('unavailable');
      console.log(
        `  ${pc.dim('Database')}  ${dbState}  ${pc.dim(
          `${rep.db.driver} · schema v${rep.db.version} · tables: ${rep.db.tables.join(', ') || 'none'}`,
        )}`,
      );
      if (!rep.db.available) console.log(`            ${pc.yellow(rep.db.detail)}`);

      console.log(pc.bold('\n  Providers'));
      for (const p of rep.providers) {
        const dot =
          p.status === 'ready' && p.authenticated
            ? pc.green('●')
            : p.status === 'ready'
              ? pc.cyan('●')
              : p.status === 'cli-missing'
                ? pc.dim('○')
                : pc.yellow('●');
        const ver = p.version ? pc.dim(` v${p.version}`) : '';
        const model = p.model ? pc.dim(` · ${p.model}`) : '';
        const lat = p.latencyMs ? pc.dim(` · ${p.latencyMs}ms`) : '';
        console.log(`    ${dot} ${pc.bold(p.provider)}${ver} ${pc.dim('—')} ${p.status}${model}${lat}`);
        console.log(`      ${pc.dim(p.detail)}`);
      }

      console.log('');
      console.log(
        rep.ready
          ? pc.green('  ✔ At least one provider is authenticated and ready.')
          : pc.yellow('  ⚠ No authenticated provider yet — log in to Claude (or install/login Codex).'),
      );
      console.log('');

      process.exitCode = doctorExitCode(rep, { probe });
    });
}
