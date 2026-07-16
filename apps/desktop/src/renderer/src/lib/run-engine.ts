import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  OrchestratorEvent,
  PlanItemSnapshot,
  PlanItemStatus,
  RunSummary,
  SuiteMode,
  TestingScope,
  TestPlan,
  TestPlanItem,
} from '@healix/core';
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
  /** The AI's original, never-mutated proposed plan — ground truth for diffing. */
  plan: TestPlan | null;
  /** Mutable draft the reviewer edits; this is what gets sent back on approveAndContinue. */
  workingPlan: TestPlan | null;
  /** Set once the user submits a final decision on the active plan; clears the gate UI. */
  planDecided: boolean;
  /** itemId -> true while a plan:reviseItem call for that item is in flight. */
  revisingItemIds: Set<string>;
  /** itemId -> the last revise error for that item, if any. */
  reviseErrors: Record<string, string>;
  summary: RunSummary | null;
  error: string | null;
  /**
   * True when this state came from hydrate() (re-attaching to a run whose live
   * UI was lost) rather than from a start() this session. While true, the view
   * showing this run is one choice among history rows, not force-shown the way
   * a genuinely-just-started live run is — see RunsView's showLiveSurface.
   * Cleared once the user actually resumes the run (approveAndContinue), at
   * which point it behaves like any other live run for the rest of its lifecycle.
   */
  hydrated: boolean;
}

export interface RunEngine extends RunEngineState {
  start: (args: StartRunArgs) => Promise<void>;
  /** Queue a run behind whatever is currently executing, instead of starting it directly. */
  queueRun: (args: StartRunArgs) => Promise<void>;
  /** Approve a single item (whatever its current status). */
  approveItem: (itemId: string) => void;
  /** Reject a single item — excluded from generation entirely. */
  rejectItem: (itemId: string) => void;
  /** Directly edit an item's content; marks it 'edited' and snapshots the original on first touch. */
  editItem: (itemId: string, patch: PlanItemSnapshot) => void;
  /** Send an item + free-text feedback to the AI for regeneration; result returns to 'pending'. */
  reviseItem: (itemId: string, suggestion: string, projectId: string) => Promise<void>;
  /** Finalize: defaults any untouched item to 'approved', then submits the plan and resumes the run. */
  approveAndContinue: () => Promise<void>;
  /** Cancel the run outright, discarding the whole plan. */
  rejectAll: () => Promise<void>;
  /** Request cancellation of the active run; run:done ('cancelled') confirms. */
  cancel: () => Promise<void>;
  reset: () => void;
  /**
   * Re-attach to a run that is still genuinely parked awaiting approval in the
   * main process (its approval promise is only lost on app restart, not on
   * navigating away from this view) but whose live state here was lost because
   * this component unmounted. Restores the plan gate so the per-item actions
   * and approveAndContinue()/rejectAll() can reach it again.
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
  workingPlan: null,
  planDecided: false,
  revisingItemIds: new Set(),
  reviseErrors: {},
  summary: null,
  error: null,
  hydrated: false,
};

function nowLabel(): string {
  return new Date().toLocaleTimeString(undefined, { hour12: false });
}

/** Deep-clone a plan so the mutable working draft never aliases the original/incoming plan. */
function clonePlan(plan: TestPlan): TestPlan {
  return {
    ...plan,
    items: plan.items.map((item) => ({
      ...item,
      original: item.original ? { ...item.original } : undefined,
      edits: item.edits
        ? item.edits.map((e) => ({ ...e, before: { ...e.before }, after: { ...e.after } }))
        : undefined,
      revisions: item.revisions
        ? item.revisions.map((r) => ({ ...r, before: { ...r.before }, after: { ...r.after } }))
        : undefined,
    })),
  };
}

function mapItem(plan: TestPlan, itemId: string, fn: (item: TestPlanItem) => TestPlanItem): TestPlan {
  return { ...plan, items: plan.items.map((it) => (it.id === itemId ? fn(it) : it)) };
}

function snapshotOf(item: TestPlanItem): PlanItemSnapshot {
  return {
    title: item.title,
    reqTag: item.reqTag,
    tier: item.tier,
    intent: item.intent,
    scenarios: item.scenarios,
  };
}

/**
 * True for a status that still counts as "the reviewer hasn't made a final
 * call" — both a never-touched item (undefined/'pending') and a freshly
 * revised one ('revised') default to 'approved' on approveAndContinue if
 * left untouched. Mirrors the orchestrator's own APPROVE-phase defaulting
 * (packages/core/src/orchestrator/index.ts) so desktop and core agree.
 */
function needsDecision(status: PlanItemStatus | undefined): boolean {
  return status === undefined || status === 'pending' || status === 'revised';
}

/**
 * Owns a single run's streamed lifecycle. Subscribes to window.healix.onRunEvent
 * for the duration it's mounted, filters by the active runId, and exposes a calm
 * console buffer + per-item plan-gate + final summary the Run view renders.
 */
export function useRunEngine(): RunEngine {
  const [state, setState] = useState<RunEngineState>(INITIAL);
  const lineSeq = useRef(0);
  // Track the active runId without re-subscribing on every change.
  const activeRunId = useRef<string | null>(null);
  // Mirrors `state` for callbacks that need to read the LATEST value
  // synchronously (setState's updater form doesn't run synchronously, so code
  // immediately after a setState call can't rely on it having applied yet).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const pushLine = useCallback((level: OrchestratorEvent['level'], phase: string, message: string): void => {
    const id = ++lineSeq.current;
    setState((prev) => ({
      ...prev,
      lines: [...prev.lines, { id, level, phase, message, ts: nowLabel() }],
    }));
  }, []);

  // One-time hydration on mount: this hook is now called once, at the App
  // root, so a normal navigation never remounts it — but a fresh renderer
  // (first load, or a future window re-create) could still mount while a run
  // is already executing in the main process. Rebuild the console from its
  // persisted event history instead of sitting idle until the next live
  // event happens to arrive, so the log reads gap-free from the very start.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let active: Awaited<ReturnType<typeof window.healix.getActiveRun>>;
      try {
        active = await window.healix.getActiveRun();
      } catch {
        return;
      }
      if (cancelled || !active || activeRunId.current) return;

      let detail: Awaited<ReturnType<typeof window.healix.runDetail>>;
      try {
        detail = await window.healix.runDetail(active.runId);
      } catch {
        return;
      }
      if (cancelled || !detail.run || activeRunId.current) return;

      activeRunId.current = active.runId;
      const lines: ConsoleLine[] = detail.events.map((e) => ({
        id: ++lineSeq.current,
        level: e.level,
        phase: e.phase,
        message: e.message,
        ts: new Date(e.createdAt).toLocaleTimeString(undefined, { hour12: false }),
      }));
      setState({
        ...INITIAL,
        runId: active.runId,
        lines,
        phase: detail.run.status === 'awaiting-approval' ? 'awaiting-approval' : 'running',
        plan: detail.plan,
        workingPlan: detail.plan ? clonePlan(detail.plan) : null,
        hydrated: true,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.healix.onRunEvent((msg: RunChannelMessage) => {
      if (msg.channel === 'queue:updated' || msg.channel === 'queue:failed') return; // handled by useRunQueue, not this engine.

      // run:started always wins, even over a DIFFERENT previously-tracked run:
      // this is exactly how a queued request announces "it's my turn now" —
      // the engine must adopt it and drop whatever the last (now-settled) run
      // left behind, not filter it out for not matching the stale id.
      if (msg.channel === 'run:started') {
        activeRunId.current = msg.payload.runId;
        lineSeq.current = 0;
        setState({ ...INITIAL, runId: msg.payload.runId, phase: 'running' });
        return;
      }

      const incomingRunId = msg.payload.runId;
      // Ignore stray messages from a previous/other run.
      if (activeRunId.current && incomingRunId !== activeRunId.current) return;

      switch (msg.channel) {
        case 'run:event': {
          const e = msg.payload.event;
          pushLine(e.level, String(e.phase), e.message);
          break;
        }
        case 'run:plan': {
          const plan = msg.payload.plan;
          setState((prev) => ({
            ...prev,
            plan,
            workingPlan: clonePlan(plan),
            planDecided: false,
            revisingItemIds: new Set(),
            reviseErrors: {},
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
      const result = await window.healix.startRun(args);
      if (result.queued) {
        // Caller expected this to start immediately (a small race: another run
        // began between this component's last idle check and this call landing)
        // — it's sitting in the queue now instead. Drop back to idle; the
        // queue view shows it, and run:started will pick the engine up
        // automatically once it's actually this request's turn.
        setState(INITIAL);
        return;
      }
      const summary = result.summary;
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

  /**
   * Queue a run request behind whatever is currently executing — see
   * RunsView's "Queue run" action. Deliberately does not touch this engine's
   * own state: the queued entry shows up via useRunQueue's queue:updated
   * broadcast, and if a race means it actually starts immediately instead,
   * this engine picks it up on its own via the (always-accepted) run:started
   * broadcast — either way, nothing further to do here.
   */
  const queueRun = useCallback(async (args: StartRunArgs): Promise<void> => {
    await window.healix.startRun(args);
  }, []);

  const approveItem = useCallback((itemId: string): void => {
    setState((prev) => {
      if (!prev.workingPlan) return prev;
      return {
        ...prev,
        workingPlan: mapItem(prev.workingPlan, itemId, (it) => ({ ...it, status: 'approved' })),
      };
    });
  }, []);

  const rejectItem = useCallback((itemId: string): void => {
    setState((prev) => {
      if (!prev.workingPlan) return prev;
      return {
        ...prev,
        workingPlan: mapItem(prev.workingPlan, itemId, (it) => ({ ...it, status: 'rejected' })),
      };
    });
  }, []);

  const editItem = useCallback((itemId: string, patch: PlanItemSnapshot): void => {
    setState((prev) => {
      if (!prev.workingPlan) return prev;
      return {
        ...prev,
        workingPlan: mapItem(prev.workingPlan, itemId, (it) => {
          const before = snapshotOf(it);
          const edits = [...(it.edits ?? []), { before, after: patch, editedAt: new Date().toISOString() }];
          return {
            ...it,
            ...patch,
            status: 'edited' as PlanItemStatus,
            original: it.original ?? before,
            edits,
          };
        }),
      };
    });
  }, []);

  const reviseItem = useCallback(
    async (itemId: string, suggestion: string, projectId: string): Promise<void> => {
      const runId = activeRunId.current;
      if (!runId) return;
      // Read the item to revise from the latest committed state (stateRef), not
      // from a setState updater — updaters don't run synchronously, so code
      // right after calling setState can't rely on their result yet.
      const current = stateRef.current;
      if (!current.workingPlan || current.planDecided) return;
      const target = current.workingPlan.items.find((it) => it.id === itemId);
      if (!target) return;

      setState((prev) => {
        if (!prev.workingPlan || prev.planDecided) return prev;
        const nextRevising = new Set(prev.revisingItemIds);
        nextRevising.add(itemId);
        const nextErrors = { ...prev.reviseErrors };
        delete nextErrors[itemId];
        return { ...prev, revisingItemIds: nextRevising, reviseErrors: nextErrors };
      });

      let result: Awaited<ReturnType<typeof window.healix.reviseItem>>;
      try {
        result = await window.healix.reviseItem({ projectId, item: target, suggestion });
      } catch (err) {
        result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }

      setState((prev) => {
        // Stale reply: the run moved on (different run, or the gate was already
        // decided) while this call was in flight — discard rather than mutate a
        // plan that's no longer under review.
        if (activeRunId.current !== runId || prev.planDecided || !prev.workingPlan) return prev;
        const nextRevising = new Set(prev.revisingItemIds);
        nextRevising.delete(itemId);
        if (!result.ok) {
          return {
            ...prev,
            revisingItemIds: nextRevising,
            reviseErrors: { ...prev.reviseErrors, [itemId]: result.detail },
          };
        }
        const revised = result.item;
        return {
          ...prev,
          revisingItemIds: nextRevising,
          workingPlan: mapItem(prev.workingPlan, itemId, (it) => {
            const before = snapshotOf(it);
            const after = snapshotOf(revised);
            const revisions = [
              ...(it.revisions ?? []),
              { suggestion, before, after, revisedAt: new Date().toISOString() },
            ];
            return {
              ...it,
              ...after,
              // Re-enters review (badged distinctly from a never-touched
              // 'pending' item) rather than auto-approving. needsDecision()
              // treats 'revised' the same as 'pending', so approveAndContinue
              // still defaults it to approved if left untouched further.
              status: 'revised' as PlanItemStatus,
              original: it.original ?? before,
              revisions,
            };
          }),
        };
      });
    },
    [],
  );

  const approveAndContinue = useCallback(async (): Promise<void> => {
    const runId = activeRunId.current;
    if (!runId) return;
    const current = stateRef.current;
    if (!current.workingPlan) return;
    const finalPlan: TestPlan = {
      ...current.workingPlan,
      items: current.workingPlan.items.map((it) =>
        needsDecision(it.status) ? { ...it, status: 'approved' as PlanItemStatus } : it,
      ),
    };
    setState((prev) => ({
      ...prev,
      workingPlan: finalPlan,
      planDecided: true,
      phase: 'running',
      hydrated: false,
    }));
    try {
      const result = await window.healix.approveRun(runId, { decision: 'proceed', plan: finalPlan });
      if (!result.settled) {
        setState((prev) => ({
          ...prev,
          phase: 'error',
          error:
            "This run's approval session had already ended (most likely an app restart), so it couldn't actually resume — it's been marked as an error.",
        }));
      }
    } catch {
      // The gate may have already settled (e.g. run torn down); safe to ignore.
    }
  }, []);

  const rejectAll = useCallback(async (): Promise<void> => {
    const runId = activeRunId.current;
    if (!runId) return;
    const rejectionLine: ConsoleLine = {
      id: ++lineSeq.current,
      level: 'info',
      phase: 'approve',
      message: 'Plan rejected — cancelling run.',
      ts: nowLabel(),
    };
    setState((prev) => ({
      ...prev,
      planDecided: true,
      phase: 'cancelled',
      hydrated: false,
      lines: [...prev.lines, rejectionLine],
    }));
    try {
      const result = await window.healix.approveRun(runId, { decision: 'cancel' });
      if (!result.settled) {
        setState((prev) => ({
          ...prev,
          phase: 'cancelled',
          error:
            "This run's approval session had already ended (most likely an app restart) before you responded — it's been marked as cancelled.",
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
        // gap as approveAndContinue/rejectAll's !settled case). run:done will
        // now never arrive, so without this the UI would show "Cancelling…"/
        // "Running…" forever for a run that isn't running anywhere. The main
        // process force-settles the DB row to 'cancelled' itself in this case
        // (the user did explicitly ask to cancel it); mirror that phase here.
        // Keep runId/identity (not a full reset) so the error banner stays
        // scoped to THIS run via showLiveSurface, not shown for every run.
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
      workingPlan: clonePlan(args.plan),
      hydrated: true,
    });
  }, []);

  const clearError = useCallback((): void => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    start,
    queueRun,
    approveItem,
    rejectItem,
    editItem,
    reviseItem,
    approveAndContinue,
    rejectAll,
    cancel,
    reset,
    hydrate,
    clearError,
  };
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
