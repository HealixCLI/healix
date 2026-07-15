import { useCallback, useEffect, useRef, useState } from 'react';
import type { Run } from '@healix/core';

export interface LastSuccessfulRunState {
  run: Run | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * The project's most recent fully-passed run, if any — drives the Suite Mode
 * toggle's Top-up/Reuse enable state and its "topping up from run X" hint.
 * Refetches whenever projectId changes.
 */
export function useLastSuccessfulRun(projectId: string | null): LastSuccessfulRunState {
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(false);
  // Monotonic request token: a slow response for a previous projectId must not
  // overwrite state for the current one — same guard as useRunDetail.
  const reqId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const myId = ++reqId.current;
    if (!projectId) {
      setRun(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await window.healix.lastSuccessfulRun(projectId);
      if (myId === reqId.current) setRun(next);
    } catch {
      if (myId === reqId.current) setRun(null);
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { run, loading, reload: load };
}
