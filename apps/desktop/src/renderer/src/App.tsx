import { useState } from 'react';
import type { Project } from '@healix/core';
import { Sidebar, type ViewId } from './components/Sidebar';
import { ProvidersView } from './views/ProvidersView';
import { ProjectsView } from './views/ProjectsView';
import { RunsView } from './views/RunsView';

export default function App() {
  const [view, setView] = useState<ViewId>('providers');
  const [runProjectId, setRunProjectId] = useState<string | null>(null);

  // 'Run' from the Projects list deep-links into the Runs view, pre-selected.
  const runProject = (project: Project): void => {
    setRunProjectId(project.id);
    setView('runs');
  };

  return (
    <div className="flex h-full min-h-full bg-bg text-fg">
      <Sidebar active={view} onSelect={setView} />
      <main className="min-w-0 flex-1 overflow-hidden">
        {view === 'providers' && (
          <div className="h-full overflow-auto">
            <ProvidersView />
          </div>
        )}
        {view === 'projects' && (
          <div className="h-full overflow-auto">
            <ProjectsView onRunProject={runProject} />
          </div>
        )}
        {view === 'runs' && <RunsView initialProjectId={runProjectId} />}
      </main>
    </div>
  );
}
