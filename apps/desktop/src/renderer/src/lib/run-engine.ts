import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrchestratorEvent, RunSummary, SuiteMode, TestingScope, TestPlan } from '@healix/core';
import type { RunChannelMessage, StartRunArgs } from './ipc-types';

export type RunPhase = 'idle' | 'starting' | 'running' | 'awaiting-approval' | 'done' | 'cancelled' | 'error';

/** Map a final run summary status onto the engine phase. */
function settledPhase(status: RunSummary['status']): RunPhase {
  if (status === 'error') return 'error';
  if (status === 'cancelled') return 'cancelled';
  return 'done';
}

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
  /**
   * True when this state came from hydrate() (re-attaching to a run whose live
   * UI was lost) rather than from a start() this session. While true, the view
   * showing this run is one choice among history rows, not force-shown the way
   * a genuinely-just-started live run is — see RunsView's showLiveSurface.
   * Cleared once the user actually resumes the run (approve(true)), at which
   * point it behaves like any other live run for the rest of its lifecycle.
   */
  hydrated: boolean;
}

export interface RunEngine extends RunEngineState {
  start: (args: StartRunArgs) => Promise<void>;
  approve: (ok: boolean) => Promise<void>;
  /** Request cancellation of the active run; run:done ('cancelled') confirms. */
  cancel: () => Promise<void>;
  reset: () => void;
  /**
   * Re-attach to a run that is still genuinely parked awaiting approval in the
   * main process (its approval promise is only lost on app restart, not on
   * navigating away from this view) but whose live state here was lost because
   * this component unmounted. Restores the plan gate so approve()/reject can
   * reach it again.
   */
  hydrate: (args: { runId: string; plan: TestPlan }) => void;
  /** Dismiss the current error banner without touching the rest of the state. */
  clearError: () => void;
}

const INITIAL: RunEngineState = {
  phase: 'idle',
  runId: null,
  lines: [],
  plan: null,
  planDecided: false,
  summary: null,
  error: null,
  hydrated: false,
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

  const pushLine = useCallback((level: OrchestratorEvent['level'], phase: string, message: string): void => {
    const id = ++lineSeq.current;
    setState((prev) => ({
      ...prev,
      lines: [...prev.lines, { id, level, phase, message, ts: nowLabel() }],
    }));
  }, []);

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
            phase: settledPhase(summary.status),
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
        phase: prev.phase === 'error' ? 'error' : settledPhase(summary.status),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, phase: 'error', error: message }));
    }
  }, []);

  const approve = useCallback(async (ok: boolean): Promise<void> => {
    const runId = activeRunId.current;
    if (!runId) return;
    // Computed before setState (not inside its updater), matching pushLine —
    // an updater can run more than once (e.g. Strict Mode), which would double-
    // increment a ref used inside it.
    const rejectionLine: ConsoleLine | null = ok
      ? null
      : {
          id: ++lineSeq.current,
          level: 'info',
          phase: 'approve',
          message: 'Plan rejected — cancelling run.',
          ts: nowLabel(),
        };
    // The gate closes immediately either way — approving moves straight into
    // the run; rejecting is final from the user's perspective the moment they
    // click it, even though the backend's own teardown is asynchronous and
    // its authoritative 'cancelled' will still arrive shortly via run:done.
    setState((prev) => ({
      ...prev,
      planDecided: true,
      phase: ok ? 'running' : 'cancelled',
      // Once decided (either way) this is no longer just one browsable history
      // row among others — it's live/settled like any other run.
      hydrated: false,
      lines: rejectionLine ? [...prev.lines, rejectionLine] : prev.lines,
    }));
    try {
      const result = await window.healix.approveRun(runId, ok);
      if (!result.settled) {
        // No live gate found on the backend for this runId — most likely
        // orphaned by an app restart that happened after it started (the
        // resolver lives only in that process's memory; persisted plan/status
        // survive, it doesn't). The main process force-settles the DB row
        // itself in this case (cancelled on reject, error on approve — an
        // approved run that can't actually resume never runs); mirror that
        // here so the local phase matches what's now persisted.
        setState((prev) => ({
          ...prev,
          phase: ok ? 'error' : 'cancelled',
          error: ok
            ? "This run's approval session had already ended (most likely an app restart), so it couldn't actually resume — it's been marked as an error."
            : "This run's approval session had already ended (most likely an app restart) before you responded — it's been marked as cancelled.",
        }));
      }
    } catch {
      // The gate may have already settled (e.g. run torn down); safe to ignore.
    }
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    const runId = activeRunId.current;
    if (!runId) return;
    // Cancellation is asynchronous and cooperative: the main process aborts the
    // orchestrator, which winds down at the next phase boundary. We do NOT flip
    // the phase here — the authoritative 'cancelled' arrives via run:done.
    try {
      const result = await window.healix.cancelRun(runId);
      if (!result.cancelled) {
        // Nothing was actually running on the backend for this runId — most
        // likely orphaned by an app restart since it started (same class of
        // gap as approve()'s !settled case). run:done will now never arrive,
        // so without this the UI would show "Cancelling…"/"Running…" forever
        // for a run that isn't running anywhere. The main process force-
        // settles the DB row to 'cancelled' itself in this case (the user did
        // explicitly ask to cancel it); mirror that phase here. Keep
        // runId/identity (not a full reset) so the error banner stays scoped
        // to THIS run via showLiveSurface, not shown for every run.
        setState((prev) => ({
          ...prev,
          phase: 'cancelled',
          hydrated: false,
          error:
            "This run wasn't actually active on the backend anymore (most likely ended by an app restart) — it's been marked as cancelled.",
        }));
      }
    } catch {
      // The run may have already settled; run:done tells the real story.
    }
  }, []);

  const reset = useCallback((): void => {
    activeRunId.current = null;
    lineSeq.current = 0;
    setState(INITIAL);
  }, []);

  const hydrate = useCallback((args: { runId: string; plan: TestPlan }): void => {
    activeRunId.current = args.runId;
    lineSeq.current = 0;
    setState({
      ...INITIAL,
      runId: args.runId,
      phase: 'awaiting-approval',
      plan: args.plan,
      hydrated: true,
    });
  }, []);

  const clearError = useCallback((): void => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return { ...state, start, approve, cancel, reset, hydrate, clearError };
}

/**
 * User-facing testing scope. The underlying exploration mechanism (codegen
 * vs. computer-use) is no longer a user choice — it's derived internally from
 * the project's config (repo path vs. base URL) and fully abstracted away.
 */
export const TESTING_SCOPES: ReadonlyArray<{ value: TestingScope; label: string; hint: string }> = [
  { value: 'frontend', label: 'Frontend Testing', hint: 'UI-focused tests (public + authenticated flows)' },
  { value: 'backend', label: 'Backend Testing', hint: 'API/backend tests only' },
  { value: 'both', label: 'Both (Frontend + Backend)', hint: 'Full coverage across UI and API' },
];

/**
 * Suite lifecycle for a run. Top-up/Reuse require an existing successful run
 * to build on — RunsView disables them (not hides them) until one exists.
 */
export const SUITE_MODES: ReadonlyArray<{ value: SuiteMode; label: string; hint: string }> = [
  { value: 'fresh', label: 'Generate fresh suite', hint: 'Regenerate every test from scratch.' },
  {
    value: 'topup',
    label: 'Top up existing suite',
    hint: 'Keep passing tests from the last successful run; generate only new/missing ones.',
  },
  {
    value: 'reuse',
    label: 'Run existing suite as-is',
    hint: "Re-execute the last successful run's tests — no generation.",
  },
];
