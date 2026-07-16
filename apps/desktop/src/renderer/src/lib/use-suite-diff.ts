import { useCallback, useEffect, useRef, useState } from 'react';
import type { SuiteDiffSummary } from './ipc-types';

export interface SuiteDiffState {
  diff: SuiteDiffSummary | null;
  loading: boolean;
}

/** Added/carried/removed test counts for one run vs. the run it topped-up/reused from. */
export function useSuiteDiff(runId: string | null): SuiteDiffState {
  const [diff, setDiff] = useState<SuiteDiffSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const myId = ++reqId.current;
    if (!runId) {
      setDiff(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await window.healix.suiteDiff(runId);
      if (myId === reqId.current) setDiff(next);
    } catch {
      if (myId === reqId.current) setDiff(null);
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { diff, loading };
}
