import type { FailureTrendPoint } from '../lib/ipc-types';
import { formatCreatedAt } from '../lib/run-format';
import { cn } from '../lib/utils';

/**
 * Run-by-run pass-rate trend as simple CSS bars — no charting library exists
 * in this app, and a handful of proportional-width bars is enough to read a
 * trend at a glance without pretending to be a real chart (no axes/tooltips).
 */
export function FailureTrendChart({
  points,
  onSelectRun,
}: {
  points: FailureTrendPoint[];
  onSelectRun?: (runId: string) => void;
}) {
  if (points.length === 0) {
    return <p className="py-4 text-center text-xs text-muted">No runs yet — start one to see trend data.</p>;
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {points.map((p) => {
        const passRate = p.total > 0 ? p.passed / p.total : 0;
        const content = (
          <>
            <span className="w-28 shrink-0 truncate font-mono text-[11px] text-muted">
              {formatCreatedAt(p.runCreatedAt)}
            </span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-border/40">
              <span
                className="block h-full rounded-full bg-ok"
                style={{ width: `${Math.round(passRate * 100)}%` }}
              />
            </span>
            <span className="w-24 shrink-0 text-right text-[11px] text-muted">
              {p.total > 0 ? `${Math.round(passRate * 100)}% (${p.passed}/${p.total})` : 'no results'}
            </span>
          </>
        );
        const rowClasses = cn(
          'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
          onSelectRun && 'hover:bg-panel',
        );
        return (
          <li key={p.runId}>
            {onSelectRun ? (
              <button type="button" onClick={() => onSelectRun(p.runId)} className={rowClasses}>
                {content}
              </button>
            ) : (
              <div className={rowClasses}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
