import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import type { BadgeTone } from './ui/badge';

/** Grid wrapper for a row of StatTiles — same layout RunDetailPanel's Test Execution Summary uses. */
export function StatTileRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-3 gap-2 sm:grid-cols-7', className)}>{children}</div>;
}

/**
 * A single labeled stat tile. Clickable (renders as a button, e.g. to filter
 * results by status) when `onClick` is given; otherwise a plain display tile
 * (e.g. a project-level metric with nothing to filter).
 */
export function StatTile({
  label,
  value,
  tone = 'default',
  active = false,
  onClick,
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: BadgeTone;
  active?: boolean;
  onClick?: () => void;
  /** Native hover tooltip, e.g. a per-stage duration breakdown. */
  title?: string;
}) {
  const valueColor =
    tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'err' ? 'text-err' : 'text-fg';
  const classes = cn(
    'rounded-lg border border-border bg-panel/40 px-3 py-2 text-left transition-colors',
    onClick && 'hover:border-accent/50',
    active && 'border-accent bg-accent/5',
  );
  const content = (
    <>
      <div className="text-[11px] text-muted">{label}</div>
      <div className={cn('mt-0.5 text-lg font-semibold leading-none', valueColor)}>{value}</div>
    </>
  );
  if (!onClick) {
    return (
      <div className={classes} title={title}>
        {content}
      </div>
    );
  }
  return (
    <button type="button" onClick={onClick} className={classes} title={title}>
      {content}
    </button>
  );
}
