import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExplorationMode, Project, SuiteMode, TestingScope } from '@healix/core';
import { ChevronDown, ChevronUp, Loader2, Play, Plus, RotateCcw, Square, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge, type BadgeTone } from '../components/ui/badge';
import { Select } from '../components/ui/select';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { ConsoleLog } from '../components/ConsoleLog';
import { PlanGate } from '../components/PlanGate';
import { LiveBrowser } from '../components/LiveBrowser';
import { RunHistory } from '../components/RunHistory';
import { RunDetailPanel } from '../components/RunDetailPanel';
import { useProjects } from '../lib/use-projects';
import { useRuns } from '../lib/use-runs';
import { useRunDetail } from '../lib/use-run-detail';
import { useLastSuccessfulRun } from '../lib/use-last-successful-run';
import { useLiveFrame } from '../lib/use-live-frame';
import { cn } from '../lib/utils';
import { formatCreatedAt } from '../lib/run-format';
import { SUITE_MODES, TESTING_SCOPES, useRunEngine, type RunPhase } from '../lib/run-engine';

const PHASE_TONE: Record<RunPhase, BadgeTone> = {
  idle: 'muted',
  starting: 'default',
  running: 'default',
  'awaiting-approval': 'warn',
  done: 'ok',
  cancelled: 'muted',
  error: 'err',
};

const PHASE_LABEL: Record<RunPhase, string> = {
  idle: 'idle',
  starting: 'starting…',
  running: 'running',
  'awaiting-approval': 'awaiting approval',
  done: 'done',
  cancelled: 'cancelled',
  error: 'error',
};

/** Engine phases in which the run has settled and a new one can be started. */
const SETTLED_PHASES: ReadonlyArray<RunPhase> = ['done', 'cancelled', 'error'];

// App.tsx conditionally unmounts RunsView when the user switches to another
// page, which would otherwise reset these on every navigation. Plain module
// state survives that remount and resets only on the next app launch — same
// lifetime historyCollapsed already documented for itself, just actually
// honored across navigation instead of only within a single mount.
let persistedSelectedRunId: string | null | undefined;

export function RunsView({ initialProjectId }: { initialProjectId?: string | null }) {
  const { projects, loading: projectsLoading } = useProjects();
  const engine = useRunEngine();
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
  const [selectedRunId, setSelectedRunIdState] = useState<string | null>(
    () => persistedSelectedRunId ?? null,
  );
  const setSelectedRunId = (id: string | null): void => {
    persistedSelectedRunId = id;
    setSelectedRunIdState(id);
  };
  // True from the moment the user clicks Cancel until run:done settles the run.
  const [cancelling, setCancelling] = useState(false);
  // Session-only: resets to expanded on next launch.
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
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
    engine.phase === 'starting' || engine.phase === 'running' || engine.phase === 'awaiting-approval';

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
    // useRunDetail keeps the PREVIOUS run's detail on screen until its own
    // fetch for the new selectedRunId resolves — without this check, clicking
    // a different history row could momentarily hydrate the engine with the
    // prior row's stale plan/status before the real detail ever arrives.
    if (!detail?.plan || detail.run?.id !== selectedRunId || detail.run.status !== 'awaiting-approval') {
      return;
    }
    hydrate({ runId: selectedRunId, plan: detail.plan });
    setProjectId(detail.run.projectId);
  }, [selectedRunId, detail, engine.runId, hydrate]);

  // Clear the "Cancelling…" state once the run settles (run:done) or resets.
  useEffect(() => {
    if (!isActive) setCancelling(false);
  }, [isActive]);

  // When a run finishes, refresh history and select the freshly-completed run.
  // Also reload its detail bundle directly: setSelectedRunId(settledId) is a
  // no-op re-render when it's already the current selection (e.g. rejecting/
  // cancelling a run you were already viewing), so useRunDetail would
  // otherwise never refetch and its status badge would stay stuck on
  // whatever it read before the just-persisted change.
  const lastSettledRef = useRef<string | null>(null);
  useEffect(() => {
    if (SETTLED_PHASES.includes(engine.phase) && engine.runId) {
      if (lastSettledRef.current === engine.runId) return;
      lastSettledRef.current = engine.runId;
      const settledId = engine.runId;
      void refreshRuns().then(() => {
        setSelectedRunId(settledId);
        void reloadDetail();
      });
    }
    if (engine.phase === 'idle' || engine.phase === 'starting') {
      lastSettledRef.current = null;
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

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );
  // The panel is relevant whenever the project has a live URL to mirror and
  // the selected scope actually exercises the browser — not tied to
  // repoPath/exploration mode, since a codegen project with a baseUrl still
  // drives a real browser during EXPLORE and EXECUTE.
  const showLiveBrowserPanel = !!selectedProject?.baseUrl && testingScope !== 'backend';

  const start = (): void => {
    if (!projectId || isActive) return;
    // Showing live run UI rather than a historical detail.
    setSelectedRunId(null);
    void engine.start({
      projectId,
      testingScope,
      suiteMode,
      prd: prd.trim() || undefined,
    });
  };

  const cancel = (): void => {
    if (cancelling || !engine.runId) return;
    setCancelling(true);
    // The engine phase stays as-is until the authoritative run:done arrives
    // with status 'cancelled' (SETTLED_PHASES then refreshes the history).
    void engine.cancel();
  };

  const newRun = (): void => {
    engine.reset();
    setSelectedRunId(null);
  };

  const uploadPrdFile = async (): Promise<void> => {
    setPrdFileError(null);
    setPrdFileBusy(true);
    try {
      const result = await window.healix.pickPrdFile();
      if (result.canceled) return;
      if (result.error) {
        setPrdFileError(result.error);
        return;
      }
      setPrd(result.text ?? '');
      setPrdFileName(result.fileName ?? null);
    } catch (err) {
      setPrdFileError(err instanceof Error ? err.message : String(err));
    } finally {
      setPrdFileBusy(false);
    }
  };

  // The live run surface takes precedence over a selected history detail — EXCEPT
  // for a rehydrated (not-actually-live-this-session) pending approval, which is
  // just one browsable history row: it only takes over while its OWN row is the
  // one selected, so other rows stay freely inspectable while it sits pending.
  const showLiveSurface = engine.hydrated
    ? selectedRunId === engine.runId
    : isActive || (engine.runId != null && selectedRunId == null);

  return (
    <div className="flex h-full min-h-0">
      {/* History rail */}
      <div
        className={cn(
          'flex shrink-0 flex-col border-r border-border pb-6 pt-8',
          historyCollapsed ? 'w-12 items-center px-1' : 'w-64 px-4',
        )}
      >
        <RunHistory
          runs={runs}
          loading={runsLoading}
          error={runsError}
          selectedRunId={showLiveSurface && !engine.hydrated ? null : selectedRunId}
          onSelect={(id) => {
            setSelectedRunId(id);
          }}
          onRefresh={() => void refreshRuns()}
          projectsById={projectsById}
          collapsed={historyCollapsed}
          onToggleCollapse={() => setHistoryCollapsed((v) => !v)}
        />
      </div>

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
            <CardTitle>Start a run</CardTitle>
            {formCollapsed && selectedProject && (
              <span className="truncate font-mono text-xs text-muted">
                {selectedProject.name} · {TESTING_SCOPES.find((s) => s.value === testingScope)?.label}
              </span>
            )}
          </CardHeader>
          {!formCollapsed && (
            <CardContent>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <Label className="mb-1.5 block">Project</Label>
                  <Select
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    disabled={isActive || projectsLoading || runnable.length === 0}
                  >
                    {runnable.length === 0 && <option value="">No active projects — create one first</option>}
                    {runnable.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label className="mb-1.5 block">Testing Scope</Label>
                  <Select
                    value={testingScope}
                    onChange={(e) => setTestingScope(e.target.value as TestingScope)}
                    disabled={isActive}
                  >
                    {TESTING_SCOPES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-[11px] text-muted">
                    {TESTING_SCOPES.find((s) => s.value === testingScope)?.hint}
                  </p>
                </div>
                <div>
                  <Label className="mb-1.5 block">Suite Mode</Label>
                  <Select
                    value={suiteMode}
                    onChange={(e) => setSuiteMode(e.target.value as SuiteMode)}
                    disabled={isActive}
                  >
                    {SUITE_MODES.map((m) => (
                      <option key={m.value} value={m.value} disabled={m.value !== 'fresh' && !hasSuite}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-[11px] text-muted">
                    {SUITE_MODES.find((m) => m.value === suiteMode)?.hint}
                  </p>
                  {suiteMode !== 'fresh' && lastSuccessfulRun && (
                    <p className="mt-1 truncate text-[11px] text-muted" title={lastSuccessfulRun.id}>
                      Base: run {lastSuccessfulRun.id} ({formatCreatedAt(lastSuccessfulRun.createdAt)})
                    </p>
                  )}
                </div>
                <div className="sm:col-span-3">
                  <Label className="mb-1.5 block">PRD / acceptance criteria (optional)</Label>
                  <div className="relative">
                    <Textarea
                      value={prd}
                      onChange={(e) => {
                        setPrd(e.target.value);
                        // The text no longer reflects the uploaded file verbatim.
                        setPrdFileName(null);
                      }}
                      placeholder="Paste requirements to ground test generation…"
                      disabled={isActive}
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => void uploadPrdFile()}
                      disabled={isActive || prdFileBusy}
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
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted">
                    <span>
                      {prdFileName ? (
                        <>
                          Selected file: <span className="font-mono text-fg">{prdFileName}</span>
                        </>
                      ) : (
                        'No file selected — paste text above or upload a PRD.'
                      )}
                    </span>
                    <span className="shrink-0">Accepted: .pdf, .doc, .docx, .md, .txt</span>
                  </div>
                  {prdFileError && <p className="mt-1 text-[11px] text-err">{prdFileError}</p>}
                </div>
              </div>

              <div className="mt-4 flex min-w-0 items-center justify-between">
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
                <div className="flex shrink-0 items-center gap-2">
                  {SETTLED_PHASES.includes(engine.phase) && (
                    <Button variant="ghost" onClick={newRun}>
                      <RotateCcw className="h-4 w-4" />
                      New run
                    </Button>
                  )}
                  {isActive && (
                    <Button
                      variant="outline"
                      className="border-err/40 text-err hover:border-err/60 hover:bg-err/10"
                      onClick={cancel}
                      // No runId yet means there is nothing to abort (still 'starting').
                      disabled={cancelling || !engine.runId}
                    >
                      <Square className="h-4 w-4" />
                      {cancelling ? 'Cancelling…' : 'Cancel'}
                    </Button>
                  )}
                  <Button onClick={start} disabled={!projectId || isActive}>
                    {isActive ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {isActive ? 'Running…' : 'Start run'}
                  </Button>
                </div>
              </div>
            </CardContent>
          )}
        </Card>

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
            {formCollapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
          <div className="h-px flex-1 bg-border" />
        </div>

        {/* Plan gate: only while parked, AND only for the run currently being
            shown — a rehydrated pending approval must not bleed into every
            other history row's view (see showLiveSurface). */}
        {showLiveSurface && engine.workingPlan && engine.phase === 'awaiting-approval' && (
          <div className="mt-4 shrink-0">
            <PlanGate
              plan={engine.workingPlan}
              decided={engine.planDecided}
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
  );
}
