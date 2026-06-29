import { useCallback, useEffect, useState } from 'react';
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

  const refresh = useCallback(async (): Promise<Run[]> => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.healix.listRuns(projectId);
      setRuns(next);
      return next;
    } catch (err) {
      setError(toMessage(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { runs, loading, error, refresh };
}
