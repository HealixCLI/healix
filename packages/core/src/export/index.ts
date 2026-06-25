import fs from 'node:fs/promises';
import path from 'node:path';
import type { SuiteBundle } from '../modes/types.js';
import { isTextFile, sanitizeContent } from './sanitize.js';
import { zipDirectory } from './zip.js';

export interface ExportOptions {
  /** Directory containing the generated, runnable suite. */
  suiteDir: string;
  /** Destination directory for the exported bundle. */
  outDir: string;
  /** Strip secrets / local absolute paths (default true). */
  sanitize?: boolean;
  /** Also produce a .zip (default true). */
  zip?: boolean;
}

/** Directory names excluded from the export at any depth. */
const EXCLUDED_DIRS = new Set<string>([
  'node_modules',
  'test-results',
  'playwright-report',
  '.git',
]);

/**
 * Decide whether a directory entry should be excluded from the export.
 * Mirrors the exclusion rules in the module spec (build artefacts, VCS,
 * captured auth state, dotenv files, and logs).
 */
function isExcluded(name: string, isDirectory: boolean): boolean {
  if (isDirectory) {
    return EXCLUDED_DIRS.has(name);
  }
  // auth-state-*.json (captured login/session state).
  if (/^auth-state-.*\.json$/i.test(name)) return true;
  // .env, .env.local, .env.production, etc.
  if (/^\.env(\..+)?$/i.test(name)) return true;
  // *.log
  if (/\.log$/i.test(name)) return true;
  return false;
}

/**
 * Recursively copy `srcDir` into `destDir`, honouring the exclusion rules.
 * Text files are sanitized in place when `sanitize` is true. Symlinks are
 * dereferenced (copied as their target's contents) to keep the bundle
 * self-contained; broken/circular links are skipped defensively.
 *
 * `rootSrcDir` is the original suite root, used as the sanitization anchor so
 * the same absolute prefix is stripped consistently at every depth.
 */
async function copyTree(
  srcDir: string,
  destDir: string,
  rootSrcDir: string,
  rootDestDir: string,
  sanitize: boolean,
  visited: Set<string>,
): Promise<void> {
  // Cycle guard: resolve to the canonical path and skip directories we have
  // already entered, so a self/ancestor directory symlink cannot loop forever.
  let canonical: string;
  try {
    canonical = await fs.realpath(srcDir);
  } catch {
    // Missing/dangling — nothing to copy.
    return;
  }
  if (visited.has(canonical)) return;
  visited.add(canonical);

  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch {
    // Missing optional directory — nothing to copy.
    return;
  }

  await fs.mkdir(destDir, { recursive: true });

  for (const entry of entries) {
    const name = entry.name;
    const srcPath = path.join(srcDir, name);
    const destPath = path.join(destDir, name);

    // Guard against the output directory living inside the source tree, which
    // would otherwise cause the export to recursively copy itself.
    if (path.resolve(srcPath) === rootDestDir) continue;

    // Resolve symlinks to a real entry type before applying rules.
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const st = await fs.stat(srcPath);
        isDirectory = st.isDirectory();
        isFile = st.isFile();
      } catch {
        // Dangling symlink — skip.
        continue;
      }
    }

    if (isExcluded(name, isDirectory)) continue;

    if (isDirectory) {
      await copyTree(srcPath, destPath, rootSrcDir, rootDestDir, sanitize, visited);
      continue;
    }

    if (!isFile) {
      // Sockets, FIFOs, devices — skip.
      continue;
    }

    await copyFile(srcPath, destPath, rootSrcDir, sanitize);
  }
}

/** Convert an OS path to POSIX separators for portable manifests. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Copy a single file, optionally sanitizing text contents. Binary files are
 * streamed verbatim via `fs.copyFile`.
 */
async function copyFile(
  srcPath: string,
  destPath: string,
  rootSrcDir: string,
  sanitize: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  if (sanitize && isTextFile(srcPath)) {
    let raw: string;
    try {
      raw = await fs.readFile(srcPath, 'utf8');
    } catch {
      // Unreadable as utf8 (e.g. binary with a text extension) — copy raw.
      await fs.copyFile(srcPath, destPath);
      return;
    }
    const cleaned = sanitizeContent(raw, rootSrcDir);
    await fs.writeFile(destPath, cleaned, 'utf8');
    return;
  }

  await fs.copyFile(srcPath, destPath);
}

/**
 * Walk `dir` recursively and return every file's path relative to `dir`,
 * using POSIX separators and sorted for deterministic output.
 */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(toPosix(path.relative(dir, full)));
      }
    }
  }
  await walk(dir);
  out.sort();
  return out;
}

/**
 * Export a generated, runnable suite into a standalone, shareable bundle.
 *
 * Produces `outDir` (a sanitized copy of `suiteDir` minus build artefacts,
 * VCS data, captured auth state, dotenv files, and logs) and, by default, a
 * sibling `<outDir>.zip`. Returns a {@link SuiteBundle} describing the result.
 *
 * Defensive: creates `outDir` if absent, never throws on a missing optional
 * source directory, and never leaves a partial process resource open.
 */
export async function exportSuite(opts: ExportOptions): Promise<SuiteBundle> {
  const sanitize = opts.sanitize ?? true;
  const makeZip = opts.zip ?? true;

  const suiteDir = path.resolve(opts.suiteDir);
  const outDir = path.resolve(opts.outDir);

  // Always materialise the destination, even for an empty/missing source.
  await fs.mkdir(outDir, { recursive: true });

  // Copy the tree. The file manifest is rebuilt authoritatively via listFiles
  // afterwards to guarantee it reflects exactly what landed on disk. A shared
  // visited-set provides a cycle guard against directory symlink loops.
  await copyTree(suiteDir, outDir, suiteDir, outDir, sanitize, new Set<string>());

  const files = await listFiles(outDir);

  const bundle: SuiteBundle = { dir: outDir, files };

  if (makeZip) {
    const zipPath = `${outDir}.zip`;
    try {
      const result = await zipDirectory(outDir, zipPath);
      bundle.zipPath = result.zipPath;
    } catch {
      // Zipping is best-effort: a failed archive must not invalidate the
      // already-written, sanitized directory bundle. Leave zipPath unset.
    }
  }

  return bundle;
}
