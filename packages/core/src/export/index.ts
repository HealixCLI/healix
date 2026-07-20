import fs from 'node:fs/promises';
import path from 'node:path';
import type { SuiteBundle } from '../modes/types.js';
import { isTextFile, sanitizeContent, type ExportCredential } from './sanitize.js';
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
  /**
   * The project's own test-login credentials, if any — passed through so
   * sanitize can redact literal occurrences (e.g. a hardcoded password in a
   * generated spec) that the generic secret patterns wouldn't catch.
   */
  credentials?: ExportCredential[];
}

/** Bundle info returned by {@link exportSuite}: a {@link SuiteBundle} plus
 * the list of entries skipped for safety (backward-compatible extension). */
export interface ExportedSuiteBundle extends SuiteBundle {
  /**
   * Suite-relative POSIX paths of entries that were deliberately NOT copied
   * for safety reasons (currently: symlinks whose real target escapes the
   * suite root). Empty when nothing was skipped.
   */
  skipped: string[];
}

/** Directory names excluded from the export at any depth. */
const EXCLUDED_DIRS = new Set<string>([
  'node_modules',
  'test-results',
  'playwright-report',
  '.git',
  // `.auth` holds live browser storageState (real cookies / auth tokens)
  // written by the auth fixture — exporting it leaks working credentials.
  '.auth',
]);

/**
 * File names excluded only when they sit at the suite root. Playwright's JSON
 * report (`results.json`) and run bookkeeping (`.last-run.json`) can embed
 * response bodies/headers captured from the app under test, so they must not
 * ship in a shareable bundle. Same-named files nested deeper (e.g. user
 * fixtures) are left alone.
 */
const ROOT_EXCLUDED_FILES = new Set<string>(['results.json', '.last-run.json']);

/**
 * Decide whether a directory entry should be excluded from the export.
 * Mirrors the exclusion rules in the module spec (build artefacts, VCS,
 * captured auth state, runner reports, dotenv files, OS metadata, and logs).
 */
function isExcluded(name: string, isDirectory: boolean, atRoot: boolean): boolean {
  if (isDirectory) {
    return EXCLUDED_DIRS.has(name);
  }
  // Playwright report / bookkeeping files at the suite root.
  if (atRoot && ROOT_EXCLUDED_FILES.has(name)) return true;
  // auth-state-*.json (captured login/session state).
  if (/^auth-state-.*\.json$/i.test(name)) return true;
  // .env, .env.local, .env.production, etc.
  if (/^\.env(\..+)?$/i.test(name)) return true;
  // *.log
  if (/\.log$/i.test(name)) return true;
  // macOS Finder metadata — never useful in a shared bundle.
  if (name === '.DS_Store') return true;
  return false;
}

/** Shared state threaded through the recursive copy. */
interface CopyContext {
  /** Original suite root (resolved); sanitization anchor + root-file rules. */
  rootSrcDir: string;
  /** Resolved output root, so the export never recurses into itself. */
  rootDestDir: string;
  /** `realpath` of the suite root — the containment boundary for symlinks. */
  realRootDir: string;
  /** Strip secrets / local absolute paths from text files. */
  sanitize: boolean;
  /** The project's own test-login credentials, for literal-value redaction. */
  credentials: ExportCredential[] | undefined;
  /** Canonical directories already entered (symlink-cycle guard). */
  visited: Set<string>;
  /** Suite-relative paths skipped for safety (outward symlinks). */
  skipped: string[];
}

/**
 * Recursively copy `srcDir` into `destDir`, honouring the exclusion rules.
 * Text files are sanitized in place when `ctx.sanitize` is true. Symlinks
 * whose real target stays inside the suite root are dereferenced (copied as
 * their target's contents) to keep the bundle self-contained; broken/circular
 * links are skipped defensively.
 *
 * Symlink containment: a symlink whose real target resolves OUTSIDE the suite
 * root is skipped and recorded in `ctx.skipped`. Dereferencing an outward
 * link is an exfiltration primitive — e.g. `ln -s ~/.ssh/id_rsa key.txt`
 * inside the suite would otherwise silently copy the private key into a
 * bundle that is meant to be shared.
 */
async function copyTree(srcDir: string, destDir: string, ctx: CopyContext): Promise<void> {
  // Cycle guard: resolve to the canonical path and skip directories we have
  // already entered, so a self/ancestor directory symlink cannot loop forever.
  let canonical: string;
  try {
    canonical = await fs.realpath(srcDir);
  } catch {
    // Missing/dangling — nothing to copy.
    return;
  }
  if (ctx.visited.has(canonical)) return;
  ctx.visited.add(canonical);

  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch {
    // Missing optional directory — nothing to copy.
    return;
  }

  await fs.mkdir(destDir, { recursive: true });

  const atRoot = srcDir === ctx.rootSrcDir;

  for (const entry of entries) {
    const name = entry.name;
    const srcPath = path.join(srcDir, name);
    const destPath = path.join(destDir, name);

    // Guard against the output directory living inside the source tree, which
    // would otherwise cause the export to recursively copy itself.
    if (path.resolve(srcPath) === ctx.rootDestDir) continue;

    // Resolve symlinks to a real entry type before applying rules.
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // Containment check: refuse to dereference links that escape the suite
      // root (see the function doc-comment — outward links are an
      // exfiltration primitive). Record the skip so callers can surface it.
      let realTarget: string;
      try {
        realTarget = await fs.realpath(srcPath);
      } catch {
        // Dangling symlink — skip silently, as before.
        continue;
      }
      const rel = path.relative(ctx.realRootDir, realTarget);
      const escapes = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
      if (escapes) {
        ctx.skipped.push(toPosix(path.relative(ctx.rootSrcDir, srcPath)));
        continue;
      }
      try {
        const st = await fs.stat(srcPath);
        isDirectory = st.isDirectory();
        isFile = st.isFile();
      } catch {
        // Dangling symlink — skip.
        continue;
      }
    }

    if (isExcluded(name, isDirectory, atRoot)) continue;

    if (isDirectory) {
      await copyTree(srcPath, destPath, ctx);
      continue;
    }

    if (!isFile) {
      // Sockets, FIFOs, devices — skip.
      continue;
    }

    await copyFile(srcPath, destPath, ctx.rootSrcDir, ctx.sanitize, ctx.credentials);
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
  credentials: ExportCredential[] | undefined,
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
    const cleaned = sanitizeContent(raw, rootSrcDir, credentials);
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
 * VCS data, captured auth state, runner reports, dotenv files, and logs) and,
 * by default, a sibling `<outDir>.zip`. Returns an {@link ExportedSuiteBundle}
 * describing the result, including any entries skipped for safety.
 *
 * Defensive: creates `outDir` if absent, never throws on a missing optional
 * source directory, and never leaves a partial process resource open.
 */
export async function exportSuite(opts: ExportOptions): Promise<ExportedSuiteBundle> {
  const sanitize = opts.sanitize ?? true;
  const makeZip = opts.zip ?? true;

  const suiteDir = path.resolve(opts.suiteDir);
  const outDir = path.resolve(opts.outDir);

  // Always materialise the destination, even for an empty/missing source.
  await fs.mkdir(outDir, { recursive: true });

  // Canonical suite root: the containment boundary for symlink targets.
  // (Falls back to the resolved path when the source does not exist yet.)
  let realRootDir: string;
  try {
    realRootDir = await fs.realpath(suiteDir);
  } catch {
    realRootDir = suiteDir;
  }

  // Copy the tree. The file manifest is rebuilt authoritatively via listFiles
  // afterwards to guarantee it reflects exactly what landed on disk. A shared
  // visited-set provides a cycle guard against directory symlink loops.
  const skipped: string[] = [];
  await copyTree(suiteDir, outDir, {
    rootSrcDir: suiteDir,
    rootDestDir: outDir,
    realRootDir,
    sanitize,
    credentials: opts.credentials,
    visited: new Set<string>(),
    skipped,
  });

  const files = await listFiles(outDir);

  const bundle: ExportedSuiteBundle = { dir: outDir, files, skipped };

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
