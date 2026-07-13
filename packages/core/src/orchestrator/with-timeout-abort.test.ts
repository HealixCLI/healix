/**
 * Unit tests for withTimeoutAbort — the fix for the orphaned-triage-process
 * bug: a timed-out provider call must not just be abandoned (the old
 * withTimeout behaviour), it must actually abort its controller so the
 * caller's underlying CLI child process gets killed instead of continuing to
 * run in the background after the run has already moved on and reported
 * "complete" (which raced a later `claude` health-check probe on Windows and
 * required re-login).
 */
import { describe, expect, it } from 'vitest';
import { withTimeoutAbort } from './index.js';

describe('withTimeoutAbort', () => {
  it('resolves with the value when the promise settles before the deadline', async () => {
    const controller = new AbortController();
    const result = await withTimeoutAbort(Promise.resolve('ok'), 50, controller);
    expect(result).toBe('ok');
    expect(controller.signal.aborted).toBe(false);
  });

  it('propagates a rejection from the promise before the deadline without aborting', async () => {
    const controller = new AbortController();
    await expect(withTimeoutAbort(Promise.reject(new Error('boom')), 50, controller)).rejects.toThrow('boom');
    expect(controller.signal.aborted).toBe(false);
  });

  it('rejects AND aborts the controller when the promise does not settle in time', async () => {
    const controller = new AbortController();
    const neverSettles = new Promise<string>(() => {});

    await expect(withTimeoutAbort(neverSettles, 10, controller)).rejects.toThrow('timed out after 10ms');
    // This is the actual fix: the controller must be aborted so the caller's
    // runCli()-backed provider call kills its child process instead of
    // leaving it running, untracked, in the background.
    expect(controller.signal.aborted).toBe(true);
  });

  it('does not abort when the promise wins the race (no lingering timer side-effect)', async () => {
    const controller = new AbortController();
    const slowButInTime = new Promise<string>((resolve) => setTimeout(() => resolve('done'), 5));

    const result = await withTimeoutAbort(slowButInTime, 200, controller);

    expect(result).toBe('done');
    expect(controller.signal.aborted).toBe(false);
  });
});
