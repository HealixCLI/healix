import * as React from 'react';
import { cn } from '../../lib/utils';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-[72px] w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg',
      'placeholder:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
      'disabled:opacity-50 disabled:pointer-events-none resize-y',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
