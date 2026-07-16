import { useState } from 'react';
import type { Project } from '@healix/core';
import { Sidebar, type ViewId } from './components/Sidebar';
import { ProjectsView } from './views/ProjectsView';
import { RunsView } from './views/RunsView';
import { ProjectDashboardView } from './views/ProjectDashboardView';
import { SettingsView } from './views/SettingsView';

export default function App() {
  const [view, setView] = useState<ViewId>('projects');
  const [runProjectId, setRunProjectId] = useState<string | null>(null);
  const [dashboardProject, setDashboardProject] = useState<Project | null>(null);

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
      <Sidebar active={view} onSelect={setView} />
      <main className="min-w-0 flex-1 overflow-hidden">
        {view === 'projects' && (
          <div className="h-full overflow-auto">
            <ProjectsView onRunProject={runProject} onOpenDashboard={openDashboard} />
          </div>
        )}
        {view === 'runs' && <RunsView initialProjectId={runProjectId} />}
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
