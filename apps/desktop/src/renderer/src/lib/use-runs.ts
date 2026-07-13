import { useCallback, useEffect, useRef, useState } from 'react';
import type { Run } from '@healix/core';

export interface RunsState {
  runs: Run[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<Run[]>;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read-only run history for the selected project (or all projects when undefined). */
export function useRuns(projectId?: string): RunsState {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request token so a slow response for a previous projectId can't
  // overwrite the list for the current selection.
  const reqId = useRef(0);

  const refresh = useCallback(async (): Promise<Run[]> => {
    const myId = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await window.healix.listRuns(projectId);
      if (myId === reqId.current) setRuns(next);
      return next;
    } catch (err) {
      if (myId === reqId.current) setError(toMessage(err));
      return [];
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { runs, loading, error, refresh };
}
