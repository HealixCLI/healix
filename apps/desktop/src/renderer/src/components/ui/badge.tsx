import * as React from 'react';
import { cn } from '../../lib/utils';

export type BadgeTone = 'default' | 'ok' | 'warn' | 'err' | 'muted';

const tones: Record<BadgeTone, string> = {
  // In-progress / informational — cool blue, so green stays brand + success.
  default: 'bg-info/10 text-info ring-info/25',
  ok: 'bg-ok/10 text-ok ring-ok/25',
  warn: 'bg-warn/10 text-warn ring-warn/25',
  err: 'bg-err/10 text-err ring-err/25',
  muted: 'bg-border/50 text-muted ring-border',
};

export function Badge({
  className,
  tone = 'default',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ring-1 ring-inset',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
