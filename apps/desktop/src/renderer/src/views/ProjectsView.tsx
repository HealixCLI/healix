import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Project } from '@healix/core';
import { FolderGit2, Globe, Plus, Trash2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { useProjects } from '../lib/use-projects';

export function ProjectsView({ onRunProject }: { onRunProject?: (project: Project) => void }) {
  const { projects, loading, error, create, remove } = useProjects();
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="mx-auto max-w-4xl px-8 pb-16 pt-8">
      <header className="flex items-end justify-between border-b border-border pb-5">
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted">Targets healix can plan, generate, and run suites against.</p>
        </div>
        <Button variant={showForm ? 'outline' : 'default'} onClick={() => setShowForm((v) => !v)}>
          <Plus className="h-4 w-4" />
          {showForm ? 'Close' : 'New project'}
        </Button>
      </header>

      {error && (
        <p className="mt-4 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error}</p>
      )}

      {showForm && <NewProjectForm onCreate={create} onDone={() => setShowForm(false)} />}

      <section className="mt-6 flex flex-col gap-3">
        {loading && <p className="text-sm text-muted">Loading projects…</p>}
        {!loading && projects.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted">
              No projects yet. Create one to start a run.
            </CardContent>
          </Card>
        )}
        {projects.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            onDelete={() => void remove(p.id)}
            onRun={onRunProject ? () => onRunProject(p) : undefined}
          />
        ))}
      </section>
    </div>
  );
}

function ProjectRow({
  project,
  onDelete,
  onRun,
}: {
  project: Project;
  onDelete: () => void;
  onRun?: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-fg">{project.name}</span>
            <Badge tone="muted">{project.mode}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {project.repoPath && (
              <span className="flex items-center gap-1 font-mono">
                <FolderGit2 className="h-3 w-3" />
                {project.repoPath}
              </span>
            )}
            {project.baseUrl && (
              <span className="flex items-center gap-1 font-mono">
                <Globe className="h-3 w-3" />
                {project.baseUrl}
              </span>
            )}
            {!project.repoPath && !project.baseUrl && <span>No repo or URL set</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onRun && (
            <Button size="sm" variant="outline" onClick={onRun}>
              Run
            </Button>
          )}
          <Button size="icon" variant="ghost" onClick={onDelete} aria-label="Delete project">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NewProjectForm({
  onCreate,
  onDone,
}: {
  onCreate: ReturnType<typeof useProjects>['create'];
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [mode, setMode] = useState<'playwright'>('playwright');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    const created = await onCreate({
      name: name.trim(),
      mode,
      repoPath: repoPath.trim() || null,
      baseUrl: baseUrl.trim() || null,
    });
    setSubmitting(false);
    if (created) {
      setName('');
      setRepoPath('');
      setBaseUrl('');
      onDone();
    }
  };

  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle>New project</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={submit}>
          <Field label="Name" className="sm:col-span-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme web app"
              autoFocus
              required
            />
          </Field>
          <Field label="Repo path (white-box)">
            <Input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/Users/me/code/acme"
              className="font-mono"
            />
          </Field>
          <Field label="Base URL (black-box)">
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://app.acme.test"
              className="font-mono"
            />
          </Field>
          <Field label="Mode">
            <Select value={mode} onChange={(e) => setMode(e.target.value as 'playwright')}>
              <option value="playwright">playwright</option>
            </Select>
          </Field>
          <div className="flex items-end justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || submitting}>
              {submitting ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block">{label}</Label>
      {children}
    </div>
  );
}
