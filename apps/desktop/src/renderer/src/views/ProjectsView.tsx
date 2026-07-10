import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Project } from '@healix/core';
import { Archive, ArchiveRestore, FolderGit2, Globe, Plus, Trash2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { useProjects } from '../lib/use-projects';

export function ProjectsView({ onRunProject }: { onRunProject?: (project: Project) => void }) {
  const { projects, loading, error, create, remove, archive } = useProjects();
  const [showForm, setShowForm] = useState(false);

  const active = useMemo(() => projects.filter((p) => !p.archivedAt), [projects]);
  const archived = useMemo(() => projects.filter((p) => p.archivedAt), [projects]);

  return (
    <div className="mx-auto max-w-4xl px-8 pb-16 pt-8">
      <header className="flex items-end justify-between border-b border-border pb-5">
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted">
            Targets healix can plan, generate, and run suites against.
          </p>
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
        {active.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            onDelete={() => void remove(p.id)}
            onArchive={() => void archive(p.id, true)}
            onRun={onRunProject ? () => onRunProject(p) : undefined}
          />
        ))}
      </section>

      {archived.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted">
            <Archive className="h-3.5 w-3.5" />
            Archived
            <span className="font-normal">· {archived.length}</span>
          </h2>
          <div className="flex flex-col gap-3">
            {archived.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                onDelete={() => void remove(p.id)}
                onUnarchive={() => void archive(p.id, false)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ProjectRow({
  project,
  onDelete,
  onArchive,
  onUnarchive,
  onRun,
}: {
  project: Project;
  onDelete: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onRun?: () => void;
}) {
  const isArchived = Boolean(project.archivedAt);
  return (
    <Card className={isArchived ? 'opacity-70' : undefined}>
      <CardContent className="flex items-center justify-between gap-4 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-fg">{project.name}</span>
            <Badge tone="muted">{project.mode}</Badge>
            {isArchived && <Badge tone="muted">archived</Badge>}
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
          {onArchive && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onArchive}
              aria-label="Archive project"
              title="Archive (keeps all runs and media)"
            >
              <Archive className="h-4 w-4" />
            </Button>
          )}
          {onUnarchive && (
            <Button size="sm" variant="ghost" onClick={onUnarchive}>
              <ArchiveRestore className="h-4 w-4" />
              Restore
            </Button>
          )}
          <DeleteButton onDelete={onDelete} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Two-step destructive delete: the first click arms the button (auto-disarms
 * after a few seconds), the second click permanently removes the project, its
 * runs, and every on-disk asset (suites, screenshots, recordings).
 */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed) {
    return (
      <Button
        size="icon"
        variant="ghost"
        onClick={() => setArmed(true)}
        aria-label="Delete project"
        title="Delete project (asks to confirm)"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      className="border-err/50 text-err hover:border-err hover:bg-err/10"
      onClick={onDelete}
      title="Permanently removes the project, all runs, and all media"
    >
      <Trash2 className="h-3.5 w-3.5" />
      Delete runs & media?
    </Button>
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

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block">{label}</Label>
      {children}
    </div>
  );
}
