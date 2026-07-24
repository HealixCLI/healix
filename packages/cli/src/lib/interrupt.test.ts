import { describe, expect, it, vi } from 'vitest';
import { installInterruptHandler, type InterruptSignalTarget } from './interrupt.js';

/** Fake signal-registration target so tests never touch the real process's SIGINT/SIGTERM handlers. */
class FakeSignalTarget implements InterruptSignalTarget {
  private listeners = new Map<'SIGINT' | 'SIGTERM', Array<() => void>>();

  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((l) => l !== listener),
    );
  }

  emit(event: 'SIGINT' | 'SIGTERM'): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  listenerCount(event: 'SIGINT' | 'SIGTERM'): number {
    return (this.listeners.get(event) ?? []).length;
  }
}

describe('installInterruptHandler', () => {
  it('registers listeners for both SIGINT and SIGTERM', () => {
    const target = new FakeSignalTarget();
    installInterruptHandler(() => {}, target);
    expect(target.listenerCount('SIGINT')).toBe(1);
    expect(target.listenerCount('SIGTERM')).toBe(1);
  });

  it('a first SIGINT calls onInterrupt and aborts the signal with reason "pause"', () => {
    const target = new FakeSignalTarget();
    const onInterrupt = vi.fn();
    const handle = installInterruptHandler(onInterrupt, target);

    expect(handle.signal.aborted).toBe(false);
    target.emit('SIGINT');

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe('pause');
  });

  it('a first SIGTERM behaves identically to SIGINT', () => {
    const target = new FakeSignalTarget();
    const onInterrupt = vi.fn();
    const handle = installInterruptHandler(onInterrupt, target);

    target.emit('SIGTERM');

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(handle.signal.reason).toBe('pause');
  });

  it('dispose() removes both listeners', () => {
    const target = new FakeSignalTarget();
    const onInterrupt = vi.fn();
    const handle = installInterruptHandler(onInterrupt, target);

    handle.dispose();
    expect(target.listenerCount('SIGINT')).toBe(0);
    expect(target.listenerCount('SIGTERM')).toBe(0);

    // Listeners are gone, so a signal after dispose is simply a no-op — not
    // an error — matching "the run already settled, nothing left to pause".
    target.emit('SIGINT');
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('a SECOND interrupt while the first pause is still in flight exits immediately', () => {
    const target = new FakeSignalTarget();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const onInterrupt = vi.fn();
      installInterruptHandler(onInterrupt, target);

      target.emit('SIGINT');
      expect(onInterrupt).toHaveBeenCalledTimes(1);
      expect(exitSpy).not.toHaveBeenCalled();

      target.emit('SIGINT');
      // onInterrupt is NOT called again — the second signal is an escape
      // hatch (immediate exit), not another attempt at a graceful pause.
      expect(onInterrupt).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
