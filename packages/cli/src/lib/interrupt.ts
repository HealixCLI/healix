/**
 * Treats Ctrl+C / SIGTERM as a pause request — mirroring the desktop app's
 * `controller.abort('pause')` pattern (apps/desktop/src/main/index.ts) —
 * instead of the CLI's previous behavior of just dying uncooperatively with
 * no checkpoint written at all. `RunOptions.signal` (or the third argument to
 * `orchestrator.resume()`) reads `signal.reason === 'pause'` to distinguish a
 * graceful pause from an ordinary cancel; aborting with that exact reason
 * string is what makes the orchestrator write a checkpoint and settle the run
 * as `paused` instead of `cancelled`/`error`.
 */

/** Minimal signal-registration surface this depends on — lets tests inject a fake instead of touching the real process. */
export interface InterruptSignalTarget {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): void;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): void;
}

export interface InterruptHandle {
  /** Pass as RunOptions.signal, or as orchestrator.resume()'s third argument. */
  signal: AbortSignal;
  /** Removes the SIGINT/SIGTERM listeners — call once the run has settled (passed/failed/paused/error), in a `finally`. */
  dispose(): void;
}

/**
 * Registers SIGINT/SIGTERM handlers for the duration of one run. The first
 * interrupt requests a graceful pause (`onInterrupt` fires so the caller can
 * print a message, then the signal aborts with reason 'pause'); a SECOND
 * interrupt while that pause is still in flight exits immediately instead of
 * silently swallowing the user's second Ctrl+C — same as an uncaught signal
 * normally would.
 */
export function installInterruptHandler(
  onInterrupt: () => void,
  target: InterruptSignalTarget = process,
): InterruptHandle {
  const controller = new AbortController();
  let triggered = false;
  const handler = (): void => {
    if (triggered) {
      process.exit(1);
      return;
    }
    triggered = true;
    onInterrupt();
    controller.abort('pause');
  };
  target.on('SIGINT', handler);
  target.on('SIGTERM', handler);
  return {
    signal: controller.signal,
    dispose(): void {
      target.off('SIGINT', handler);
      target.off('SIGTERM', handler);
    },
  };
}
