import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './utils.js';

describe('formatRelativeTime', () => {
  const now = 1_000_000_000;

  it('reports "just now" under 10s', () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe('just now');
  });

  it('reports whole seconds between 10s and 60s', () => {
    expect(formatRelativeTime(now - 42_000, now)).toBe('42s ago');
  });

  it('reports whole minutes between 1m and 60m', () => {
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe('3m ago');
  });

  it('reports whole hours between 1h and 24h', () => {
    expect(formatRelativeTime(now - 5 * 60 * 60_000, now)).toBe('5h ago');
  });

  it('reports whole days beyond 24h', () => {
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });

  it('never reports a negative age for a timestamp at or after now', () => {
    expect(formatRelativeTime(now, now)).toBe('just now');
    expect(formatRelativeTime(now + 5_000, now)).toBe('just now');
  });
});
