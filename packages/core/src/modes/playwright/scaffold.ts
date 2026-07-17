import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TestModeContext } from '../types.js';
import {
  TIERS,
  authSetupContents,
  gitignoreContents,
  mockFixtureContents,
  packageJsonContents,
  playwrightConfigContents,
  suiteReadmeContents,
  tierReadmeContents,
  type MockRouteEntry,
} from './templates.js';

/** Route-intercept/both dependencies with resolved mock content, for the mock fixture. */
function mockRouteEntries(ctx: TestModeContext): MockRouteEntry[] {
  const deps = ctx.externalDependencies ?? [];
  const responses = ctx.mockResponses ?? {};
  const entries: MockRouteEntry[] = [];
  for (const dep of deps) {
    if (dep.mockStrategy !== 'route-intercept' && dep.mockStrategy !== 'both') continue;
    if (!dep.hostnames || dep.hostnames.length === 0) continue;
    const response = responses[dep.id];
    if (!response) continue;
    entries.push({ id: dep.id, hostnames: dep.hostnames, response });
  }
  return entries;
}

function emit(ctx: TestModeContext, message: string, data?: unknown): void {
  ctx.emit?.('scaffold', message, data);
}

/** Best-effort: derive a friendly package name from the project dir basename. */
function suiteName(projectDir: string): string {
  const base = projectDir.split(/[\\/]/).filter(Boolean).pop() ?? 'healix-suite';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'healix-suite';
}

/**
 * Lay down a standalone, runnable Playwright project under ctx.projectDir:
 * package.json, playwright.config.ts (tiers as projects), per-tier test dirs,
 * fixtures (auth setup) and READMEs. Idempotent — safe to re-run.
 */
export async function scaffold(ctx: TestModeContext): Promise<void> {
  const { projectDir } = ctx;
  emit(ctx, `Scaffolding Playwright suite at ${projectDir}`);

  await mkdir(projectDir, { recursive: true });

  // Directory layout.
  const testsDir = join(projectDir, 'tests');
  const fixturesDir = join(projectDir, 'fixtures');
  const authDir = join(fixturesDir, '.auth');
  await mkdir(testsDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(authDir, { recursive: true });

  for (const tier of TIERS) {
    const tierDir = join(testsDir, tier);
    await mkdir(tierDir, { recursive: true });
    await writeFile(join(tierDir, 'README.md'), tierReadmeContents(tier), 'utf-8');
  }

  // Project files.
  const files: Array<[string, string]> = [
    [join(projectDir, 'package.json'), packageJsonContents({ name: suiteName(projectDir) })],
    [join(projectDir, 'playwright.config.ts'), playwrightConfigContents({ baseUrl: ctx.baseUrl })],
    [join(fixturesDir, 'auth.setup.ts'), authSetupContents()],
    [join(projectDir, 'README.md'), suiteReadmeContents({ baseUrl: ctx.baseUrl })],
    [join(projectDir, '.gitignore'), gitignoreContents()],
  ];

  for (const [filePath, contents] of files) {
    await writeFile(filePath, contents, 'utf-8');
  }

  // Keep an empty anonymous storageState so Tier B can load before any login.
  await writeFile(join(authDir, 'user.json'), JSON.stringify({ cookies: [], origins: [] }), 'utf-8');

  // Mock fixture: always written when mocking is enabled for the run (even with
  // zero route-intercept dependencies — an empty routes list is a harmless
  // passthrough), so generate.ts's import path always resolves.
  if (ctx.mockExternalDependencies) {
    const routes = mockRouteEntries(ctx);
    await writeFile(join(fixturesDir, 'mock.fixture.ts'), mockFixtureContents(routes), 'utf-8');
    emit(ctx, `Wrote mock fixture with ${routes.length} route(s)`, { routes: routes.map((r) => r.id) });
  }

  emit(ctx, 'Scaffold complete', { tiers: TIERS });
}
