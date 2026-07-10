import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';

export interface ZipResult {
  /** Absolute path of the written archive. */
  zipPath: string;
  /** Total compressed/processed byte count reported by archiver. */
  bytes: number;
}

/**
 * Fixed timestamp stamped onto every archive entry.
 *
 * Reproducibility rationale: zip local file headers embed each entry's mtime,
 * so letting archiver use on-disk mtimes makes two exports of *identical
 * content* produce byte-different archives. That breaks content-addressed
 * caching, artifact deduplication, and "did this bundle actually change?"
 * checks (hash comparison in CI, signed-artifact verification). Pinning the
 * date — together with a sorted, stable entry order — makes the archive a
 * pure function of its contents.
 */
const FIXED_ENTRY_DATE = new Date('2000-01-01T00:00:00Z');

/**
 * Walk `root` recursively and return every file path relative to `root`,
 * POSIX-separated and sorted, so entries are appended in a stable order
 * regardless of the filesystem's readdir order.
 */
async function listFilesSorted(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

/**
 * Create a .zip archive of `sourceDir`, writing it to `zipPath`.
 *
 * The archive root contains the contents of `sourceDir` nested under a single
 * top-level folder named after `sourceDir`'s basename, so unzipping yields a
 * self-contained, named project directory.
 *
 * Deterministic: entries are appended in sorted order and every entry carries
 * {@link FIXED_ENTRY_DATE} instead of its on-disk mtime, so archiving the
 * same content always yields the same bytes (see the constant's doc-comment).
 *
 * Resolves with the archive path and size; rejects if archiving fails. The
 * caller owns timeout/cleanup policy. Never leaks the output stream.
 */
export async function zipDirectory(sourceDir: string, zipPath: string): Promise<ZipResult> {
  const absSource = path.resolve(sourceDir);
  const absZip = path.resolve(zipPath);

  // Pre-check the source: a missing/non-directory source must surface as an
  // error rather than silently producing an empty archive (archiver swallows
  // the ENOENT as a benign 'warning').
  const stat = await fs.stat(absSource).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`zipDirectory: source is not a directory: ${absSource}`);
  }

  await fs.mkdir(path.dirname(absZip), { recursive: true });

  const rootName = path.basename(absSource) || 'suite';

  // Enumerate up front (sorted) so entry order is stable across filesystems.
  const relFiles = await listFilesSorted(absSource);

  return await new Promise<ZipResult>((resolve, reject) => {
    const output = createWriteStream(absZip);
    const archive = archiver('zip', { zlib: { level: 9 } });

    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      // Best-effort: abort the archive and tear down the stream.
      archive.abort();
      output.destroy();
      reject(err);
    };

    output.on('close', () => {
      if (settled) return;
      settled = true;
      resolve({ zipPath: absZip, bytes: archive.pointer() });
    });
    output.on('error', fail);

    // archiver emits 'warning' for non-fatal issues (e.g. ENOENT on a stat) —
    // surface real errors, ignore benign warnings.
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') return;
      fail(err);
    });
    archive.on('error', fail);

    archive.pipe(output);
    for (const rel of relFiles) {
      archive.file(path.join(absSource, ...rel.split('/')), {
        name: `${rootName}/${rel}`,
        date: FIXED_ENTRY_DATE,
      });
    }
    void archive.finalize().catch(fail);
  });
}
