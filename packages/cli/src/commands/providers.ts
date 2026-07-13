import type { Command } from 'commander';
import pc from 'picocolors';
import { ProviderRouter } from '@healix/core';
import { providersHealthExitCode } from '../lib/helpers.js';

export function registerProviders(program: Command): void {
  const cmd = program.command('providers').description('Inspect AI providers');

  cmd
    .command('list')
    .description('List configured providers and their capabilities')
    .action(() => {
      const router = new ProviderRouter();
      console.log('');
      for (const p of router.list()) {
        console.log(`  ${pc.bold(p.id)}  ${pc.dim(p.label)}`);
        console.log(`     ${pc.dim('capabilities:')} ${p.capabilities.join(', ')}`);
      }
      console.log('');
    });

  cmd
    .command('health')
    .description('Probe provider health (live auth round-trip by default)')
    .option('--no-probe', 'detection only, no live round-trip')
    .option('--json', 'output raw JSON')
    .action(async (opts: { probe?: boolean; json?: boolean }) => {
      const router = new ProviderRouter();
      const results = await router.healthAll({ probe: opts.probe !== false });
      // CI-safe: non-zero when no provider is ready + authenticated.
      process.exitCode = providersHealthExitCode(results);
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      console.log('');
      for (const p of results) {
        console.log(`  ${pc.bold(p.provider)} — ${p.status}${p.model ? pc.dim(` (${p.model})`) : ''}`);
        console.log(`     ${pc.dim(p.detail)}`);
      }
      console.log('');
    });
}
