#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerDoctor } from './commands/doctor.js';
import { registerProviders } from './commands/providers.js';
import { registerProject } from './commands/project.js';
import { registerScan } from './commands/scan.js';
import { registerRun } from './commands/run.js';
import { registerRuns } from './commands/runs.js';
import { registerReport } from './commands/report.js';
import { registerExport } from './commands/export.js';

// Resolve the real package version (this file runs from dist/, next to package.json).
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

const program = new Command();

program
  .name('healix')
  .description('Healix — local-first, AI-led testing (Playwright-first)')
  .version(pkg.version);

registerDoctor(program);
registerProviders(program);
registerProject(program);
registerScan(program);
registerRun(program);
registerRuns(program);
registerReport(program);
registerExport(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
