import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ExplorationMode,
  OrchestratorEvent,
  RunSummary,
  TestPlan,
} from '@healix/core';
import type { RunChannelMessage, StartRunArgs } from './ipc-types';

export type RunPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'awaiting-approval'
  | 'done'
  | 'error';

export interface ConsoleLine {
  id: number;
  level: OrchestratorEvent['level'];
  phase: string;
  message: string;
  /** Local wall-clock timestamp for the console gutter. */
  ts: string;
}

export interface RunEngineState {
  phase: RunPhase;
  runId: string | null;
  lines: ConsoleLine[];
  plan: TestPlan | null;
  /** Set once the user approves/rejects the active plan; clears the gate UI. */
  planDecided: boolean;
  summary: RunSummary | null;
  error: string | null;
}

export interface RunEngine extends RunEngineState {
  start: (args: StartRunArgs) => Promise<void>;
  approve: (ok: boolean) => Promise<void>;
  reset: () => void;
}

const INITIAL: RunEngineState = {
  phase: 'idle',
  runId: null,
  lines: [],
  plan: null,
  planDecided: false,
  summary: null,
  error: null,
};

function nowLabel(): string {
  return new Date().toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Owns a single run's streamed lifecycle. Subscribes to window.healix.onRunEvent
 * for the duration it's mounted, filters by the active runId, and exposes a calm
 * console buffer + plan-gate + final summary the Run view renders.
 */
export function useRunEngine(): RunEngine {
  const [state, setState] = useState<RunEngineState>(INITIAL);
  const lineSeq = useRef(0);
  // Track the active runId without re-subscribing on every change.
  const activeRunId = useRef<string | null>(null);

  const pushLine = useCallback(
    (level: OrchestratorEvent['level'], phase: string, message: string): void => {
      const id = ++lineSeq.current;
      setState((prev) => ({
        ...prev,
        lines: [...prev.lines, { id, level, phase, message, ts: nowLabel() }],
      }));
    },
    [],
  );

  useEffect(() => {
    const unsubscribe = window.healix.onRunEvent((msg: RunChannelMessage) => {
      const incomingRunId = msg.payload.runId;
      // Ignore stray messages from a previous/other run.
      if (activeRunId.current && incomingRunId !== activeRunId.current) return;

      switch (msg.channel) {
        case 'run:started': {
          activeRunId.current = msg.payload.runId;
          setState((prev) => ({ ...prev, runId: msg.payload.runId, phase: 'running' }));
          break;
        }
        case 'run:event': {
          const e = msg.payload.event;
          pushLine(e.level, String(e.phase), e.message);
          break;
        }
        case 'run:plan': {
          setState((prev) => ({
            ...prev,
            plan: msg.payload.plan,
            planDecided: false,
            phase: 'awaiting-approval',
          }));
          break;
        }
        case 'run:done': {
          const summary = msg.payload.summary;
          setState((prev) => ({
            ...prev,
            summary,
            phase: summary.status === 'error' ? 'error' : 'done',
          }));
          break;
        }
      }
    });
    return unsubscribe;
  }, [pushLine]);

  const start = useCallback(async (args: StartRunArgs): Promise<void> => {
    lineSeq.current = 0;
    activeRunId.current = null;
    setState({ ...INITIAL, phase: 'starting' });
    try {
      // Note: startRun resolves only when the whole run finishes; the live
      // updates flow through onRunEvent. We still await to surface hard errors.
      const summary = await window.healix.startRun(args);
      setState((prev) => ({
        ...prev,
        summary,
        // run:done may have already set phase; keep error sticky.
        phase: prev.phase === 'error' ? 'error' : summary.status === 'error' ? 'error' : 'done',
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, phase: 'error', error: message }));
    }
  }, []);

  const approve = useCallback(async (ok: boolean): Promise<void> => {
    const runId = activeRunId.current;
    if (!runId) return;
    setState((prev) => ({
      ...prev,
      planDecided: true,
      phase: ok ? 'running' : 'error',
    }));
    try {
      await window.healix.approveRun(runId, ok);
    } catch {
      // The gate may have already settled (e.g. run torn down); safe to ignore.
    }
  }, []);

  const reset = useCallback((): void => {
    activeRunId.current = null;
    lineSeq.current = 0;
    setState(INITIAL);
  }, []);

  return { ...state, start, approve, reset };
}

export const EXPLORATION_MODES: ReadonlyArray<{ value: ExplorationMode; label: string; hint: string }> = [
  { value: 'codegen', label: 'Codegen', hint: 'White-box: read the repo, generate runnable specs' },
  { value: 'computer-use', label: 'Computer use', hint: 'Black-box: drive the live app like a user' },
];
