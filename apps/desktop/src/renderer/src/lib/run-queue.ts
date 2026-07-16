import { useCallback, useEffect, useState } from 'react';
import type { QueuedRunSummary, RunChannelMessage } from './ipc-types';

export interface RunQueue {
  queue: QueuedRunSummary[];
  /** Remove a not-yet-started request from the queue. No-op if it already started or was already removed. */
  remove: (queueEntryId: string) => Promise<void>;
  /** Message from the most recent queued run that failed to start, until dismissed. */
  error: string | null;
  clearError: () => void;
}

/**
 * Owns the app-wide run queue's live state. Subscribed once for the life of
 * the app (called at the App root, same as useRunEngine) so the queue stays
 * visible and manageable regardless of which view is on screen — a request
 * queued from Projects still shows up (and can be cancelled) from Settings.
 */
export function useRunQueue(): RunQueue {
  const [queue, setQueue] = useState<QueuedRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.healix
      .listQueue()
      .then((initial) => {
        if (!cancelled) setQueue(initial);
      })
      .catch(() => {
        /* best-effort initial fetch; queue:updated broadcasts still keep it current */
      });

    const unsubscribe = window.healix.onRunEvent((msg: RunChannelMessage) => {
      if (msg.channel === 'queue:updated') setQueue(msg.payload.queue);
      if (msg.channel === 'queue:failed') setError(msg.payload.message);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Auto-dismiss after a few seconds — still manually dismissable (clearError)
  // in the meantime, same as the other error banners in this view.
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(id);
  }, [error]);

  const remove = useCallback(async (queueEntryId: string): Promise<void> => {
    await window.healix.queueRemove(queueEntryId);
    // The main process broadcasts queue:updated on every mutation; no need to
    // optimistically update local state here.
  }, []);

  const clearError = useCallback((): void => setError(null), []);

  return { queue, remove, error, clearError };
}
