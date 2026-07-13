import * as React from 'react';
import { cn } from '../../lib/utils';

/** Lightweight native <select> styled to match the dark theme. */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-border bg-bg px-3 text-sm text-fg',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        'disabled:opacity-50 disabled:pointer-events-none',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';
