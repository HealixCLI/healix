import { useEffect } from 'react';
import { X } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { useCaseHistory, type CaseHistoryKey } from '../lib/use-case-history';
import { formatCreatedAt, formatDuration, testStatusTone } from '../lib/run-format';

/**
 * Right-side drawer showing one test's run-by-run pass/fail history, walked
 * backward across a project's top-up/reuse run chain. Same open/close
 * interaction precedent as RunDetailPanel's Lightbox (Escape/backdrop/✕).
 */
export function TestCaseHistoryDrawer({
  caseKey,
  onClose,
  onSelectRun,
}: {
  caseKey: CaseHistoryKey;
  onClose: () => void;
  onSelectRun?: (runId: string) => void;
}) {
  const { history, loading } = useCaseHistory(caseKey);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Test case history"
    >
      <div
        className="flex h-full w-full max-w-md flex-col border-l border-border bg-panel p-5 shadow-xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-fg" title={history?.currentTitle}>
              {history?.currentTitle || caseKey.title || 'Test case'}
            </h2>
            {history?.reqTag && <p className="mt-0.5 font-mono text-[11px] text-muted">{history.reqTag}</p>}
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-auto">
          {loading && <p className="text-xs text-muted">Loading history…</p>}
          {!loading && (!history || history.runHistory.length === 0) && (
            <p className="text-xs text-muted">No history found for this test.</p>
          )}
          {!loading && history && history.runHistory.length > 0 && (
            <ul className="flex flex-col gap-2">
              {history.runHistory.map((entry) => (
                <li
                  key={entry.runId}
                  className="rounded-lg border border-border bg-panel/40 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={onSelectRun ? () => onSelectRun(entry.runId) : undefined}
                      disabled={!onSelectRun}
                      className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-muted hover:text-fg disabled:hover:text-muted"
                      title={entry.runId}
                    >
                      {formatCreatedAt(entry.runCreatedAt)}
                    </button>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {entry.suiteMode && entry.suiteMode !== 'fresh' && (
                        <Badge tone="default">{entry.suiteMode}</Badge>
                      )}
                      <Badge tone={testStatusTone(entry.status)}>{entry.status ?? 'pending'}</Badge>
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted">{formatDuration(entry.durationMs)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
