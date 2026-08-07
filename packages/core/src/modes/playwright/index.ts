import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type {
  ExecOutcome,
  GeneratedSpec,
  SuiteBundle,
  TestMode,
  TestModeContext,
  TestPlan,
  ValidationResult,
} from '../types.js';
import { scaffold } from './scaffold.js';
import { generate } from './generate.js';
import { execute } from './execute.js';
import { validateSuite } from './validate.js';
import { splitTestBlocks } from './quality-audit.js';

/** Directories whose presence is purely build/runtime noise — never traversed for export. */
const EXPORT_IGNORE_DIRS = new Set(['node_modules', '.git', 'test-results', 'playwright-report']);

/** Artifact roots written by Playwright's capture policy (screenshots/videos/traces). */
const ARTIFACT_DIRS = ['test-results', 'playwright-report'];

/** Recursively list files under `dir`, returning paths relative to `dir`. */
async function listFilesRecursive(dir: string, opts: { ignore?: Set<string> } = {}): Promise<string[]> {
  const ignore = opts.ignore ?? new Set<string>();
  const out: string[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // directory missing or unreadable — skip silently
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        out.push(relative(dir, abs));
      }
    }
  };

  await walk(dir);
  out.sort();
  return out;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Real Playwright test engine. Scaffolds a standalone runnable project, drives
 * the provider to generate specs, executes them, and reports artifacts — the
 * generated project IS the exportable suite.
 */
export function createPlaywrightMode(): TestMode {
  return {
    id: 'playwright',

    scaffold(ctx: TestModeContext): Promise<void> {
      return scaffold(ctx);
    },

    generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
      return generate(ctx, plan);
    },

    validate(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ValidationResult> {
      return validateSuite(ctx, specs);
    },

    countScenarios(contents: string): number {
      return splitTestBlocks(contents).length;
    },

    execute(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
      return execute(ctx, specs);
    },

    async collectArtifacts(ctx: TestModeContext): Promise<{ dir: string; files: string[] }> {
      ctx.emit?.('artifacts', 'Collecting Playwright artifacts');
      const files: string[] = [];
      for (const sub of ARTIFACT_DIRS) {
        const abs = join(ctx.projectDir, sub);
        if (!(await dirExists(abs))) continue;
        const rel = await listFilesRecursive(abs);
        for (const f of rel) files.push(join(sub, f));
      }
      ctx.emit?.('artifacts', `Collected ${files.length} artifact file(s)`, { count: files.length });
      return { dir: ctx.projectDir, files };
    },

    async export(ctx: TestModeContext): Promise<SuiteBundle> {
      ctx.emit?.('export', 'Listing suite files for export');
      // The scaffolded/generated project is the suite. Zipping is the core
      // export module's job; here we only enumerate the runnable source tree
      // (excluding node_modules and run artifacts).
      const files = await listFilesRecursive(ctx.projectDir, { ignore: EXPORT_IGNORE_DIRS });
      ctx.emit?.('export', `Suite has ${files.length} file(s)`, { count: files.length });
      return { dir: ctx.projectDir, files };
    },
  };
}
