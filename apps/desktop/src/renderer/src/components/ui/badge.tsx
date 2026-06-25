import * as React from 'react';
import { cn } from '../../lib/utils';

export type BadgeTone = 'default' | 'ok' | 'warn' | 'err' | 'muted';

const tones: Record<BadgeTone, string> = {
  default: 'bg-accent/15 text-accent',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  err: 'bg-err/15 text-err',
  muted: 'bg-border text-muted',
};

export function Badge({
  className,
  tone = 'default',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', tones[tone], className)}
      {...props}
    />
  );
}
