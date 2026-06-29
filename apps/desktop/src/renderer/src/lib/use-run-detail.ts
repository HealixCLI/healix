import { useCallback, useEffect, useState } from 'react';
import type { RunDetail } from './ipc-types';

export interface RunDetailState {
  detail: RunDetail | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Loads the full detail bundle for a single run; refetches when runId changes. */
export function useRunDetail(runId: string | null): RunDetailState {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!runId) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setDetail(await window.healix.runDetail(runId));
    } catch (err) {
      setError(toMessage(err));
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { detail, loading, error, reload: load };
}
