#!/usr/bin/env node
import { Command } from 'commander';
import { registerDoctor } from './commands/doctor.js';
import { registerProviders } from './commands/providers.js';

const program = new Command();

program
  .name('healix')
  .description('Healix — local-first, AI-led testing (Playwright-first)')
  .version('0.0.0');

registerDoctor(program);
registerProviders(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
