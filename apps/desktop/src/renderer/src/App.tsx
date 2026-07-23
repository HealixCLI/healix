import { useMemo, useState } from 'react';
import type { Project } from '@healix/core';
import { Sidebar, type RunStatusBadge, type ViewId } from './components/Sidebar';
import { ProjectsView } from './views/ProjectsView';
import { RunsView } from './views/RunsView';
import { ProjectDashboardView } from './views/ProjectDashboardView';
import { ReportsUsageView } from './views/ReportsUsageView';
import { SettingsView } from './views/SettingsView';
import { useRunEngine } from './lib/run-engine';
import { useRunQueue } from './lib/run-queue';
import { SHOW_TOKEN_USAGE } from './lib/feature-flags';

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
  // Bumped on every "Run" click from the Projects list, even re-clicking the
  // same project — RunsView can't tell that apart from just re-rendering with
  // the same initialProjectId, so this is a distinct signal (not the id
  // itself) telling it to drop any selected historical run and show the
  // compose form, exactly like clicking "New run" would.
  const [runRequestSeq, setRunRequestSeq] = useState(0);
  const [dashboardProject, setDashboardProject] = useState<Project | null>(null);
  // Whether the active view's secondary panel (project explorer / run history)
  // is hidden — toggled by clicking the activity bar's already-active icon
  // again, VSCode-style. Switching to a different icon always re-expands it.
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  const selectView = (id: ViewId): void => {
    if (id === view) {
      setPanelCollapsed((v) => !v);
      return;
    }
    setView(id);
    setPanelCollapsed(false);
  };

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
    setRunRequestSeq((s) => s + 1);
    setView('runs');
    setPanelCollapsed(false);
  };

  // Opening a project's dashboard deep-links from the Projects list, mirroring runProject.
  const openDashboard = (project: Project): void => {
    setDashboardProject(project);
    setView('project-dashboard');
    setPanelCollapsed(false);
  };

  return (
    <div className="flex h-full min-h-full bg-bg text-fg">
      <Sidebar active={view} onSelect={selectView} runStatus={runStatus} />
      <main className="min-w-0 flex-1 overflow-hidden">
        {view === 'projects' && (
          <div className="h-full overflow-auto">
            <ProjectsView
              onRunProject={runProject}
              onOpenDashboard={openDashboard}
              sidebarCollapsed={panelCollapsed}
            />
          </div>
        )}
        {view === 'runs' && (
          <RunsView
            initialProjectId={runProjectId}
            runRequestSeq={runRequestSeq}
            engine={engine}
            queue={queue}
            sidebarCollapsed={panelCollapsed}
          />
        )}
        {view === 'project-dashboard' && dashboardProject && (
          <ProjectDashboardView
            project={dashboardProject}
            onBack={() => setView('projects')}
            onRunProject={runProject}
          />
        )}
        {view === 'reports' && SHOW_TOKEN_USAGE && (
          <div className="h-full overflow-auto">
            <ReportsUsageView />
          </div>
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
