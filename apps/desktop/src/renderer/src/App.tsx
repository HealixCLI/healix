import { useMemo, useState } from 'react';
import type { Project } from '@healix/core';
import { Sidebar, type RunStatusBadge, type ViewId } from './components/Sidebar';
import { ProjectsView } from './views/ProjectsView';
import { RunsView } from './views/RunsView';
import { ProjectDashboardView } from './views/ProjectDashboardView';
import { SettingsView } from './views/SettingsView';
import { useRunEngine } from './lib/run-engine';
import { useRunQueue } from './lib/run-queue';

/** Live indicator for the Runs nav item, derived from the run engine + queue — visible from any view. */
function runStatusBadgeFor(phase: string, queueLength: number): RunStatusBadge | null {
  if (phase === 'awaiting-approval') return { label: 'needs approval', tone: 'warn' };
  if (phase === 'starting' || phase === 'running') return { label: 'live', tone: 'live' };
  if (queueLength > 0) return { label: `${queueLength} queued`, tone: 'live' };
  return null;
}

export default function App() {
  const [view, setView] = useState<ViewId>('projects');
  const [runProjectId, setRunProjectId] = useState<string | null>(null);
  const [dashboardProject, setDashboardProject] = useState<Project | null>(null);

  // Lifted above the per-view conditional rendering below (App itself never
  // unmounts) so the active run's live console/plan-gate/queue state survives
  // navigating to any other view instead of resetting on every remount.
  const engine = useRunEngine();
  const queue = useRunQueue();
  const runStatus = useMemo(
    () => runStatusBadgeFor(engine.phase, queue.queue.length),
    [engine.phase, queue.queue.length],
  );

  // 'Run' from the Projects list deep-links into the Runs view, pre-selected.
  const runProject = (project: Project): void => {
    setRunProjectId(project.id);
    setView('runs');
  };

  // Opening a project's dashboard deep-links from the Projects list, mirroring runProject.
  const openDashboard = (project: Project): void => {
    setDashboardProject(project);
    setView('project-dashboard');
  };

  return (
    <div className="flex h-full min-h-full bg-bg text-fg">
      <Sidebar active={view} onSelect={setView} runStatus={runStatus} />
      <main className="min-w-0 flex-1 overflow-hidden">
        {view === 'projects' && (
          <div className="h-full overflow-auto">
            <ProjectsView onRunProject={runProject} onOpenDashboard={openDashboard} />
          </div>
        )}
        {view === 'runs' && <RunsView initialProjectId={runProjectId} engine={engine} queue={queue} />}
        {view === 'project-dashboard' && dashboardProject && (
          <ProjectDashboardView
            project={dashboardProject}
            onBack={() => setView('projects')}
            onRunProject={runProject}
          />
        )}
        {view === 'settings' && (
          <div className="h-full overflow-auto">
            <SettingsView />
          </div>
        )}
      </main>
    </div>
  );
}
