import { useEffect, useMemo, useState } from 'react';
import type { ExplorationMode } from '@healix/core';
import { Loader2, Play, RotateCcw } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge, type BadgeTone } from '../components/ui/badge';
import { Select } from '../components/ui/select';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { ConsoleLog } from '../components/ConsoleLog';
import { PlanGate } from '../components/PlanGate';
import { RunResults } from '../components/RunResults';
import { useProjects } from '../lib/use-projects';
import { EXPLORATION_MODES, useRunEngine, type RunPhase } from '../lib/run-engine';

const PHASE_TONE: Record<RunPhase, BadgeTone> = {
  idle: 'muted',
  starting: 'default',
  running: 'default',
  'awaiting-approval': 'warn',
  done: 'ok',
  error: 'err',
};

const PHASE_LABEL: Record<RunPhase, string> = {
  idle: 'idle',
  starting: 'starting…',
  running: 'running',
  'awaiting-approval': 'awaiting approval',
  done: 'done',
  error: 'error',
};

export function RunsView({ initialProjectId }: { initialProjectId?: string | null }) {
  const { projects, loading: projectsLoading } = useProjects();
  const engine = useRunEngine();

  const [projectId, setProjectId] = useState<string>('');
  const [mode, setMode] = useState<ExplorationMode>('codegen');
  const [prd, setPrd] = useState('');

  // Default the selection to the deep-linked project, else the first project.
  useEffect(() => {
    if (projectId) return;
    if (initialProjectId && projects.some((p) => p.id === initialProjectId)) {
      setProjectId(initialProjectId);
    } else if (projects.length > 0) {
      setProjectId(projects[0].id);
    }
  }, [initialProjectId, projects, projectId]);

  const isActive =
    engine.phase === 'starting' ||
    engine.phase === 'running' ||
    engine.phase === 'awaiting-approval';

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  const start = (): void => {
    if (!projectId || isActive) return;
    void engine.start({
      projectId,
      mode,
      prd: prd.trim() || undefined,
    });
  };

  return (
    <div className="flex h-full flex-col px-8 pb-6 pt-8">
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
                disabled={isActive || projectsLoading || projects.length === 0}
              >
                {projects.length === 0 && <option value="">No projects — create one first</option>}
                {projects.map((p) => (
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

          <div className="mt-4 flex items-center justify-between">
            <div className="text-xs text-muted">
              {selectedProject ? (
                <span className="font-mono">
                  {selectedProject.baseUrl ?? selectedProject.repoPath ?? 'no target configured'}
                </span>
              ) : (
                'Select a project to begin.'
              )}
            </div>
            <div className="flex items-center gap-2">
              {(engine.phase === 'done' || engine.phase === 'error') && (
                <Button variant="ghost" onClick={engine.reset}>
                  <RotateCcw className="h-4 w-4" />
                  New run
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

      {/* Final results */}
      {engine.summary && (engine.phase === 'done' || engine.phase === 'error') && (
        <div className="mt-4 shrink-0">
          <RunResults summary={engine.summary} />
        </div>
      )}

      {engine.error && (
        <p className="mt-4 shrink-0 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">
          {engine.error}
        </p>
      )}

      {/* Console */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <Label className="mb-1.5 block">Console</Label>
        <div className="min-h-0 flex-1">
          <ConsoleLog
            lines={engine.lines}
            emptyHint="Start a run to stream live orchestrator events here."
          />
        </div>
      </div>
    </div>
  );
}
