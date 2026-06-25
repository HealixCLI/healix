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
 * Create a .zip archive of `sourceDir`, writing it to `zipPath`.
 *
 * The archive root contains the contents of `sourceDir` nested under a single
 * top-level folder named after `sourceDir`'s basename, so unzipping yields a
 * self-contained, named project directory.
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
    archive.directory(absSource, rootName);
    void archive.finalize().catch(fail);
  });
}
