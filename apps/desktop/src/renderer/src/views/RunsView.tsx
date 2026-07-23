import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, SuiteMode, TestingScope } from '@healix/core';
import { ChevronDown, ChevronUp, Loader2, ListPlus, Pause, Play, Plus, Square, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge, type BadgeTone } from '../components/ui/badge';
import { Select } from '../components/ui/select';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { SheetPickerDialog } from '../components/ui/sheet-picker-dialog';
import { ConsoleLog } from '../components/ConsoleLog';
import { PlanGate } from '../components/PlanGate';
import { LiveBrowser } from '../components/LiveBrowser';
import { RunHistory } from '../components/RunHistory';
import { RunDetailPanel } from '../components/RunDetailPanel';
import { RunQueuePanel } from '../components/RunQueuePanel';
import { useProjects } from '../lib/use-projects';
import { useRuns } from '../lib/use-runs';
import { useRunDetail } from '../lib/use-run-detail';
import { useLastSuccessfulRun } from '../lib/use-last-successful-run';
import { useLiveFrame } from '../lib/use-live-frame';
import { cn } from '../lib/utils';
import { formatCreatedAt, isTerminalRun } from '../lib/run-format';
import { SUITE_MODES, TESTING_SCOPES, type RunEngine, type RunPhase } from '../lib/run-engine';
import type { RunQueue } from '../lib/run-queue';
import type { SheetPreview } from '../lib/ipc-types';

const PHASE_TONE: Record<RunPhase, BadgeTone> = {
  idle: 'muted',
  starting: 'default',
  running: 'default',
  'plan-streaming': 'default',
  'awaiting-approval': 'warn',
  paused: 'warn',
  done: 'ok',
  cancelled: 'muted',
  error: 'err',
};

const PHASE_LABEL: Record<RunPhase, string> = {
  idle: 'idle',
  starting: 'starting…',
  running: 'running',
  'plan-streaming': 'generating plan…',
  'awaiting-approval': 'awaiting approval',
  paused: 'paused',
  done: 'done',
  cancelled: 'cancelled',
  error: 'error',
};

/**
 * Engine phases in which the run is no longer actively executing, so a new
 * run can be started/queued without waiting: true terminal outcomes, AND
 * 'paused' — a pause fully releases the run's execution slot server-side
 * (see main/index.ts's activeRuns bookkeeping), it just stays resumable.
 */
const SETTLED_PHASES: ReadonlyArray<RunPhase> = ['paused', 'done', 'cancelled', 'error'];

// App.tsx conditionally unmounts RunsView when the user switches to another
// page, which would otherwise reset these on every navigation. Plain module
// state survives that remount and resets only on the next app launch — same
// lifetime historyCollapsed already documented for itself, just actually
// honored across navigation instead of only within a single mount.
let persistedSelectedRunId: string | null | undefined;

// Same reasoning as persistedSelectedRunId above: RunsView fully unmounts on
// navigating away, so a useRef here would reset to the prop's own value on
// every remount (it'd not equal to itself) and the "did this actually
// change" check below would never fire. Module state survives the unmount,
// so a genuine bump from a Run click is still detectable as different from
// whatever this was last observed as. Starts at 0 to match App.tsx's counter,
// which also starts at 0 and only ever increments — so a plain sidebar nav
// into Runs before any Run click ever happened (prop still 0) correctly
// never fires this on the very first mount.
let lastSeenRunRequestSeq = 0;

// Same reasoning again, for the "run just settled, auto-select it" effect
// below: engine.phase/engine.runId are lifted to App.tsx and stay at their
// settled values indefinitely (until a new run actually starts), so a
// useRef-based "have I already handled this settle" guard would reset blank
// on every single remount and re-fire for the SAME stale settled run every
// time RunsView remounts — e.g. clicking Run for a totally different project
// right after a previous run was cancelled would still get its async
// refreshRuns().then() callback firing again and yanking the fresh compose
// form back to that old cancelled run. Module state remembers it was already
// handled across the remount.
let lastSettledKey: string | null = null;

// Closes a further gap the module state above doesn't: it only stops a
// settle already handled in a PREVIOUS mount from re-firing. It does nothing
// for a settle that fires for the FIRST time while the user is already
// looking at a fresh compose screen for a different project — e.g. Cancel a
// run, then immediately click Run elsewhere before the cancellation's
// run:done confirmation actually arrives. That confirmation still lands
// (engine.phase/runId are lifted to App.tsx and don't care which view is
// mounted) and would hijack the compose screen the instant it does. True
// from the moment the user explicitly asks for a blank compose screen (Run
// button or New run) until a new run actually starts or they explicitly pick
// a different history row — while true, the settle effect must not
// auto-select anything.
let awaitingFreshRunConfig = false;

export function RunsView({
  initialProjectId,
  runRequestSeq,
  engine,
  queue,
  sidebarCollapsed = false,
}: {
  initialProjectId?: string | null;
  /**
   * Bumped by App.tsx on every "Run" click from the Projects list (even for
   * the same project — initialProjectId alone can't signal that). Landing
   * here should always show the editable compose form pre-selected to that
   * project, the same as clicking "New run", never a leftover historical
   * run's read-only detail.
   */
  runRequestSeq?: number;
  /** Lifted to App.tsx so the live run survives navigating away from and back to this view. */
  engine: RunEngine;
  queue: RunQueue;
  /** Hides the history rail entirely — toggled from the activity bar by re-clicking the Runs icon. */
  sidebarCollapsed?: boolean;
}) {
  const { projects, loading: projectsLoading } = useProjects();
  // History spans all projects so the user can review past runs across targets.
  const { runs, loading: runsLoading, error: runsError, refresh: refreshRuns } = useRuns();

  const [projectId, setProjectId] = useState<string>('');
  const [testingScope, setTestingScope] = useState<TestingScope>('both');
  const [suiteMode, setSuiteMode] = useState<SuiteMode>('fresh');
  const [prd, setPrd] = useState('');
  // Set once a PRD file is successfully uploaded; cleared if the user edits the
  // textarea by hand, since the displayed text no longer matches the file.
  const [prdFileName, setPrdFileName] = useState<string | null>(null);
  const [prdFileBusy, setPrdFileBusy] = useState(false);
  const [prdFileError, setPrdFileError] = useState<string | null>(null);
  // Non-fatal notes (e.g. row-cap truncation) surfaced alongside the file
  // status, distinct from prdFileError which means the upload failed outright.
  const [prdFileWarning, setPrdFileWarning] = useState<string | null>(null);
  // Provenance of the current `prd` text — carried through to the run's
  // persisted config snapshot so history can show "Source: X.xlsx (sheets: ...)".
  const [prdSourceKind, setPrdSourceKind] = useState<'text' | 'file' | 'spreadsheet' | null>(null);
  const [prdSelectedSheets, setPrdSelectedSheets] = useState<string[] | null>(null);
  // Set while a multi-sheet workbook's picker dialog is open; cleared on confirm/cancel.
  const [sheetPickerFile, setSheetPickerFile] = useState<{
    filePath: string;
    fileName: string;
    sheets: SheetPreview[];
  } | null>(null);
  // Interactive prompting: freeform steering instructions ("how to test"),
  // distinct from the PRD ("what the app does") — sent to the planning
  // provider verbatim alongside it (see RunOptions.instructions).
  const [instructions, setInstructions] = useState('');
  const [selectedRunId, setSelectedRunIdState] = useState<string | null>(
    () => persistedSelectedRunId ?? null,
  );
  const setSelectedRunId = (id: string | null): void => {
    persistedSelectedRunId = id;
    setSelectedRunIdState(id);
  };
  // True from the moment the user clicks Cancel until run:done settles the run.
  const [cancelling, setCancelling] = useState(false);
  // Same pattern for the Pause button.
  const [pausing, setPausing] = useState(false);
  // True while a resumeRun IPC call for a selected paused run is in flight.
  const [resuming, setResuming] = useState(false);
  // Set when the most recent "Queue run" click itself failed (e.g. the
  // project was deleted in another window) — distinct from engine.error,
  // which is scoped to the run the engine is actively tracking, not this button.
  const [queueError, setQueueError] = useState<string | null>(null);
  // Set when a run-delete IPC call itself failed (e.g. the run was already gone).
  const [runDeleteError, setRunDeleteError] = useState<string | null>(null);
  // Collapsing "Start a run" frees most of the column for the report/timeline
  // section below it — toggled via the centered chevron divider. Always
  // starts expanded so the run controls are immediately visible; collapsing
  // is only ever an explicit, momentary choice via the chevron — switching
  // to a different project's run panel, or any other remount of this view,
  // resets back to expanded rather than remembering a previous collapse.
  const [formCollapsed, setFormCollapsed] = useState(false);

  const { detail, loading: detailLoading, reload: reloadDetail } = useRunDetail(selectedRunId);
  const { run: lastSuccessfulRun, reload: reloadLastSuccessful } = useLastSuccessfulRun(projectId || null);
  const { frame } = useLiveFrame(engine.runId);

  const hasSuite = lastSuccessfulRun !== null;
  // A different project may have no suite to top up/reuse yet — fall back to
  // Fresh rather than leaving the toggle on an option that's about to be disabled.
  useEffect(() => {
    if (!hasSuite && suiteMode !== 'fresh') setSuiteMode('fresh');
  }, [hasSuite, suiteMode]);
  // Refresh "last successful run" once a run just settled, so the toggle picks
  // up a run that only just became eligible as a top-up/reuse base.
  useEffect(() => {
    if (SETTLED_PHASES.includes(engine.phase)) void reloadLastSuccessful();
  }, [engine.phase, reloadLastSuccessful]);

  // The very first time this view is shown this session, default to the most
  // recent run so its detail is visible immediately instead of an empty
  // "select a run" placeholder. Only fires once — a `persistedSelectedRunId`
  // of `undefined` means "never decided yet"; any later value (including an
  // explicit null from starting a new run) means a choice was already made,
  // so re-navigating back here won't stomp on it.
  const autoSelectedOnce = useRef(persistedSelectedRunId !== undefined);
  useEffect(() => {
    if (autoSelectedOnce.current || runsLoading || runs.length === 0) return;
    autoSelectedOnce.current = true;
    setSelectedRunId(runs[0].id);
  }, [runsLoading, runs]);

  // History rows may reference archived projects, so the lookup keeps ALL of
  // them; only the "start a run" selector is restricted to active projects.
  const projectsById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);
  const runnable = useMemo(() => projects.filter((p) => !p.archivedAt), [projects]);

  // Default the selection to the deep-linked project, else the first project.
  useEffect(() => {
    if (projectId) return;
    const deepLinked = initialProjectId && runnable.find((p) => p.id === initialProjectId);
    const picked = deepLinked || runnable[0];
    if (!picked) return;
    setProjectId(picked.id);
  }, [initialProjectId, runnable, projectId]);

  // Switching the target project re-expands "Start a run" — a collapse is
  // only ever a per-project, explicit choice via the chevron, never carried
  // over to whichever project you look at next.
  useEffect(() => {
    if (!projectId) return;
    setFormCollapsed(false);
  }, [projectId]);

  // Same rule for picking a different run from the history rail — a
  // collapse never carries over to whichever run you look at next.
  useEffect(() => {
    if (!selectedRunId) return;
    setFormCollapsed(false);
  }, [selectedRunId]);

  const isActive =
    engine.phase === 'starting' ||
    engine.phase === 'running' ||
    engine.phase === 'plan-streaming' ||
    engine.phase === 'awaiting-approval';

  // Mirrors `engine` for the settle effect below, whose refreshRuns().then()
  // callback needs to read the LATEST engine state at the time it resolves,
  // not the stale snapshot closed over when the effect fired — see that
  // effect's own comment for why.
  const engineRef = useRef(engine);
  engineRef.current = engine;

  // Re-attach to a run that's still genuinely parked awaiting approval in the
  // main process — its approval promise only dies on app restart, not on
  // navigating away from this view — but whose live engine state was lost
  // because this component unmounted in the meantime. Triggered by explicitly
  // selecting that run in history (not automatically on mount), so landing on
  // Runs always shows the normal start-a-run screen, and other history rows
  // stay freely browsable even while this one sits pending — see showLiveSurface.
  const { hydrate } = engine;
  useEffect(() => {
    if (!selectedRunId || selectedRunId === engine.runId) return;
    // Never let browsing history steal the engine away from a genuinely live
    // run in progress — e.g. glancing at an unrelated run that was orphaned
    // mid-approval in a previous session must not hijack the run that's
    // actually executing right now.
    if (isActive && !engine.hydrated) return;
    // useRunDetail keeps the PREVIOUS run's detail on screen until its own
    // fetch for the new selectedRunId resolves — without this check, clicking
    // a different history row could momentarily hydrate the engine with the
    // prior row's stale plan/status before the real detail ever arrives.
    if (!detail?.plan || detail.run?.id !== selectedRunId || detail.run.status !== 'awaiting-approval') {
      return;
    }
    hydrate({ runId: selectedRunId, plan: detail.plan });
    setProjectId(detail.run.projectId);
  }, [selectedRunId, detail, engine.runId, engine.hydrated, isActive, hydrate]);

  // Clear the "Cancelling…"/"Pausing…" state once the run settles (run:done) or resets.
  useEffect(() => {
    if (!isActive) {
      setCancelling(false);
      setPausing(false);
    }
  }, [isActive]);

  // When a run finishes, refresh history and select the freshly-completed run.
  // Also reload its detail bundle directly: setSelectedRunId(settledId) is a
  // no-op re-render when it's already the current selection (e.g. rejecting/
  // cancelling a run you were already viewing), so useRunDetail would
  // otherwise never refetch and its status badge would stay stuck on
  // whatever it read before the just-persisted change.
  //
  // Keyed by runId+phase (not just runId): 'paused' is itself a settled phase
  // now, and the SAME run can move through several of them in one session
  // (paused -> resumed -> paused again, or paused -> cancelled) — a runId-only
  // guard would fire once on the first settle and then never again for that
  // run, leaving history/detail stuck showing the earlier status forever.
  useEffect(() => {
    if (SETTLED_PHASES.includes(engine.phase) && engine.runId) {
      const key = `${engine.runId}:${engine.phase}`;
      if (lastSettledKey === key) return;
      lastSettledKey = key;
      // The [isActive] effect above only fires on an active->inactive
      // TRANSITION, so it misses a settle that starts and ends inactive (e.g.
      // cancelling an already-paused run — 'paused' and 'cancelled' are both
      // outside isActive, so it never changes and that effect never re-runs),
      // which left "Cancelling…"/"Pausing…" stuck forever. This effect already
      // fires on every distinct runId+phase settle, repeats included, so reset
      // here too.
      setCancelling(false);
      setPausing(false);
      const settledId = engine.runId;
      void refreshRuns().then(() => {
        // Stale by the time this resolves: the user already moved on (e.g.
        // cancelled this run, then immediately started a different one
        // before this refresh came back) — engine.runId no longer points at
        // the run this callback was about. Selecting it now would yank the
        // view away from whatever the user is already looking at.
        if (engineRef.current.runId !== settledId) return;
        // The user explicitly asked for a blank compose screen (Run/New run)
        // and no new run has started yet to supersede that intent — this
        // settle confirmation (e.g. for the run they just cancelled to get
        // here) arriving late must not hijack that screen back to it.
        if (awaitingFreshRunConfig) return;
        setSelectedRunId(settledId);
        void reloadDetail();
      });
    }
    if (engine.phase === 'idle' || engine.phase === 'starting') {
      lastSettledKey = null;
      awaitingFreshRunConfig = false;
    }
  }, [engine.phase, engine.runId, refreshRuns, reloadDetail]);

  // Refresh as soon as the run gets an id, and again on every phase change
  // while active, so a brand-new run appears and phase transitions (e.g.
  // awaiting-approval) show up in the history rail without a manual refresh.
  useEffect(() => {
    if (!engine.runId || !isActive) return;
    void refreshRuns();
  }, [engine.runId, engine.phase, isActive, refreshRuns]);

  // The orchestrator advances through several statuses (exploring/generating/
  // executing/...) without changing engine.phase (it stays 'running'), so
  // poll the same refresh while active to keep the status badge current.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => void refreshRuns(), 3000);
    return () => clearInterval(id);
  }, [isActive, refreshRuns]);

  // useRunDetail fetches its tests/results/report snapshot only once per
  // selectedRunId and otherwise only refetches once the run fully settles
  // (see the SETTLED_PHASES effect above) — so watching a still-in-progress
  // run's Results tab showed a stale, smaller test count than the report.html
  // file (re-read fresh from disk every time it's opened) as the run kept
  // adding rows in the background. Poll the same detail while the SELECTED
  // run itself is non-terminal, regardless of whether it's the one the local
  // engine is driving (e.g. re-opening a run started in a previous session).
  const selectedRunStatus = detail?.run?.status ?? null;
  useEffect(() => {
    if (!selectedRunId || !selectedRunStatus || isTerminalRun(selectedRunStatus)) return;
    const id = setInterval(() => void reloadDetail(), 3000);
    return () => clearInterval(id);
  }, [selectedRunId, selectedRunStatus, reloadDetail]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );
  // The panel is relevant whenever the project has a live URL to mirror and
  // the selected scope actually exercises the browser — not tied to
  // repoPath/exploration mode, since a codegen project with a baseUrl still
  // drives a real browser during EXPLORE and EXECUTE.
  const showLiveBrowserPanel = !!selectedProject?.baseUrl && testingScope !== 'backend';

  // Auto-dismiss after a few seconds — still manually dismissable in the meantime.
  useEffect(() => {
    if (!queueError) return;
    const id = setTimeout(() => setQueueError(null), 8000);
    return () => clearTimeout(id);
  }, [queueError]);

  useEffect(() => {
    if (!runDeleteError) return;
    const id = setTimeout(() => setRunDeleteError(null), 8000);
    return () => clearTimeout(id);
  }, [runDeleteError]);

  /**
   * Delete a single historical run (DB rows + on-disk assets). Refuses (via
   * the main-process handler) while that run is still executing. Clears the
   * selection when the deleted run was the one on screen, so RunDetailPanel
   * doesn't keep showing detail for a run that no longer exists.
   */
  const deleteRun = async (runId: string): Promise<void> => {
    setRunDeleteError(null);
    try {
      await window.healix.deleteRun(runId);
      if (selectedRunId === runId) setSelectedRunId(null);
      await refreshRuns();
    } catch (err) {
      setRunDeleteError(err instanceof Error ? err.message : String(err));
    }
  };

  const startOrQueue = (): void => {
    if (!projectId) return;
    const args = {
      projectId,
      testingScope,
      suiteMode,
      prd: prd.trim() || undefined,
      instructions: instructions.trim() || undefined,
      prdSourceKind: prd.trim() ? (prdSourceKind ?? 'text') : undefined,
      prdFileName: prd.trim() ? (prdFileName ?? undefined) : undefined,
      prdSelectedSheets: prd.trim() ? (prdSelectedSheets ?? undefined) : undefined,
    };
    if (isActive) {
      // Explicit: the button reads "Queue run" whenever a run is already
      // active — this never silently supersedes the run currently on screen.
      setQueueError(null);
      void engine.queueRun(args).catch((err) => {
        setQueueError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    // Showing live run UI rather than a historical detail.
    setSelectedRunId(null);
    // Auto-collapse "Start a run" so the live console gets the column's full
    // height immediately, instead of making the user click the chevron themselves.
    setFormCollapsed(true);
    void engine.start(args);
  };

  const cancel = (): void => {
    if (cancelling || !engine.runId) return;
    setCancelling(true);
    // The engine phase stays as-is until the authoritative run:done arrives
    // with status 'cancelled' (SETTLED_PHASES then refreshes the history).
    void engine.cancel();
  };

  const pause = (): void => {
    if (pausing || !engine.runId) return;
    setPausing(true);
    // Same cooperative pattern as cancel: the phase stays as-is until the
    // authoritative run:done arrives with status 'paused'.
    void engine.pause();
  };

  const resumePausedRun = (runId: string): void => {
    if (resuming || isActive) return;
    setResuming(true);
    void engine.resume(runId).finally(() => setResuming(false));
  };

  const uploadPrdFile = async (): Promise<void> => {
    setPrdFileError(null);
    setPrdFileWarning(null);
    setPrdFileBusy(true);
    try {
      const result = await window.healix.pickPrdFile();
      if (result.canceled) return;
      if (result.error) {
        setPrdFileError(result.error);
        return;
      }
      if (result.needsSheetPicker && result.filePath && result.sheets) {
        // Multi-sheet workbook — hand off to the picker dialog instead of
        // setting `prd` directly; confirmSheetSelection finishes the job.
        setSheetPickerFile({
          filePath: result.filePath,
          fileName: result.fileName ?? '',
          sheets: result.sheets,
        });
        return;
      }
      setPrd(result.text ?? '');
      setPrdFileName(result.fileName ?? null);
      setPrdSourceKind(result.sourceKind ?? 'file');
      setPrdSelectedSheets(result.selectedSheets ?? null);
      if (result.warnings && result.warnings.length > 0) setPrdFileWarning(result.warnings.join(' '));
    } catch (err) {
      setPrdFileError(err instanceof Error ? err.message : String(err));
    } finally {
      setPrdFileBusy(false);
    }
  };

  const confirmSheetSelection = async (selectedNames: string[]): Promise<void> => {
    const file = sheetPickerFile;
    if (!file) return;
    setSheetPickerFile(null);
    setPrdFileError(null);
    setPrdFileWarning(null);
    setPrdFileBusy(true);
    try {
      const result = await window.healix.extractPrdSheets(file.filePath, selectedNames);
      if (result.error) {
        setPrdFileError(result.error);
        return;
      }
      const joined = (result.sheets ?? []).map((s) => `--- Sheet: ${s.name} ---\n${s.content}`).join('\n\n');
      setPrd(joined);
      setPrdFileName(file.fileName);
      setPrdSourceKind('spreadsheet');
      setPrdSelectedSheets(selectedNames);
      if (result.warnings && result.warnings.length > 0) setPrdFileWarning(result.warnings.join(' '));
    } catch (err) {
      setPrdFileError(err instanceof Error ? err.message : String(err));
    } finally {
      setPrdFileBusy(false);
    }
  };

  // The live surface is shown ONLY for the run the engine is actually tracking
  // (live-this-session or rehydrated) AND only while it's still non-terminal.
  // Selecting a DIFFERENT row in history always shows THAT run's own fetched
  // detail instead, even while a run is actively executing in the background.
  // This is what lets the user freely browse other runs/projects while the
  // active run keeps going untouched: navigating between runs only ever
  // fetches the data for the one selected.
  //
  // The `isActive` gate matters even for the CURRENTLY selected run: once it
  // settles (SETTLED_PHASES effect above refreshes history + reloads detail),
  // engine.runId keeps pointing at it and selectedRunId was set to the same
  // id — without this gate the view would stay on the bare live Console
  // forever, never showing RunDetailPanel's Report/Reveal suite/Export suite
  // controls until the user clicked "New run" or picked a different history row.
  //
  // Before the engine has a real runId yet (the brief 'starting' window right
  // after clicking Start/Queue, before run:started arrives), fall back to
  // "was nothing else explicitly selected" so the just-started run's own
  // transient state is still shown rather than a blank/unrelated panel.
  const showLiveSurface =
    engine.runId != null ? selectedRunId === engine.runId && isActive : isActive && selectedRunId == null;

  // A run just started/queued-in this session begins with engine.runId still
  // null (see startOrQueue, which clears selectedRunId first) — showLiveSurface
  // falls back to the "nothing else selected" branch above and the console
  // shows. But the instant run:started arrives, engine.runId flips to a real
  // id while selectedRunId is still null, so the runId-based branch above no
  // longer matches and the console would vanish again right away. Adopt the
  // freshly-assigned runId as the selection so the live console keeps showing.
  // Skipped for a hydrated re-attach: selectedRunId is already set to that
  // run's id by the effect that triggers hydrate() in the first place.
  //
  // Also gated on the run actually being live (not settled): engine.runId
  // stays set to the LAST run indefinitely — it's only ever cleared back to
  // null at the very start of a fresh start()/resume(), never when a run
  // finishes/cancels/errors. Without the settled check, resetting
  // selectedRunId to null to open a fresh compose screen (Run/New run) would
  // immediately get overwritten right back to that old, already-settled run
  // by this same effect.
  useEffect(() => {
    if (!engine.runId || engine.hydrated || SETTLED_PHASES.includes(engine.phase)) return;
    // The user explicitly asked for a blank compose screen (Run/New run) to
    // queue a different run behind whatever the engine is already tracking —
    // e.g. clicking "+" while another run is active never touches engine
    // phase (queueRun doesn't set 'starting' the way start() does), so
    // without this guard this effect would immediately snap selectedRunId
    // right back to that unrelated already-active run, locking the fresh
    // compose form the instant it opened. Cleared the moment a genuinely new
    // run actually starts (phase 'starting'/'idle', see the settle effect
    // above) or the user picks a different history row instead.
    if (awaitingFreshRunConfig) return;
    if (selectedRunId === null) setSelectedRunId(engine.runId);
  }, [engine.runId, engine.hydrated, engine.phase, selectedRunId]);

  // Viewing a selected run that isn't the live-tracked one — i.e. a genuinely
  // historical (already-run) row picked from the sidebar. The "Start a run"
  // card switches from the editable compose form into a read-only "what was
  // this configured with" summary for it, sourced from run-config.json (see
  // RunDetail.runConfig) — falling back to just the Run row's own suiteMode
  // for a run that predates that file.
  const viewingHistoricalRun = !!selectedRunId && !showLiveSurface && !!detail?.run;
  // Locks every config field to read-only: either a genuinely historical row
  // (viewingHistoricalRun), or the run THIS card was just used to start,
  // still live (showLiveSurface implies isActive — see its own definition) —
  // once a run has begun, its configuration can no longer be edited. A fresh
  // compose form (e.g. right after "+"/New run while another run executes
  // elsewhere) has showLiveSurface false, so it stays editable for queuing.
  const configLocked = viewingHistoricalRun || showLiveSurface;
  const historicalProject = detail?.run ? projectsById.get(detail.run.projectId) : undefined;
  // Whichever project this locked/historical view's config belongs to —
  // historicalProject for a genuinely past row, selectedProject (still valid,
  // never reset mid-run) for the run this card itself just started.
  const lockedProject = viewingHistoricalRun ? historicalProject : selectedProject;
  const effectiveTestingScope = viewingHistoricalRun
    ? (detail?.runConfig?.testingScope ?? 'both')
    : testingScope;
  const effectiveSuiteMode = viewingHistoricalRun
    ? (detail?.runConfig?.suiteMode ?? detail?.run?.suiteMode ?? 'fresh')
    : suiteMode;
  const effectivePrd = viewingHistoricalRun ? (detail?.runConfig?.prd ?? '') : prd;
  const effectiveInstructions = viewingHistoricalRun ? (detail?.runConfig?.instructions ?? '') : instructions;
  // "Source: TestCases.xlsx (sheets: Login, Signup)" for a spreadsheet-sourced
  // run, falling back to plain filename-only display otherwise. Historical
  // reads from the persisted run-config snapshot; the still-live case reads
  // straight from the upload-flow state (never cleared once a run starts).
  const historicalPrdSource = viewingHistoricalRun
    ? detail?.runConfig?.prdFileName
      ? detail.runConfig.prdSourceKind === 'spreadsheet' && detail.runConfig.prdSelectedSheets?.length
        ? `Source: ${detail.runConfig.prdFileName} (sheets: ${detail.runConfig.prdSelectedSheets.join(', ')})`
        : `Source: ${detail.runConfig.prdFileName}`
      : null
    : null;
  const lockedPrdSource = viewingHistoricalRun
    ? historicalPrdSource
    : prdFileName
      ? prdSourceKind === 'spreadsheet' && prdSelectedSheets && prdSelectedSheets.length > 0
        ? `Source: ${prdFileName} (sheets: ${prdSelectedSheets.join(', ')})`
        : `Source: ${prdFileName}`
      : null;

  /**
   * Clears the historical-run view and resets the compose form to defaults,
   * ready for a fresh run. Also marks the run-history auto-select as already
   * decided: on the very first-ever visit to Runs this app session (before
   * `runs` has finished loading), that effect is still armed and would
   * otherwise fire once history loads and stomp this reset right back to the
   * latest run — see its own comment above. Sets awaitingFreshRunConfig so a
   * late-arriving settle confirmation for a DIFFERENT, already-abandoned run
   * (see that effect's own comment) can't hijack this screen either.
   */
  const startNewRunConfig = useCallback((): void => {
    autoSelectedOnce.current = true;
    awaitingFreshRunConfig = true;
    setSelectedRunId(null);
    setPrd('');
    setPrdFileName(null);
    setPrdFileError(null);
    setPrdFileWarning(null);
    setPrdSourceKind(null);
    setPrdSelectedSheets(null);
    setSheetPickerFile(null);
    setInstructions('');
    setTestingScope('both');
    setSuiteMode('fresh');
    setFormCollapsed(false);
  }, []);

  // "Run" clicked on the Projects list — always land on the editable compose
  // form for that project, exactly like "New run", never a leftover selected
  // historical run's read-only detail. See lastSeenRunRequestSeq above for
  // why this compares against module state rather than a useRef.
  useEffect(() => {
    if (runRequestSeq === undefined) return;
    if (runRequestSeq !== lastSeenRunRequestSeq) {
      startNewRunConfig();
      if (initialProjectId) setProjectId(initialProjectId);
    }
    lastSeenRunRequestSeq = runRequestSeq;
  }, [runRequestSeq, initialProjectId, startNewRunConfig]);

  return (
    <>
      <div className="flex h-full min-h-0">
        {/* History rail — shown/hidden entirely from the activity bar (re-clicking
          the Runs icon), not by an in-page collapse control. */}
        {!sidebarCollapsed && (
          <div className="flex w-64 shrink-0 flex-col border-r border-border px-4 pb-6 pt-8">
            <RunHistory
              runs={runs}
              loading={runsLoading}
              error={runsError}
              selectedRunId={showLiveSurface && !engine.hydrated ? null : selectedRunId}
              onSelect={(id) => {
                // An explicit history pick overrides any still-pending "show me
                // a blank compose screen" intent from a recent Run/New run click.
                awaitingFreshRunConfig = false;
                setSelectedRunId(id);
              }}
              onRefresh={() => void refreshRuns()}
              onDelete={(id) => void deleteRun(id)}
              onNewRun={startNewRunConfig}
              projectsById={projectsById}
            />
          </div>
        )}

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-8 pb-6 pt-8 [@media(max-height:800px)]:pb-3 [@media(max-height:800px)]:pt-4">
          <header className="flex items-end justify-between border-b border-border pb-5 [@media(max-height:800px)]:pb-2">
            <div>
              <h1 className="font-mono text-xl font-semibold tracking-tight">Runs</h1>
              <p className="mt-1 text-sm text-muted [@media(max-height:800px)]:hidden">
                Plan → approve → explore → generate → execute → triage → report.
              </p>
            </div>
            <Badge tone={PHASE_TONE[engine.phase]}>{PHASE_LABEL[engine.phase]}</Badge>
          </header>

          {/* Controls */}
          <Card className="mt-5 shrink-0 [@media(max-height:800px)]:mt-3">
            <CardHeader className="flex flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle>{configLocked ? 'Run configuration' : 'Start a run'}</CardTitle>
                {configLocked && <Badge tone="muted">Read-only</Badge>}
              </div>
              <div className="flex items-center gap-2">
                {formCollapsed && !configLocked && selectedProject && (
                  <span className="truncate font-mono text-xs text-muted">
                    {selectedProject.name} · {TESTING_SCOPES.find((s) => s.value === testingScope)?.label}
                  </span>
                )}
                {formCollapsed && configLocked && (
                  <span className="truncate font-mono text-xs text-muted">
                    {lockedProject?.name ?? detail?.run?.projectId} ·{' '}
                    {TESTING_SCOPES.find((s) => s.value === effectiveTestingScope)?.label}
                  </span>
                )}
              </div>
            </CardHeader>
            {!formCollapsed && (
              <CardContent>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div>
                    <Label className="mb-1.5 block">Project</Label>
                    <Select
                      value={configLocked ? (lockedProject?.id ?? '') : projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      // Stays editable only for a fresh, not-yet-started compose
                      // form — picking a different project here configures the
                      // NEXT run to start/queue, never one already underway.
                      disabled={configLocked || projectsLoading || runnable.length === 0}
                    >
                      {configLocked ? (
                        <option value={lockedProject?.id ?? ''}>
                          {lockedProject?.name ?? detail?.run?.projectId ?? 'Unknown project'}
                        </option>
                      ) : (
                        <>
                          {runnable.length === 0 && (
                            <option value="">No active projects — create one first</option>
                          )}
                          {runnable.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </>
                      )}
                    </Select>
                  </div>
                  <div>
                    <Label className="mb-1.5 block">Testing Scope</Label>
                    <Select
                      value={effectiveTestingScope}
                      onChange={(e) => setTestingScope(e.target.value as TestingScope)}
                      disabled={configLocked}
                    >
                      {TESTING_SCOPES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                    <p className="mt-1 text-[11px] text-muted">
                      {TESTING_SCOPES.find((s) => s.value === effectiveTestingScope)?.hint}
                    </p>
                  </div>
                  <div>
                    <Label className="mb-1.5 block">Suite Mode</Label>
                    <Select
                      value={effectiveSuiteMode}
                      onChange={(e) => setSuiteMode(e.target.value as SuiteMode)}
                      disabled={configLocked}
                    >
                      {SUITE_MODES.map((m) => (
                        <option key={m.value} value={m.value} disabled={m.value !== 'fresh' && !hasSuite}>
                          {m.label}
                        </option>
                      ))}
                    </Select>
                    <p className="mt-1 text-[11px] text-muted">
                      {SUITE_MODES.find((m) => m.value === effectiveSuiteMode)?.hint}
                    </p>
                    {!configLocked && suiteMode !== 'fresh' && lastSuccessfulRun && (
                      <p className="mt-1 truncate text-[11px] text-muted" title={lastSuccessfulRun.id}>
                        Base: run {lastSuccessfulRun.id} ({formatCreatedAt(lastSuccessfulRun.createdAt)})
                      </p>
                    )}
                  </div>
                  <div className="sm:col-span-3">
                    <Label className="mb-1.5 block">PRD / acceptance criteria (optional)</Label>
                    <div className="relative">
                      <Textarea
                        value={effectivePrd}
                        onChange={(e) => {
                          setPrd(e.target.value);
                          // The text no longer reflects the uploaded file verbatim.
                          setPrdFileName(null);
                          setPrdSourceKind('text');
                          setPrdSelectedSheets(null);
                          setPrdFileWarning(null);
                        }}
                        placeholder="Paste requirements to ground test generation…"
                        className={configLocked ? undefined : 'pr-9'}
                        // readOnly (not disabled) once locked: prevents edits while
                        // keeping the textarea scrollable — disabled:pointer-events-none
                        // blocks wheel-scrolling over the field entirely.
                        readOnly={configLocked}
                      />
                      {!configLocked && (
                        <button
                          type="button"
                          onClick={() => void uploadPrdFile()}
                          disabled={prdFileBusy}
                          aria-label="Upload a PRD file"
                          title="Upload a PRD file"
                          className={cn(
                            'absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md',
                            'text-muted transition-colors hover:bg-panel hover:text-fg',
                            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                            'disabled:pointer-events-none disabled:opacity-50',
                          )}
                        >
                          {prdFileBusy ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Plus className="h-4 w-4" />
                          )}
                        </button>
                      )}
                    </div>
                    {!configLocked && (
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted">
                        <span>
                          {prdFileName ? (
                            <>
                              Selected file: <span className="font-mono text-fg">{prdFileName}</span>
                              {prdSourceKind === 'spreadsheet' &&
                              prdSelectedSheets &&
                              prdSelectedSheets.length > 0
                                ? ` (sheets: ${prdSelectedSheets.join(', ')})`
                                : ''}
                            </>
                          ) : (
                            'No file selected — paste text above or upload a PRD.'
                          )}
                        </span>
                        <span className="shrink-0">
                          Accepted: .pdf, .doc, .docx, .md, .txt, .xlsx, .xls, .csv
                        </span>
                      </div>
                    )}
                    {configLocked && lockedPrdSource && (
                      <p className="mt-1 text-[11px] text-muted">{lockedPrdSource}</p>
                    )}
                    {prdFileError && <p className="mt-1 text-[11px] text-err">{prdFileError}</p>}
                    {!prdFileError && prdFileWarning && (
                      <p className="mt-1 text-[11px] text-warn">{prdFileWarning}</p>
                    )}
                  </div>
                  <div className="sm:col-span-3">
                    <Label className="mb-1.5 block">Additional instructions (optional)</Label>
                    <Textarea
                      value={effectiveInstructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      placeholder='Tell Healix how to test — e.g. "focus on accessibility", "prefer data-testid selectors", "skip mobile viewports"…'
                      readOnly={configLocked}
                    />
                    <p className="mt-1 text-[11px] text-muted">
                      Steers HOW the plan is built — the PRD above describes WHAT the app does; this is for
                      directives on how Healix should approach testing it.
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex min-w-0 items-center justify-between">
                  {configLocked ? (
                    <div className="min-w-0 text-xs text-muted">
                      <span
                        className="block truncate font-mono"
                        title={lockedProject?.baseUrl ?? lockedProject?.repoPath ?? undefined}
                      >
                        {lockedProject?.baseUrl ?? lockedProject?.repoPath ?? 'no target configured'}
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="min-w-0 text-xs text-muted">
                        {selectedProject ? (
                          <span
                            className="block truncate font-mono"
                            title={selectedProject.baseUrl ?? selectedProject.repoPath ?? undefined}
                          >
                            {selectedProject.baseUrl ?? selectedProject.repoPath ?? 'no target configured'}
                          </span>
                        ) : (
                          'Select a project to begin.'
                        )}
                      </div>
                      {/* Only ever "Start run" for a fresh, never-started compose
                        form, or "Queue run" when composing this run's config
                        while a DIFFERENT run is already executing — Cancel/
                        Pause/Resume live in their own bar below, scoped to
                        whichever run is actually active/pausable. */}
                      <div className="flex shrink-0 items-center gap-2">
                        <Button onClick={startOrQueue} disabled={!projectId}>
                          {isActive ? <ListPlus className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                          {isActive ? 'Queue run' : 'Start run'}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </CardContent>
            )}
          </Card>

          {queueError && (
            <div className="mt-4 flex shrink-0 items-start justify-between gap-2 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">
              <p>{queueError}</p>
              <button
                type="button"
                onClick={() => setQueueError(null)}
                aria-label="Dismiss"
                className="shrink-0 rounded p-0.5 text-err/70 hover:text-err"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {runDeleteError && (
            <div className="mt-4 flex shrink-0 items-start justify-between gap-2 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">
              <p>{runDeleteError}</p>
              <button
                type="button"
                onClick={() => setRunDeleteError(null)}
                aria-label="Dismiss"
                className="shrink-0 rounded p-0.5 text-err/70 hover:text-err"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <RunQueuePanel
            queue={queue.queue}
            projectsById={projectsById}
            onRemove={(id) => void queue.remove(id)}
            error={queue.error}
            onDismissError={queue.clearError}
          />

          {/* Collapse toggle: centered chevron on a divider. Collapsing "Start a
            run" down to just its header hands most of the column's height to
            the report/timeline section below. */}
          <div className="relative my-1 flex shrink-0 items-center">
            <div className="h-px flex-1 bg-border" />
            <button
              type="button"
              onClick={() => setFormCollapsed((v) => !v)}
              aria-label={formCollapsed ? 'Expand start-a-run panel' : 'Collapse start-a-run panel'}
              className="mx-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-panel text-muted transition-colors hover:border-muted/50 hover:text-fg"
            >
              {formCollapsed ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronUp className="h-3.5 w-3.5" />
              )}
            </button>
            <div className="h-px flex-1 bg-border" />
          </div>

          {/* Plan gate: only while parked or still streaming in, AND only for the
            run currently being shown — a rehydrated pending approval must not
            bleed into every other history row's view (see showLiveSurface).
            Mounted during 'plan-streaming' too so the reviewer can start
            approving/editing items as batches land, though the overall
            Approve/Reject actions stay locked (via `streaming`) until every
            batch has arrived. */}
          {showLiveSurface &&
            engine.workingPlan &&
            (engine.phase === 'awaiting-approval' || engine.phase === 'plan-streaming') && (
              <div className="mt-4 shrink-0">
                <PlanGate
                  plan={engine.workingPlan}
                  decided={engine.planDecided}
                  streaming={engine.phase === 'plan-streaming'}
                  batchProgress={engine.planBatchProgress}
                  revisingItemIds={engine.revisingItemIds}
                  reviseErrors={engine.reviseErrors}
                  onApproveItem={engine.approveItem}
                  onRejectItem={engine.rejectItem}
                  onEditItem={engine.editItem}
                  onReviseItem={(itemId, suggestion) => void engine.reviseItem(itemId, suggestion, projectId)}
                  onApproveAndContinue={() => void engine.approveAndContinue()}
                  onRejectAll={() => void engine.rejectAll()}
                />
              </div>
            )}

          {/* Scoped the same way as the plan gate: only for the run currently
            being shown, so an error from one run doesn't linger while
            browsing an unrelated one. Dismissable since some of these
            (e.g. an orphaned approve/cancel) aren't otherwise self-clearing. */}
          {showLiveSurface && engine.error && (
            <div className="mt-4 flex shrink-0 items-start justify-between gap-2 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">
              <p>{engine.error}</p>
              <button
                type="button"
                onClick={engine.clearError}
                aria-label="Dismiss"
                className="shrink-0 rounded p-0.5 text-err/70 hover:text-err"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Cancel/Pause/Resume bar: all three are actions performed on an
            active run, grouped together. Cancel is scoped to whatever the
            ENGINE is currently tracking (isActive || paused) regardless of
            what's currently selected/browsed — e.g. it stays available while
            composing a different run's config to queue behind it, or while
            glancing at an unrelated historical row. Pause/Resume stay scoped
            to whichever run is currently being VIEWED — live-tracked
            (running, or just paused and still selected) or a paused row
            picked from history. `detail` tracks selectedRunId regardless of
            which branch below is showing, so this covers both without
            duplicating anything in each branch. Exactly one of Pause/Resume
            is ever enabled: Pause while it's actually running, Resume while
            it's actually paused — never both at once. */}
          {(() => {
            const cancelAvailable = isActive || engine.phase === 'paused';
            const viewedIsActive = showLiveSurface && isActive;
            const viewedIsPaused = detail?.run?.id === selectedRunId && detail.run.status === 'paused';
            if (!cancelAvailable && !viewedIsActive && !viewedIsPaused) return null;
            return (
              <div
                className={cn(
                  'mt-4 flex shrink-0 items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm',
                  viewedIsPaused ? 'border-warn/40 bg-warn/10' : 'border-border bg-panel/40 text-muted',
                )}
              >
                <span>
                  {viewedIsPaused
                    ? `Paused (${detail?.run?.pauseReason ?? 'unknown'}) — resume to pick up right where it left off.`
                    : 'Pause to free this up for later — resumes from exactly where it left off, unlike Cancel.'}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  {/* Also offered while paused — cancelling a paused run is a
                    real, meaningful choice (give up on it entirely) distinct
                    from Resume (pick it back up); it uses the same
                    IPC path either way (run:cancel force-settles it even
                    with no live controller to abort). */}
                  {cancelAvailable && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-err/40 text-err hover:border-err/60 hover:bg-err/10"
                      onClick={cancel}
                      // No runId yet means there is nothing to abort (still 'starting').
                      // Also blocked while a pause is already in flight — the abort
                      // signal only carries ONE reason (AbortController.abort() is a
                      // no-op once already aborted), so racing both actions
                      // wouldn't reliably act as either a cancel or a pause.
                      disabled={cancelling || pausing || !engine.runId}
                    >
                      <Square className="h-4 w-4" />
                      {cancelling ? 'Cancelling…' : 'Cancel'}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={pause}
                    disabled={!viewedIsActive || pausing || cancelling || !engine.runId}
                  >
                    <Pause className="h-4 w-4" />
                    {pausing ? 'Pausing…' : 'Pause'}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => detail?.run && resumePausedRun(detail.run.id)}
                    disabled={!viewedIsPaused || resuming || isActive}
                    title={
                      viewedIsPaused && isActive
                        ? 'Another run is currently active — try again once it finishes.'
                        : undefined
                    }
                  >
                    <Play className="h-4 w-4" />
                    {resuming ? 'Resuming…' : 'Resume'}
                  </Button>
                </div>
              </div>
            );
          })()}

          {/* Live surface (active or just-started run) vs. historical detail */}
          {showLiveSurface ? (
            <div
              className={cn(
                'mt-4 grid min-h-0 flex-1 grid-cols-1 gap-4',
                showLiveBrowserPanel && 'lg:grid-cols-2',
              )}
            >
              <div className="flex min-h-0 flex-col">
                <Label className="mb-1.5 block">Console</Label>
                <div className="min-h-0 flex-1">
                  <ConsoleLog
                    lines={engine.lines}
                    emptyHint="Start a run to stream live orchestrator events here."
                  />
                </div>
              </div>
              {/* Skip the panel entirely (rather than show a permanently-empty
                placeholder) when there's no live URL, or the scope is API-only. */}
              {showLiveBrowserPanel && (
                <div className="min-h-0">
                  <LiveBrowser frame={frame} active={isActive} />
                </div>
              )}
            </div>
          ) : (
            <div className="mt-4 min-h-0 flex-1">
              <RunDetailPanel detail={detail} loading={detailLoading} onSelectRun={setSelectedRunId} />
            </div>
          )}
        </div>
      </div>
      {sheetPickerFile && (
        <SheetPickerDialog
          fileName={sheetPickerFile.fileName}
          sheets={sheetPickerFile.sheets}
          onConfirm={(names) => void confirmSheetSelection(names)}
          onCancel={() => setSheetPickerFile(null)}
        />
      )}
    </>
  );
}
