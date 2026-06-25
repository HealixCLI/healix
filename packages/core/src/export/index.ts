import { notImplemented } from '../util/not-implemented.js';
import type { SuiteBundle } from '../modes/types.js';

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

/** Foundation stub — produces a standalone runnable Playwright project (export module, M1). */
export function exportSuite(_opts: ExportOptions): Promise<SuiteBundle> {
  return notImplemented('exportSuite');
}
