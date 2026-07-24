import { join } from 'node:path';
import { projectsDir } from '../env/app-data.js';
import type { HealixStore } from '../storage/store.js';
import type { PauseReason, Run } from '../storage/types.js';
import { readCheckpoint } from './checkpoint.js';

/**
 * Result of a single reconciliation pass — see reconcileRuns().
 */
export interface ReconcileResult {
  /** Runs that should be resumed: already-`paused` (non-manual) rows, plus in-flight rows this pass just re-classified as `paused`/`crashed` because a checkpoint exists. */
  toResume: Run[];
  /** In-flight runs with NO checkpoint at all — marked `error` (redoing PLAN from scratch is just starting over, so there's nothing meaningful to resume). */
  markedError: number;
  /** Additional stale runs reaped by the age-buffered orphan janitor (store.failOrphanedRuns) — the fallback net for anything this pass didn't otherwise touch. */
  orphansReaped: number;
}

/**
 * Reconciles run state left behind by a process that stopped without a clean
 * shutdown (app closed, crashed, or killed) — originally the desktop app's
 * boot-time-only `reconcileRunsOnBoot`, extracted here so the CLI can run the
 * exact same reconciliation instead of having no equivalent at all (a `healix
 * run` killed via Ctrl+C previously just left an orphaned row until the
 * desktop app happened to open the same data directory, or the 6-hour
 * janitor eventually reaped it).
 *
 * Three cases, in order:
 * 1. Already-`paused` (non-manual) rows from a prior session — returned as-is, ready to resume.
 * 2. In-flight rows (a live-looking status left by a process that's no longer running) WITH a
 *    checkpoint on disk — reclassified `paused`/`crashed` and returned for resume.
 * 3. In-flight rows WITHOUT a checkpoint — marked `error` immediately rather than waiting on the
 *    6h janitor, since there is nothing on disk to resume from.
 *
 * Purely the "figure out what needs attention" half — actually driving each returned run through
 * `resume()` (and however the caller wants to surface progress: desktop broadcasts over IPC, the
 * CLI just prints) is left to the caller, since that part differs meaningfully between them (e.g.
 * desktop's single-active-run queue has no CLI equivalent).
 */
export async function reconcileRuns(store: HealixStore): Promise<ReconcileResult> {
  const toResume: Run[] = [...store.listAutoResumableRuns()];
  let markedError = 0;
  for (const run of store.listInFlightRuns()) {
    const runDir = join(projectsDir(), run.projectId, 'runs', run.id);
    const checkpoint = await readCheckpoint(runDir);
    if (!checkpoint) {
      store.updateRunStatus(run.id, 'error', { finishedAt: new Date().toISOString() });
      try {
        store.appendEvent(
          run.id,
          'done',
          'Run interrupted (app closed or crashed) before any checkpoint existed — nothing to resume from.',
          { level: 'error' },
        );
      } catch {
        /* best-effort */
      }
      markedError += 1;
      continue;
    }
    const pauseReason: PauseReason = 'crashed';
    store.updateRunStatus(run.id, 'paused', { pauseReason, finishedAt: new Date().toISOString() });
    toResume.push({ ...run, status: 'paused', pauseReason });
  }

  // Fallback janitor for anything the pass above didn't touch (e.g. storage
  // was briefly unavailable) — still age-buffered (default 6h) so it never
  // reaps a run genuinely still in flight in another process.
  let orphansReaped = 0;
  try {
    orphansReaped = store.failOrphanedRuns();
  } catch {
    /* best-effort */
  }

  return { toResume, markedError, orphansReaped };
}
