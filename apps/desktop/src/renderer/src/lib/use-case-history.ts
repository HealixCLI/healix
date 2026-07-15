import { useCallback, useEffect, useRef, useState } from 'react';
import type { TestCaseHistory } from './ipc-types';

export interface CaseHistoryKey {
  projectId: string;
  reqTag?: string | null;
  title?: string;
}

export interface CaseHistoryState {
  history: TestCaseHistory | null;
  loading: boolean;
}

/**
 * One test's lineage + pass/fail history. Fetched lazily on demand (pass
 * `null` to skip) — a drawer opens this for one row at a time, never
 * prefetched for every row in a suite table.
 */
export function useCaseHistory(key: CaseHistoryKey | null): CaseHistoryState {
  const [history, setHistory] = useState<TestCaseHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const projectId = key?.projectId ?? null;
  const reqTag = key?.reqTag ?? undefined;
  const title = key?.title ?? undefined;

  const load = useCallback(async (): Promise<void> => {
    const myId = ++reqId.current;
    if (!projectId || (!reqTag && !title)) {
      setHistory(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await window.healix.caseHistory(projectId, { reqTag: reqTag ?? undefined, title });
      if (myId === reqId.current) setHistory(next);
    } catch {
      if (myId === reqId.current) setHistory(null);
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  }, [projectId, reqTag, title]);

  useEffect(() => {
    void load();
  }, [load]);

  return { history, loading };
}
