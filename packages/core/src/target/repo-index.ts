import fs from 'node:fs';
import path from 'node:path';
import type { RepoIndex } from './types.js';
import { detect } from './detector.js';

/** Directory names never descended into during the walk. */
const SKIP_DIRS = new Set<string>([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.cache',
  '.parcel-cache',
  '.vercel',
  '.output',
  'out',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.idea',
  '.vscode',
  'target', // rust/java build output
  'vendor',
]);

/** Top-level dirs we call out in the summary when present. */
const KEY_DIRS = [
  'src',
  'app',
  'pages',
  'components',
  'lib',
  'server',
  'api',
  'routes',
  'public',
  'tests',
  'test',
  'e2e',
  'apps',
  'packages',
];

/** Map common extensions to a coarse language bucket for the language mix. */
const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
};

interface WalkResult {
  files: string[];
  truncated: boolean;
  langCounts: Map<string, number>;
}

/**
 * Iterative breadth-first walk so that shallow, more-relevant files are
 * collected first when we hit the maxFiles cap. Skips SKIP_DIRS and dotfiles
 * directories other than a small allowlist. Symlinks are not followed.
 */
function walk(root: string, maxFiles: number): WalkResult {
  const files: string[] = [];
  const langCounts = new Map<string, number>();
  let truncated = false;

  // queue of absolute dir paths to visit (BFS).
  const queue: string[] = [root];

  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }

    // Stable order so output is deterministic.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const subDirs: string[] = [];
    for (const entry of entries) {
      const name = entry.name;

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        // Skip hidden dirs except a couple useful ones.
        if (name.startsWith('.') && name !== '.github' && name !== '.healix') continue;
        subDirs.push(path.join(dir, name));
        continue;
      }

      if (!entry.isFile()) continue;

      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }

      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      files.push(rel);

      const ext = path.extname(name).toLowerCase();
      const lang = EXT_LANG[ext];
      if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
    }

    if (files.length >= maxFiles) {
      truncated = true;
      // Drain remaining queue check happens via the outer while; mark and stop
      // descending further by clearing the queue.
      break;
    }

    // Enqueue sub-dirs after files so BFS visits this whole level first.
    for (const sub of subDirs) queue.push(sub);
  }

  return { files, truncated, langCounts };
}

function topLevelDirs(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const present = new Set<string>();
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
      present.add(e.name);
    }
  }
  return KEY_DIRS.filter((d) => present.has(d));
}

function describeLanguageMix(langCounts: Map<string, number>): string {
  const total = [...langCounts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return 'no recognized source files';
  const ranked = [...langCounts.entries()].sort((a, b) => b[1] - a[1]);
  const parts = ranked.slice(0, 4).map(([lang, count]) => `${lang} ${Math.round((count / total) * 100)}%`);
  return parts.join(', ');
}

/**
 * Build an indexed view of a repo: a bounded list of relative file paths plus a
 * short natural-language summary (framework, key dirs, language mix, count) for
 * AI context. Fully defensive against unreadable / missing directories.
 */
export async function indexRepo(repoPath: string, opts?: { maxFiles?: number }): Promise<RepoIndex> {
  const root = path.resolve(repoPath);
  const maxFiles = opts?.maxFiles ?? 400;

  const { files, truncated, langCounts } = walk(root, maxFiles);

  let framework: string | null = null;
  try {
    framework = (await detect(root)).framework;
  } catch {
    framework = null;
  }

  const keyDirs = topLevelDirs(root);
  const langMix = describeLanguageMix(langCounts);

  const summaryParts: string[] = [];
  summaryParts.push(`Framework: ${framework ?? 'unknown'}.`);
  if (keyDirs.length > 0) summaryParts.push(`Key directories: ${keyDirs.join(', ')}.`);
  summaryParts.push(`Languages: ${langMix}.`);
  summaryParts.push(`${files.length}${truncated ? `+ (capped at ${maxFiles})` : ''} files indexed.`);

  return {
    root,
    files,
    summary: summaryParts.join(' '),
  };
}
