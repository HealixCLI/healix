import type { Project, Run } from '@healix/core';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { formatCreatedAt, runStatusTone } from '../lib/run-format';

/** Selectable run-history list (newest first). */
export function RunHistory({
  runs,
  loading,
  error,
  selectedRunId,
  onSelect,
  onRefresh,
  projectsById,
  collapsed,
  onToggleCollapse,
}: {
  runs: Run[];
  loading: boolean;
  error: string | null;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onRefresh: () => void;
  projectsById: Map<string, Project>;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
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
          <Button
            size="icon"
            variant="ghost"
            onClick={onRefresh}
            aria-label="Refresh history"
            disabled={loading}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
          <Button size="icon" variant="ghost" onClick={onToggleCollapse} aria-label="Collapse history">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {error && (
        <p className="mb-2 rounded-md border border-err/40 bg-err/10 px-2 py-1.5 text-xs text-err">{error}</p>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-panel/40">
        {loading && runs.length === 0 && <p className="px-3 py-4 text-xs text-muted">Loading runs…</p>}
        {!loading && runs.length === 0 && !error && (
          <p className="px-3 py-4 text-xs text-muted">No runs yet. Start one above.</p>
        )}
        <ul className="divide-y divide-border/50">
          {runs.map((run) => {
            const selected = run.id === selectedRunId;
            const project = projectsById.get(run.projectId);
            return (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onSelect(run.id)}
                  className={cn(
                    'flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors',
                    selected ? 'bg-accent/10' : 'hover:bg-panel',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone={runStatusTone(run.status)}>{run.status}</Badge>
                    <span className="font-mono text-[11px] text-muted">{formatCreatedAt(run.createdAt)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-fg">{project?.name ?? run.projectId}</span>
                    {run.mode && (
                      <span className="shrink-0 font-mono text-[11px] text-muted">{run.mode}</span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
