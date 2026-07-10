import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Coarse relative-time label for a past timestamp (ms since epoch), e.g. "3m ago". */
export function formatRelativeTime(pastMs: number, nowMs: number = Date.now()): string {
  const deltaSec = Math.max(0, Math.round((nowMs - pastMs) / 1000));
  if (deltaSec < 10) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.round(deltaHr / 24);
  return `${deltaDay}d ago`;
}
