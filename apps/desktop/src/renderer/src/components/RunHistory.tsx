import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Run, RunStatus } from '@healix/core';
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Select } from './ui/select';
import { cn } from '../lib/utils';
import { ALL_RUN_STATUSES, formatCreatedAt, formatRunStatus, runStatusTone } from '../lib/run-format';

/** Matches RunRow's `duration-200` collapse transition — the row is actually removed once this elapses. */
const DELETE_COLLAPSE_MS = 200;

/** Sentinel option value meaning "no status filter applied". */
const ALL_STATUSES = 'all';
type StatusFilter = RunStatus | typeof ALL_STATUSES;

/** Selectable run-history list (newest first), filterable by status. */
export function RunHistory({
  runs,
  loading,
  error,
  selectedRunId,
  onSelect,
  onRefresh,
  onDelete,
  onNewRun,
  projectsById,
  collapsed = false,
  onToggleCollapse,
}: {
  runs: Run[];
  loading: boolean;
  error: string | null;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onRefresh: () => void;
  /** Delete a single run (DB rows + on-disk assets). Omit to hide the delete action entirely. */
  onDelete?: (runId: string) => void;
  /** Reset the compose form to a fresh, editable "Start a run" state. Omit to hide the action. */
  onNewRun?: () => void;
  projectsById: Map<string, Project>;
  /** Mini icon-only collapsed state, with its own toggle button. Omit `onToggleCollapse` (e.g.
   * when a parent shows/hides this whole component externally instead) to hide that toggle entirely. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  // Kept local (rather than lifted to RunsView) so the filter stays applied
  // across refreshes/re-renders without the caller needing to know about it.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(ALL_STATUSES);

  // The list is newest-first and RunsView polls for updates every ~3s while
  // any run is active — a run starting elsewhere gets inserted at the TOP,
  // pushing every row below it down. If that happens while the user is
  // hovering the rail (about to click, or mid-way through confirming a
  // delete on some other row), the row under their cursor shifts out from
  // under them: a click lands on the wrong run, or on nothing, and the
  // delete confirmation seems to randomly not appear. Freeze the visible
  // order the moment the mouse enters the list (or a delete flow starts —
  // confirming a delete usually means the mouse has ALREADY left the list
  // for the centered dialog, so hover alone wouldn't keep it frozen for that
  // whole flow) and only resume following the live `runs` prop once both the
  // mouse has left AND nothing is pending.
  const [hovering, setHovering] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  // Ids we've already told the parent to delete but whose removal the live
  // `runs` prop hasn't confirmed yet (the IPC delete + refresh is async).
  // Filtered out of what's shown regardless of frozen/live source below, so
  // a run can never visually reappear between "we told the parent to delete
  // it" and "the parent's list actually stopped containing it" — without
  // this, unfreezing (e.g. because the mouse already left the list) at
  // exactly the wrong moment would show the stale, not-yet-refreshed live
  // list that still has the row in it.
  const [pendingRemovalIds, setPendingRemovalIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setPendingRemovalIds((prev) => {
      if (prev.size === 0) return prev;
      const liveIds = new Set(runs.map((r) => r.id));
      const stillPending = [...prev].filter((id) => liveIds.has(id));
      return stillPending.length === prev.size ? prev : new Set(stillPending);
    });
  }, [runs]);

  const pending = confirmingId !== null || closingId !== null || pendingRemovalIds.size > 0;
  const frozenRunsRef = useRef<Run[] | null>(null);
  if ((hovering || pending) && frozenRunsRef.current === null) {
    frozenRunsRef.current = runs;
  } else if (!hovering && !pending) {
    frozenRunsRef.current = null;
  }
  const stableRuns = useMemo(() => {
    const base = frozenRunsRef.current ?? runs;
    return pendingRemovalIds.size === 0 ? base : base.filter((r) => !pendingRemovalIds.has(r.id));
  }, [runs, pendingRemovalIds]);

  const filteredRuns = useMemo(
    () => (statusFilter === ALL_STATUSES ? stableRuns : stableRuns.filter((r) => r.status === statusFilter)),
    [stableRuns, statusFilter],
  );

  const requestDelete = (runId: string): void => setConfirmingId(runId);
  const cancelDelete = (): void => setConfirmingId(null);
  const confirmDelete = (runId: string): void => {
    setConfirmingId(null);
    setClosingId(runId);
    // Give the collapse transition (DELETE_COLLAPSE_MS) time to play before
    // the actual delete + list refresh removes this row for real — otherwise
    // it would just vanish instantly the moment the (fast) IPC call
    // resolves, defeating the animation.
    setTimeout(() => {
      onDelete?.(runId);
      setClosingId(null);
      setPendingRemovalIds((prev) => new Set(prev).add(runId));
    }, DELETE_COLLAPSE_MS);
  };

  if (collapsed) {
    return (
      <Button size="icon" variant="ghost" onClick={onToggleCollapse} aria-label="Expand history">
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">History</span>
        <div className="flex items-center gap-1">
          {onNewRun && (
            <Button size="icon" variant="ghost" onClick={onNewRun} aria-label="New run" title="New run">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            onClick={onRefresh}
            aria-label="Refresh history"
            disabled={loading}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
          {onToggleCollapse && (
            <Button size="icon" variant="ghost" onClick={onToggleCollapse} aria-label="Collapse history">
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="mb-2 flex items-center gap-1.5">
        <label htmlFor="run-status-filter" className="shrink-0 text-[11px] text-muted">
          Status:
        </label>
        <Select
          id="run-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="h-7 text-xs"
        >
          <option value={ALL_STATUSES}>All Statuses</option>
          {ALL_RUN_STATUSES.map((status) => (
            <option key={status} value={status}>
              {formatRunStatus(status)}
            </option>
          ))}
        </Select>
      </div>

      {error && (
        <p className="mb-2 rounded-md border border-err/40 bg-err/10 px-2 py-1.5 text-xs text-err">{error}</p>
      )}

      <div
        className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-panel/40"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        {loading && runs.length === 0 && <p className="px-3 py-4 text-xs text-muted">Loading runs…</p>}
        {!loading && runs.length === 0 && !error && (
          <p className="px-3 py-4 text-xs text-muted">No runs yet. Start one above.</p>
        )}
        {!loading && runs.length > 0 && filteredRuns.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted">No test runs found.</p>
        )}
        <ul className="divide-y divide-border/50">
          {filteredRuns.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              selected={run.id === selectedRunId}
              projectName={projectsById.get(run.projectId)?.name}
              onSelect={() => onSelect(run.id)}
              deletable={!!onDelete}
              confirming={confirmingId === run.id}
              closing={closingId === run.id}
              onRequestDelete={() => requestDelete(run.id)}
              onCancelDelete={cancelDelete}
              onConfirmDelete={() => confirmDelete(run.id)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * One history row: the selectable run button, plus a delete action (when
 * `deletable` is set) gated behind the shared, screen-centered ConfirmDialog
 * — the click that opens it never itself deletes anything. `confirming`/
 * `closing` are owned by RunHistory (not local state) so it can freeze the
 * whole list's order for the duration of a delete flow — see its own comment
 * for why a purely row-local version of this state couldn't do that.
 *
 * Two things previously made rapid successive deletes feel like the list was
 * "dancing", both fixed here without giving up the centered confirm dialog:
 *  1. The trash icon was hover-only (opacity-0 until group-hover) and
 *     absolutely positioned per row. Deleting a row shifts every row below it
 *     up to fill the gap, but the mouse doesn't move — so it ends up hovering
 *     a DIFFERENT run's icon, which pops in/out unpredictably as you try to
 *     delete several in a row. The icon is now always visible (dimmed,
 *     brightening on hover) so its position and presence are never in
 *     question.
 *  2. The row vanished from the list the instant onDelete() resolved, an
 *     abrupt cut that reads as a jump. `closing` now plays a short
 *     collapse-and-fade transition on this row FIRST, and only calls
 *     onDelete() (the actual IPC delete + list refresh) once that transition
 *     finishes — so removal reads as a smooth animation, not a snap.
 */
function RunRow({
  run,
  selected,
  projectName,
  onSelect,
  deletable,
  confirming,
  closing,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  run: Run;
  selected: boolean;
  projectName: string | undefined;
  onSelect: () => void;
  deletable: boolean;
  confirming: boolean;
  closing: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <li
      className={cn(
        'group relative overflow-hidden transition-[max-height,opacity] duration-200 ease-in',
        closing ? 'max-h-0 opacity-0' : 'max-h-24 opacity-100',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={closing}
        className={cn(
          'flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors',
          deletable && 'pr-8',
          selected ? 'bg-accent/10' : 'hover:bg-panel',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <Badge tone={runStatusTone(run.status)}>{run.status}</Badge>
          <span className="font-mono text-[11px] text-muted">{formatCreatedAt(run.createdAt)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="min-w-0 truncate text-fg">{projectName ?? run.projectId}</span>
          {run.mode && <span className="shrink-0 font-mono text-[11px] text-muted">{run.mode}</span>}
        </div>
      </button>
      {deletable && !closing && (
        // Centered via inset-y-0 + my-auto (box layout), NOT a translate-y
        // transform: the shared Button component applies active:translate-y-px
        // as a tactile "press" effect on every button, which shares the same
        // CSS transform axis as a translate-based vertical-center trick — the
        // instant this was pressed, :active's 1px value overrode the
        // centering offset entirely, snapping the icon from centered to
        // near the top of the row. That visible jump is what made the icon
        // look like it was "moving" on click, and could carry the pointer
        // off the button before mouseup, so the confirm dialog sometimes
        // never opened. Auto-margin centering doesn't touch transform at
        // all, so the press effect can no longer collide with it.
        <Button
          size="icon"
          variant="ghost"
          onClick={onRequestDelete}
          aria-label="Delete run"
          title="Delete run"
          className="absolute inset-y-0 right-1 my-auto h-6 w-6 text-muted/70 hover:text-err"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
      {confirming && (
        <ConfirmDialog
          title="Delete this run?"
          description="This permanently removes the run's history, generated suite, and any screenshots/recordings. This cannot be undone."
          confirmLabel="Delete"
          destructive
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
        />
      )}
    </li>
  );
}
