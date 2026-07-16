import { X } from 'lucide-react';
import type { Project } from '@healix/core';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { TESTING_SCOPES } from '../lib/run-engine';
import type { QueuedRunSummary } from '../lib/ipc-types';

/** Visible, manageable list of run requests waiting for the active run to finish. */
export function RunQueuePanel({
  queue,
  projectsById,
  onRemove,
  error,
  onDismissError,
}: {
  queue: QueuedRunSummary[];
  projectsById: Map<string, Project>;
  onRemove: (queueEntryId: string) => void;
  /** Set when a queued run most recently failed to start — shown even if the queue has since emptied out. */
  error: string | null;
  onDismissError: () => void;
}) {
  if (queue.length === 0 && !error) return null;

  return (
    <Card className="mt-4 shrink-0">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>
          Queued runs <span className="font-mono text-xs font-normal text-muted">({queue.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error && (
          <div className="flex items-start justify-between gap-2 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">
            <p>{error}</p>
            <button
              type="button"
              onClick={onDismissError}
              aria-label="Dismiss"
              className="shrink-0 rounded p-0.5 text-err/70 hover:text-err"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {queue.length > 0 && (
          <ul className="flex flex-col gap-2">
            {queue.map((entry, i) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-panel/40 px-3 py-2 text-sm"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Badge tone="muted">#{i + 1}</Badge>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {projectsById.get(entry.projectId)?.name ?? entry.projectName}
                    </p>
                    <p className="truncate text-[11px] text-muted">
                      {TESTING_SCOPES.find((s) => s.value === entry.testingScope)?.label ?? 'Both'}
                      {entry.suiteMode && entry.suiteMode !== 'fresh' ? ` · ${entry.suiteMode}` : ''}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(entry.id)}
                  aria-label={`Remove ${projectsById.get(entry.projectId)?.name ?? entry.projectName} from queue`}
                  title="Remove from queue"
                  className="shrink-0 rounded p-1 text-muted transition-colors hover:bg-err/10 hover:text-err"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
