import { useCallback, useEffect, useRef, useState } from 'react';
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
  // Monotonic request token: a slow response for a previous runId must not
  // overwrite state for the current one (e.g. click run A then B; A resolves
  // last and would otherwise show A's detail while B is selected).
  const reqId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const myId = ++reqId.current;
    if (!runId) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await window.healix.runDetail(runId);
      if (myId === reqId.current) setDetail(next);
    } catch (err) {
      if (myId === reqId.current) {
        setError(toMessage(err));
        setDetail(null);
      }
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { detail, loading, error, reload: load };
}
