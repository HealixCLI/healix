import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectMetrics } from './ipc-types';

export interface ProjectMetricsState {
  metrics: ProjectMetrics | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Project-level metrics for the dashboard Overview tab; refetches when projectId changes. */
export function useProjectMetrics(projectId: string | null): ProjectMetricsState {
  const [metrics, setMetrics] = useState<ProjectMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const myId = ++reqId.current;
    if (!projectId) {
      setMetrics(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await window.healix.projectMetrics(projectId);
      if (myId === reqId.current) setMetrics(next);
    } catch {
      if (myId === reqId.current) setMetrics(null);
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { metrics, loading, reload: load };
}
