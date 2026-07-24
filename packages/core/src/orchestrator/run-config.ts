import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderId } from '../providers/types.js';
import type { SuiteMode } from '../storage/types.js';
import type { TestingScope } from '../modes/types.js';

/**
 * A permanent snapshot of the user-facing options a run was started with —
 * testingScope/suiteMode/provider/prd/instructions — written once at the
 * very start of the pipeline and NEVER deleted, unlike checkpoint.json
 * (removed as soon as a run leaves the paused state — see checkpoint.ts's
 * deleteCheckpoint). Nothing else survives for a finished run: the `runs`
 * DB row only carries suiteMode, and report.json's TestPlan carries none of
 * testingScope/prd/instructions. This file is what lets the desktop app show
 * "what was this run configured with" for a run that already finished.
 */
export interface RunConfigSnapshot {
  testingScope?: TestingScope;
  suiteMode?: SuiteMode;
  provider?: ProviderId;
  prd?: string;
  instructions?: string;
  /** How `prd` was produced — free typing, a prose file upload, or a parsed spreadsheet. */
  prdSourceKind?: 'text' | 'file' | 'spreadsheet';
  /** Original uploaded file name, when `prd` came from a file/spreadsheet upload. */
  prdFileName?: string;
  /** Sheet names included in `prd`, when `prdSourceKind` is 'spreadsheet'. */
  prdSelectedSheets?: string[];
  /** Whether the coverage feedback loop's iterative retry was enabled for this run — see RunOptions.coverageLoopEnabled. */
  coverageLoopEnabled?: boolean;
  /** The coverage target this run used, when coverageLoopEnabled — see RunOptions.coverageTarget. */
  coverageTarget?: number;
  /** Plan item ids this run targeted for regeneration (Retry-pass/Repair), when set — see RunOptions.retryItemIds. */
  retryItemIds?: string[];
}

function runConfigPath(runDir: string): string {
  return join(runDir, 'run-config.json');
}

/** Best-effort write — a failure here must never abort the run it's describing. */
export async function writeRunConfigSnapshot(runDir: string, snapshot: RunConfigSnapshot): Promise<void> {
  try {
    await writeFile(runConfigPath(runDir), JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch {
    /* best-effort; the desktop UI just won't have this snapshot if it fails */
  }
}

/** Read a run's config snapshot, or null if absent (predates this feature, or the write failed). */
export async function readRunConfigSnapshot(runDir: string): Promise<RunConfigSnapshot | null> {
  try {
    const raw = await readFile(runConfigPath(runDir), 'utf-8');
    return JSON.parse(raw) as RunConfigSnapshot;
  } catch {
    return null;
  }
}
