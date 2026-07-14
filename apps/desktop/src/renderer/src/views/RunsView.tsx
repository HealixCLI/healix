import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExplorationMode, Project } from '@healix/core';
import { Loader2, Play, RotateCcw, Square } from 'lucide-react';
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
import { useLiveFrame } from '../lib/use-live-frame';
import { cn } from '../lib/utils';
import { EXPLORATION_MODES, useRunEngine, type RunPhase } from '../lib/run-engine';

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

export function RunsView({ initialProjectId }: { initialProjectId?: string | null }) {
  const { projects, loading: projectsLoading } = useProjects();
  const engine = useRunEngine();
  // History spans all projects so the user can review past runs across targets.
  const { runs, loading: runsLoading, error: runsError, refresh: refreshRuns } = useRuns();

  const [projectId, setProjectId] = useState<string>('');
  const [mode, setMode] = useState<ExplorationMode>('codegen');
  const [prd, setPrd] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // True from the moment the user clicks Cancel until run:done settles the run.
  const [cancelling, setCancelling] = useState(false);
  // Session-only: resets to expanded on next launch.
  const [historyCollapsed, setHistoryCollapsed] = useState(false);

  const { detail, loading: detailLoading } = useRunDetail(selectedRunId);
  const { frame } = useLiveFrame(engine.runId);

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
    if (initialProjectId && runnable.some((p) => p.id === initialProjectId)) {
      setProjectId(initialProjectId);
    } else if (runnable.length > 0) {
      setProjectId(runnable[0].id);
    }
  }, [initialProjectId, runnable, projectId]);

  const isActive =
    engine.phase === 'starting' || engine.phase === 'running' || engine.phase === 'awaiting-approval';

  // Clear the "Cancelling…" state once the run settles (run:done) or resets.
  useEffect(() => {
    if (!isActive) setCancelling(false);
  }, [isActive]);

  // When a run finishes, refresh history and select the freshly-completed run.
  const lastSettledRef = useRef<string | null>(null);
  useEffect(() => {
    if (SETTLED_PHASES.includes(engine.phase) && engine.runId) {
      if (lastSettledRef.current === engine.runId) return;
      lastSettledRef.current = engine.runId;
      const settledId = engine.runId;
      void refreshRuns().then(() => setSelectedRunId(settledId));
    }
    if (engine.phase === 'idle' || engine.phase === 'starting') {
      lastSettledRef.current = null;
    }
  }, [engine.phase, engine.runId, refreshRuns]);

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

  const start = (): void => {
    if (!projectId || isActive) return;
    // Showing live run UI rather than a historical detail.
    setSelectedRunId(null);
    void engine.start({
      projectId,
      mode,
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

  // The live run surface takes precedence; otherwise show the selected history detail.
  const showLiveSurface = isActive || (engine.runId != null && selectedRunId == null);

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
          selectedRunId={showLiveSurface ? null : selectedRunId}
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
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-8 pb-6 pt-8">
        <header className="flex items-end justify-between border-b border-border pb-5">
          <div>
            <h1 className="font-mono text-xl font-semibold tracking-tight">Runs</h1>
            <p className="mt-1 text-sm text-muted">
              Plan → approve → explore → generate → execute → triage → report.
            </p>
          </div>
          <Badge tone={PHASE_TONE[engine.phase]}>{PHASE_LABEL[engine.phase]}</Badge>
        </header>

        {/* Controls */}
        <Card className="mt-5 shrink-0">
          <CardHeader>
            <CardTitle>Start a run</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                <Label className="mb-1.5 block">Mode</Label>
                <Select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as ExplorationMode)}
                  disabled={isActive}
                >
                  {EXPLORATION_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-[11px] text-muted">
                  {EXPLORATION_MODES.find((m) => m.value === mode)?.hint}
                </p>
              </div>
              <div className="sm:col-span-2">
                <Label className="mb-1.5 block">PRD / acceptance criteria (optional)</Label>
                <Textarea
                  value={prd}
                  onChange={(e) => setPrd(e.target.value)}
                  placeholder="Paste requirements to ground test generation…"
                  disabled={isActive}
                />
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
        </Card>

        {/* Plan gate (only while parked) */}
        {engine.plan && engine.phase === 'awaiting-approval' && (
          <div className="mt-4 shrink-0">
            <PlanGate
              plan={engine.plan}
              decided={engine.planDecided}
              onApprove={() => void engine.approve(true)}
              onReject={() => void engine.approve(false)}
            />
          </div>
        )}

        {engine.error && (
          <p className="mt-4 shrink-0 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">
            {engine.error}
          </p>
        )}

        {/* Live surface (active or just-started run) vs. historical detail */}
        {showLiveSurface ? (
          <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex min-h-0 flex-col">
              <Label className="mb-1.5 block">Console</Label>
              <div className="min-h-0 flex-1">
                <ConsoleLog
                  lines={engine.lines}
                  emptyHint="Start a run to stream live orchestrator events here."
                />
              </div>
            </div>
            <div className="min-h-0">
              <LiveBrowser frame={frame} active={isActive} mode={mode} />
            </div>
          </div>
        ) : (
          <div className="mt-4 min-h-0 flex-1">
            <RunDetailPanel detail={detail} loading={detailLoading} />
          </div>
        )}
      </div>
    </div>
  );
}
