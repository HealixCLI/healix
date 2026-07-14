/**
 * Canonical-suite mechanics: discovery of REQ tags from spec files on disk,
 * seeding a run suite from the canonical dir, banking validated specs back
 * (manifest bookkeeping included), stale flagging, and the path-scoped git
 * commit that shares banked specs with teammates.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bankSpecs,
  canonicalSuiteDir,
  commitSuite,
  coveredReqTags,
  discoverSpecs,
  gitDiffStat,
  gitHead,
  isGitWorkTree,
  markStale,
  readManifest,
  seedRunSuite,
} from './canonical.js';
import type { GeneratedSpec } from '../modes/types.js';

let repo: string;
let runSuite: string;

const LOGIN_SPEC = `import { test, expect } from '@playwright/test';
test('[REQ:REQ-005] Seeded login lands on dashboard', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/dashboard/);
});
`;

const API_SPEC = `import { test, expect } from '@playwright/test';
test.describe('[REQ:REQ-009] Health endpoint', () => {
  test('returns ok', async ({ request }) => {
    expect((await request.get('/api/health')).status()).toBe(200);
  });
});
`;

async function writeCanonicalSpec(relPath: string, contents: string): Promise<void> {
  const abs = join(canonicalSuiteDir(repo), ...relPath.split('/'));
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, contents, 'utf-8');
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'healix-canonical-'));
  runSuite = mkdtempSync(join(tmpdir(), 'healix-runsuite-'));
  await mkdir(join(runSuite, 'tests'), { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(runSuite, { recursive: true, force: true });
});

describe('discoverSpecs / coveredReqTags', () => {
  it('finds specs, their tiers from the path, and every REQ tag in the source', async () => {
    await writeCanonicalSpec('tests/tierB-auth/login.spec.ts', LOGIN_SPEC);
    await writeCanonicalSpec('tests/tierC-api/health.spec.ts', API_SPEC);

    const specs = await discoverSpecs(canonicalSuiteDir(repo));
    expect(specs).toHaveLength(2);
    const byTag = Object.fromEntries(specs.map((s) => [s.reqTags[0], s]));
    expect(byTag['REQ-005']?.tier).toBe('tierB-auth');
    expect(byTag['REQ-005']?.title).toContain('[REQ:REQ-005]');
    expect(byTag['REQ-009']?.tier).toBe('tierC-api');

    expect([...coveredReqTags(specs)].sort()).toEqual(['REQ-005', 'REQ-009']);
  });

  it('returns empty for a repo with no canonical suite', async () => {
    expect(await discoverSpecs(canonicalSuiteDir(repo))).toEqual([]);
  });
});

describe('seedRunSuite', () => {
  it('copies canonical specs into the run suite and returns GeneratedSpec entries', async () => {
    await writeCanonicalSpec('tests/tierB-auth/login.spec.ts', LOGIN_SPEC);

    const seeded = await seedRunSuite(repo, runSuite);
    expect(seeded).toHaveLength(1);
    expect(seeded[0].reqTag).toBe('REQ-005');
    expect(seeded[0].tier).toBe('tierB-auth');
    expect(existsSync(join(runSuite, 'tests', 'tierB-auth', 'login.spec.ts'))).toBe(true);
  });
});

describe('bankSpecs / manifest', () => {
  it('copies run-suite specs into the canonical dir and records them in the manifest', async () => {
    const specPath = join(runSuite, 'tests', 'tierA-public', 'landing.spec.ts');
    await mkdir(join(specPath, '..'), { recursive: true });
    await writeFile(specPath, "test('[REQ:REQ-001] landing', () => {});\n", 'utf-8');
    const spec: GeneratedSpec = {
      path: specPath,
      title: '[REQ:REQ-001] landing',
      reqTag: 'REQ-001',
      tier: 'tierA-public',
      contents: '',
    };

    const written = await bankSpecs(repo, runSuite, [spec], { runId: 'run_x', commit: 'abc123' });
    expect(written).toContain('.healix/suite/tests/tierA-public/landing.spec.ts');
    expect(written).toContain('.healix/suite/manifest.json');
    expect(existsSync(join(canonicalSuiteDir(repo), 'tests', 'tierA-public', 'landing.spec.ts'))).toBe(true);

    const manifest = await readManifest(canonicalSuiteDir(repo));
    expect(manifest.specs['REQ-001']?.file).toBe('tests/tierA-public/landing.spec.ts');
    expect(manifest.specs['REQ-001']?.commit).toBe('abc123');
    expect(manifest.specs['REQ-001']?.status).toBe('active');
    expect(manifest.lastRun?.runId).toBe('run_x');
  });

  it('refuses paths outside the run suite tests/ tree', async () => {
    const outside = join(tmpdir(), 'healix-outside.spec.ts');
    await writeFile(outside, 'x', 'utf-8');
    const spec: GeneratedSpec = { path: outside, title: 't', tier: 'tierA-public', contents: '' };
    expect(await bankSpecs(repo, runSuite, [spec], { runId: 'r', commit: null })).toEqual([]);
    rmSync(outside, { force: true });
  });
});

describe('markStale', () => {
  it('flags known tags and reports exactly which were flipped', async () => {
    const specPath = join(runSuite, 'tests', 'tierA-public', 'landing.spec.ts');
    await mkdir(join(specPath, '..'), { recursive: true });
    await writeFile(specPath, "test('[REQ:REQ-001] landing', () => {});\n", 'utf-8');
    await bankSpecs(
      repo,
      runSuite,
      [{ path: specPath, title: 'landing', reqTag: 'REQ-001', tier: 'tierA-public', contents: '' }],
      { runId: 'r', commit: null },
    );

    const flagged = await markStale(repo, ['REQ-001', 'REQ-404'], 'auth flow changed');
    expect(flagged).toEqual(['REQ-001']);
    const manifest = await readManifest(canonicalSuiteDir(repo));
    expect(manifest.specs['REQ-001']?.status).toBe('stale');
    expect(manifest.specs['REQ-001']?.staleReason).toBe('auth flow changed');
  });
});

describe('git plumbing', () => {
  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
  }

  function initRepo(): void {
    git('init', '-q');
    git('config', 'user.email', 'test@healix.dev');
    git('config', 'user.name', 'Healix Test');
    git('config', 'commit.gpgsign', 'false');
  }

  it('detects work trees and resolves HEAD', async () => {
    expect(await isGitWorkTree(repo)).toBe(false);
    initRepo();
    await writeFile(join(repo, 'app.js'), 'console.log(1);\n', 'utf-8');
    git('add', '.');
    git('commit', '-qm', 'init');
    expect(await isGitWorkTree(repo)).toBe(true);
    expect(await gitHead(repo)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('commitSuite commits ONLY the canonical suite paths and reports unchanged re-runs', async () => {
    initRepo();
    await writeFile(join(repo, 'app.js'), 'console.log(1);\n', 'utf-8');
    git('add', '.');
    git('commit', '-qm', 'init');

    // Unrelated dirty user file must never be swept into Healix's commit.
    await writeFile(join(repo, 'user-wip.js'), 'work in progress\n', 'utf-8');

    const specPath = join(runSuite, 'tests', 'tierA-public', 'landing.spec.ts');
    await mkdir(join(specPath, '..'), { recursive: true });
    await writeFile(specPath, "test('[REQ:REQ-001] landing', () => {});\n", 'utf-8');
    await bankSpecs(
      repo,
      runSuite,
      [{ path: specPath, title: 'landing', reqTag: 'REQ-001', tier: 'tierA-public', contents: '' }],
      { runId: 'r', commit: await gitHead(repo) },
    );

    const first = await commitSuite(repo, 'test(healix): top up suite');
    expect(first.committed).toBe(true);
    const show = git('show', '--stat', '--name-only', 'HEAD');
    expect(show).toContain('.healix/suite/tests/tierA-public/landing.spec.ts');
    expect(show).toContain('.healix/suite/manifest.json');
    expect(show).not.toContain('user-wip.js');
    // The user's WIP file is still there, untouched and uncommitted.
    expect(git('status', '--porcelain').trim()).toContain('user-wip.js');

    const second = await commitSuite(repo, 'test(healix): top up suite');
    expect(second.committed).toBe(false);
    expect(second.detail).toBe('suite unchanged');
  });

  it('gitDiffStat reports app changes since a commit, excluding the suite dir', async () => {
    initRepo();
    await writeFile(join(repo, 'app.js'), 'console.log(1);\n', 'utf-8');
    git('add', '.');
    git('commit', '-qm', 'init');
    const base = await gitHead(repo);

    await writeFile(join(repo, 'app.js'), 'console.log(2);\nconsole.log(3);\n', 'utf-8');
    await writeCanonicalSpec('tests/tierA-public/x.spec.ts', "test('[REQ:X] x', () => {});\n");
    git('add', '.');
    git('commit', '-qm', 'change app + suite');

    const stat = await gitDiffStat(repo, base as string);
    expect(stat).toContain('app.js');
    expect(stat).not.toContain('x.spec.ts');
  });
});
