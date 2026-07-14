import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { Tier } from '../storage/types.js';
import type { GeneratedSpec } from '../modes/types.js';
import { runCli } from '../exec/run-cli.js';

/**
 * The canonical suite is the durable, team-shared home of generated tests:
 * `.healix/suite` inside the repo under test, committed to git. Every run
 * seeds its working suite from here, generates only what is missing, and
 * writes validated specs back — so runs TOP UP one shared suite instead of
 * regenerating from scratch, and teammates receive each other's tests through
 * ordinary pulls.
 */
export const CANONICAL_SUITE_RELDIR = join('.healix', 'suite');

export function canonicalSuiteDir(repoPath: string): string {
  return join(repoPath, CANONICAL_SUITE_RELDIR);
}

/** One canonical spec's bookkeeping in the manifest. */
export interface SuiteManifestEntry {
  /** Repo-relative spec path inside the canonical suite (tests/<tier>/<slug>.spec.ts). */
  file: string;
  title: string;
  tier: Tier;
  /** Commit SHA of the app repo when this spec was generated/last validated (null: unknown). */
  commit: string | null;
  generatedAt: string;
  /** 'stale' = the plan flagged this spec's covered behavior as changed since generation. */
  status: 'active' | 'stale';
  staleReason?: string;
}

export interface SuiteManifest {
  version: 1;
  /** Keyed by REQ tag — the stable identity for dedup across runs and teammates. */
  specs: Record<string, SuiteManifestEntry>;
  /** Advanced only when a run banks new/repaired specs; anchors the git-diff window. */
  lastRun?: { runId: string; commit: string | null; at: string };
}

const EMPTY_MANIFEST: SuiteManifest = { version: 1, specs: {} };

export async function readManifest(suiteDir: string): Promise<SuiteManifest> {
  try {
    const raw = await readFile(join(suiteDir, 'manifest.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as SuiteManifest).version === 1 &&
      typeof (parsed as SuiteManifest).specs === 'object'
    ) {
      return parsed as SuiteManifest;
    }
  } catch {
    /* absent or unreadable — start empty */
  }
  return { ...EMPTY_MANIFEST, specs: {} };
}

export async function writeManifest(suiteDir: string, manifest: SuiteManifest): Promise<void> {
  await mkdir(suiteDir, { recursive: true });
  await writeFile(join(suiteDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

const REQ_TAG_RE = /\[REQ:([^\]\s]+)\]/g;
const KNOWN_TIERS: readonly Tier[] = ['tierA-public', 'tierB-auth', 'tierC-api'];

function tierFromRelPath(relPath: string): Tier {
  const segments = relPath.split(/[\\/]/);
  const hit = segments.find((s) => (KNOWN_TIERS as readonly string[]).includes(s));
  return (hit as Tier) ?? 'tierA-public';
}

/** First test/test.describe title in a spec source, for display purposes. */
function firstTitle(source: string, fallback: string): string {
  const m = source.match(/\b(?:test|test\.describe)\s*(?:\.\w+)?\s*\(\s*['"`]([^'"`]+)['"`]/);
  return m?.[1] ?? fallback;
}

/** A spec discovered on disk in a suite's tests/ tree. */
export interface DiscoveredSpec {
  /** Path relative to the suite dir (tests/<tier>/<name>.spec.ts). */
  relPath: string;
  title: string;
  tier: Tier;
  /** Every [REQ:...] tag found in the source (first one is the primary). */
  reqTags: string[];
  contents: string;
}

/**
 * Scan a suite dir's tests/ tree for *.spec.ts files and their REQ tags.
 * The FILES are the ground truth (teammates may hand-write or hand-edit specs
 * without touching the manifest); the manifest only adds bookkeeping.
 */
export async function discoverSpecs(suiteDir: string): Promise<DiscoveredSpec[]> {
  const testsDir = join(suiteDir, 'tests');
  if (!existsSync(testsDir)) return [];
  const out: DiscoveredSpec[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (/\.spec\.[cm]?[jt]sx?$/.test(entry.name)) {
        let contents = '';
        try {
          contents = await readFile(abs, 'utf-8');
        } catch {
          continue;
        }
        const relPath = relative(suiteDir, abs).split(sep).join('/');
        const reqTags = [...contents.matchAll(REQ_TAG_RE)].map((m) => m[1]);
        out.push({
          relPath,
          title: firstTitle(contents, entry.name),
          tier: tierFromRelPath(relPath),
          reqTags,
          contents,
        });
      }
    }
  };
  await walk(testsDir);
  return out;
}

/** All REQ tags covered by a set of discovered specs. */
export function coveredReqTags(specs: DiscoveredSpec[]): Set<string> {
  const tags = new Set<string>();
  for (const spec of specs) for (const tag of spec.reqTags) tags.add(tag);
  return tags;
}

/**
 * Copy the canonical suite's specs into a run's working suite dir (which has
 * just been scaffolded). Returns the seeded specs as GeneratedSpec entries so
 * the orchestrator can persist/triage them exactly like freshly generated
 * ones. Best-effort per file: one unreadable spec must not sink the seed.
 */
export async function seedRunSuite(repoPath: string, runSuiteDir: string): Promise<GeneratedSpec[]> {
  const suiteDir = canonicalSuiteDir(repoPath);
  const discovered = await discoverSpecs(suiteDir);
  const seeded: GeneratedSpec[] = [];
  for (const spec of discovered) {
    const dest = join(runSuiteDir, ...spec.relPath.split('/'));
    try {
      await mkdir(join(dest, '..'), { recursive: true });
      await copyFile(join(suiteDir, ...spec.relPath.split('/')), dest);
    } catch {
      continue;
    }
    seeded.push({
      path: dest,
      title: spec.title,
      ...(spec.reqTags[0] ? { reqTag: spec.reqTags[0] } : {}),
      tier: spec.tier,
      contents: spec.contents,
    });
  }
  return seeded;
}

/**
 * Bank validated specs into the canonical suite and update the manifest.
 * `specs` paths point into the RUN suite dir; each file is copied to the same
 * tests/<tier>/... location in the canonical dir. Returns the repo-relative
 * paths that were written (empty = nothing banked).
 */
export async function bankSpecs(
  repoPath: string,
  runSuiteDir: string,
  specs: GeneratedSpec[],
  info: { runId: string; commit: string | null },
): Promise<string[]> {
  if (specs.length === 0) return [];
  const suiteDir = canonicalSuiteDir(repoPath);
  const manifest = await readManifest(suiteDir);
  const written: string[] = [];
  for (const spec of specs) {
    const relPath = relative(runSuiteDir, spec.path).split(sep).join('/');
    // Only bank files that actually live inside the run suite's tests/ tree.
    if (relPath.startsWith('..') || !relPath.startsWith('tests/')) continue;
    const dest = join(suiteDir, ...relPath.split('/'));
    await mkdir(join(dest, '..'), { recursive: true });
    await copyFile(spec.path, dest);
    written.push(`${CANONICAL_SUITE_RELDIR.split(sep).join('/')}/${relPath}`);
    const tag = spec.reqTag ?? `title:${spec.title.trim().toLowerCase().replace(/\s+/g, ' ')}`;
    manifest.specs[tag] = {
      file: relPath,
      title: spec.title,
      tier: spec.tier,
      commit: info.commit,
      generatedAt: new Date().toISOString(),
      status: 'active',
    };
  }
  if (written.length > 0) {
    manifest.lastRun = { runId: info.runId, commit: info.commit, at: new Date().toISOString() };
    await writeManifest(suiteDir, manifest);
    written.push(`${CANONICAL_SUITE_RELDIR.split(sep).join('/')}/manifest.json`);
  }
  return written;
}

/** Flag canonical specs whose covered behavior the plan says has changed. */
export async function markStale(repoPath: string, reqTags: string[], reason: string): Promise<string[]> {
  if (reqTags.length === 0) return [];
  const suiteDir = canonicalSuiteDir(repoPath);
  const manifest = await readManifest(suiteDir);
  const flagged: string[] = [];
  for (const tag of reqTags) {
    const entry = manifest.specs[tag];
    if (entry && entry.status !== 'stale') {
      entry.status = 'stale';
      entry.staleReason = reason;
      flagged.push(tag);
    }
  }
  if (flagged.length > 0) await writeManifest(suiteDir, manifest);
  return flagged;
}

// ---- git plumbing (all best-effort: a non-git repo disables these) ----------

type ExecCli = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; cwd?: string },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export async function isGitWorkTree(repoPath: string, exec: ExecCli = runCli): Promise<boolean> {
  const r = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath, timeoutMs: 15_000 });
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function gitHead(repoPath: string, exec: ExecCli = runCli): Promise<string | null> {
  const r = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoPath, timeoutMs: 15_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Bounded diffstat of the app repo since `commit` (excluding the suite itself). */
export async function gitDiffStat(
  repoPath: string,
  sinceCommit: string,
  exec: ExecCli = runCli,
): Promise<string | null> {
  const r = await exec(
    'git',
    [
      'diff',
      '--stat=120',
      `${sinceCommit}..HEAD`,
      '--',
      '.',
      `:(exclude)${CANONICAL_SUITE_RELDIR.split(sep).join('/')}`,
    ],
    { cwd: repoPath, timeoutMs: 30_000 },
  );
  if (r.code !== 0) return null;
  const text = r.stdout.trim();
  if (!text) return null;
  // Keep the prompt bounded on huge diffs: head + the summary line.
  const lines = text.split('\n');
  if (lines.length <= 60) return text;
  return [...lines.slice(0, 59), lines[lines.length - 1]].join('\n');
}

/**
 * Commit ONLY the canonical suite paths. Uses path-scoped `git commit -- <dir>`
 * so unrelated staged/unstaged user work is never swept into Healix's commit.
 * Never pushes — sharing with teammates stays an explicit human `git push`.
 */
export async function commitSuite(
  repoPath: string,
  message: string,
  exec: ExecCli = runCli,
): Promise<{ committed: boolean; detail: string }> {
  const dir = CANONICAL_SUITE_RELDIR.split(sep).join('/');
  const add = await exec('git', ['add', '--', dir], { cwd: repoPath, timeoutMs: 30_000 });
  if (add.code !== 0) return { committed: false, detail: `git add failed: ${add.stderr.trim()}` };
  // Anything to commit for these paths?
  const status = await exec('git', ['status', '--porcelain', '--', dir], {
    cwd: repoPath,
    timeoutMs: 15_000,
  });
  if (status.code !== 0) return { committed: false, detail: `git status failed: ${status.stderr.trim()}` };
  if (status.stdout.trim() === '') return { committed: false, detail: 'suite unchanged' };
  const commit = await exec('git', ['commit', '-m', message, '--', dir], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  if (commit.code !== 0)
    return { committed: false, detail: `git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}` };
  return { committed: true, detail: commit.stdout.split('\n')[0] ?? 'committed' };
}
