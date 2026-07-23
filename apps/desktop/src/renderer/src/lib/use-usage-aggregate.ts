import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageAggregate } from '@healix/core';

export interface UsageAggregateState {
  aggregate: UsageAggregate | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Cross-run usage aggregation for the Reports/Usage page; omit projectId for every project. */
export function useUsageAggregate(projectId?: string): UsageAggregateState {
  const [aggregate, setAggregate] = useState<UsageAggregate | null>(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const myId = ++reqId.current;
    setLoading(true);
    try {
      const next = await window.healix.usageCrossRun(projectId);
      if (myId === reqId.current) setAggregate(next);
    } catch {
      if (myId === reqId.current) setAggregate(null);
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { aggregate, loading, reload: load };
}
