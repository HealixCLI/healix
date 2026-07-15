import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { NewProject, Project } from '@healix/core';
import { Archive, ArchiveRestore, FolderGit2, Globe, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { useProjects } from '../lib/use-projects';

/**
 * Which form (if any) is currently shown: closed, creating a new project,
 * editing an existing one, or viewing an existing one read-only.
 */
type FormState =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; project: Project }
  | { kind: 'view'; project: Project };

export function ProjectsView({ onRunProject }: { onRunProject?: (project: Project) => void }) {
  const { projects, loading, error, create, update, remove, archive } = useProjects();
  const [formState, setFormState] = useState<FormState>({ kind: 'closed' });

  const active = useMemo(() => projects.filter((p) => !p.archivedAt), [projects]);
  const archived = useMemo(() => projects.filter((p) => p.archivedAt), [projects]);

  const closeForm = () => setFormState({ kind: 'closed' });
  const toggleCreate = () =>
    setFormState((s) => (s.kind === 'create' ? { kind: 'closed' } : { kind: 'create' }));

  return (
    <div className="mx-auto max-w-4xl px-8 pb-16 pt-8">
      <header className="flex items-end justify-between border-b border-border pb-5">
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted">
            Targets healix can plan, generate, and run suites against.
          </p>
        </div>
        <Button variant={formState.kind === 'create' ? 'outline' : 'default'} onClick={toggleCreate}>
          <Plus className="h-4 w-4" />
          {formState.kind === 'create' ? 'Close' : 'New project'}
        </Button>
      </header>

      {error && (
        <p className="mt-4 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error}</p>
      )}

      {formState.kind === 'create' && <ProjectForm onSubmit={create} onDone={closeForm} />}
      {formState.kind === 'edit' && (
        <ProjectForm
          project={formState.project}
          onSubmit={(input) => update(formState.project.id, input)}
          onDone={closeForm}
        />
      )}
      {formState.kind === 'view' && (
        <ProjectForm
          project={formState.project}
          readOnly
          onEdit={() => setFormState({ kind: 'edit', project: formState.project })}
          onDone={closeForm}
        />
      )}

      <section className="mt-6 flex flex-col gap-2">
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
            onView={() => setFormState({ kind: 'view', project: p })}
            onEdit={() => setFormState({ kind: 'edit', project: p })}
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
          <div className="flex flex-col gap-2">
            {archived.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                onView={() => setFormState({ kind: 'view', project: p })}
                onEdit={() => setFormState({ kind: 'edit', project: p })}
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

/** Shorten a long absolute path to its trailing segments (…/a/b) for compact display. */
function shortenPath(p: string, segments = 2): string {
  const parts = p
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter(Boolean);
  if (parts.length <= segments) return p;
  return `…/${parts.slice(-segments).join('/')}`;
}

function ProjectRow({
  project,
  onView,
  onEdit,
  onDelete,
  onArchive,
  onUnarchive,
  onRun,
}: {
  project: Project;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onRun?: () => void;
}) {
  const isArchived = Boolean(project.archivedAt);
  return (
    <Card className={isArchived ? 'opacity-70' : undefined}>
      <CardContent className="flex items-center justify-between gap-3 px-4 py-2.5">
        <button
          type="button"
          onClick={onView}
          className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          title="View project details"
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-fg hover:underline">{project.name}</span>
            <Badge tone="muted">{project.mode}</Badge>
            {isArchived && <Badge tone="muted">archived</Badge>}
          </div>
          {/* One-line target: trailing path segments (full path on hover) keep the row sleek. */}
          <div className="mt-0.5 flex min-w-0 items-center gap-3 text-xs text-muted">
            {project.repoPath && (
              <span className="flex min-w-0 items-center gap-1 font-mono" title={project.repoPath}>
                <FolderGit2 className="h-3 w-3 shrink-0" />
                <span className="truncate">{shortenPath(project.repoPath)}</span>
              </span>
            )}
            {project.baseUrl && (
              <span className="flex min-w-0 items-center gap-1 font-mono" title={project.baseUrl}>
                <Globe className="h-3 w-3 shrink-0" />
                <span className="truncate">{project.baseUrl}</span>
              </span>
            )}
            {!project.repoPath && !project.baseUrl && <span>No repo or URL set</span>}
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {onRun && (
            <Button size="sm" variant="outline" onClick={onRun}>
              Run
            </Button>
          )}
          <Button size="icon" variant="ghost" onClick={onEdit} aria-label="Edit project" title="Edit project">
            <Pencil className="h-4 w-4" />
          </Button>
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
          <DeleteButton projectName={project.name} onDelete={onDelete} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Delete requires an explicit confirmation in a modal dialog before anything
 * is removed — the click that opens the dialog never itself deletes.
 */
function DeleteButton({ projectName, onDelete }: { projectName: string; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => setConfirming(true)}
        aria-label="Delete project"
        title="Delete project"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      {confirming && (
        <ConfirmDialog
          title={`Delete "${projectName}"?`}
          description="This permanently removes the project along with all of its runs, generated suites, screenshots, and recordings. This cannot be undone."
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            setConfirming(false);
            onDelete();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/**
 * Mirror of core `isValidBaseUrl` (packages/core/src/storage/validate.ts).
 * Duplicated because the renderer runs in a browser context and cannot import
 * @healix/core (its barrel pulls in node:sqlite). Core remains the hard guard;
 * this is purely for inline feedback. Keep the two in sync.
 */
function isValidBaseUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Mirror of core `isGitRemoteUrl` (packages/core/src/target/clone.ts). Duplicated
 * for the same reason as isValidBaseUrl above — purely for an inline "will be
 * cloned" hint; the main process is what actually clones and is the hard guard.
 */
function isGitRemoteUrl(raw: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(raw.trim());
}

/**
 * Shared create/edit/view form. In create mode `project` is omitted and fields
 * start blank; in edit mode `project` seeds every field with its current value,
 * all still freely editable, and submitting calls the same onSubmit with the
 * full (possibly unchanged) NewProject shape — the caller decides whether that
 * means create() or update(project.id, ...). In `readOnly` mode (always paired
 * with a `project`) every field is shown but disabled, there is no submit —
 * just an Edit button (if `onEdit` is given) and a Close button — so it's
 * purely a details view with a way to switch into editing the same project.
 */
function ProjectForm({
  project,
  onSubmit,
  onEdit,
  onDone,
  readOnly = false,
}: {
  project?: Project;
  onSubmit?: (input: NewProject) => Promise<Project | null>;
  onEdit?: () => void;
  onDone: () => void;
  readOnly?: boolean;
}) {
  const isEdit = project !== undefined && !readOnly;
  const [name, setName] = useState(project?.name ?? '');
  const [repoPath, setRepoPath] = useState(project?.repoPath ?? '');
  const [baseUrl, setBaseUrl] = useState(project?.baseUrl ?? '');
  const [mode, setMode] = useState<'playwright'>((project?.mode as 'playwright') ?? 'playwright');
  const [testUsername, setTestUsername] = useState(project?.testUsername ?? '');
  const [testPassword, setTestPassword] = useState(project?.testPassword ?? '');
  const [submitting, setSubmitting] = useState(false);

  // Same rules as core validateNewProject: a project needs a name, at least one
  // of repo/URL, and a well-formed http(s) URL when a base URL is provided.
  const trimmedName = name.trim();
  const hasTarget = repoPath.trim().length > 0 || baseUrl.trim().length > 0;
  const baseUrlInvalid = baseUrl.trim().length > 0 && !isValidBaseUrl(baseUrl);
  const canSubmit = trimmedName.length > 0 && hasTarget && !baseUrlInvalid && !submitting;
  const repoIsUrl = isGitRemoteUrl(repoPath);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (readOnly || !onSubmit || !canSubmit) return;
    setSubmitting(true);
    const saved = await onSubmit({
      name: trimmedName,
      mode,
      repoPath: repoPath.trim() || null,
      baseUrl: baseUrl.trim() || null,
      testUsername: testUsername.trim() || null,
      testPassword: testPassword.trim() || null,
    });
    setSubmitting(false);
    if (saved) {
      if (!isEdit) {
        setName('');
        setRepoPath('');
        setBaseUrl('');
        setTestUsername('');
        setTestPassword('');
      }
      onDone();
    }
  };

  const title = readOnly ? `View "${project?.name}"` : isEdit ? `Edit "${project?.name}"` : 'New project';

  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={submit}>
          <Field label="Name" className="sm:col-span-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme web app"
              autoFocus={!readOnly}
              required
              disabled={readOnly}
            />
          </Field>
          <Field label="Repo path or git URL (white-box)">
            <Input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/Users/me/code/acme or https://github.com/org/repo"
              className="font-mono"
              disabled={readOnly}
            />
            {repoIsUrl && (
              <p className="mt-1 text-xs text-muted">Will be cloned locally when you create the project.</p>
            )}
          </Field>
          <Field label="Base URL (black-box)">
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://app.acme.test"
              className="font-mono"
              aria-invalid={baseUrlInvalid}
              disabled={readOnly}
            />
            {!readOnly && baseUrlInvalid && (
              <p className="mt-1 text-xs text-err">Enter a valid http(s) URL, e.g. https://app.acme.test</p>
            )}
          </Field>
          <Field label="Mode">
            <Select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'playwright')}
              disabled={readOnly}
            >
              <option value="playwright">playwright</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <h3 className="mb-1.5 text-sm font-semibold text-fg">Test credentials</h3>
          </div>
          <Field label="Test username / email">
            <Input
              value={testUsername}
              onChange={(e) => setTestUsername(e.target.value)}
              placeholder="you@example.com or a test username"
              className="font-mono"
              disabled={readOnly}
            />
          </Field>
          <Field label="Test password">
            <Input
              value={testPassword}
              onChange={(e) => setTestPassword(e.target.value)}
              placeholder="Password for the credential above"
              className="font-mono"
              disabled={readOnly}
            />
          </Field>
          {readOnly ? (
            <div className="flex items-center justify-end gap-2 sm:col-span-2">
              {onEdit && (
                <Button type="button" variant="outline" onClick={onEdit}>
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={onDone}>
                Close
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
              <p className={`text-xs ${hasTarget ? 'text-muted' : 'text-err'}`}>
                A project needs a repo path or a base URL — set at least one.
              </p>
              <div className="flex items-end justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onDone}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canSubmit}>
                  {submitting
                    ? isEdit
                      ? 'Saving…'
                      : repoIsUrl
                        ? 'Cloning repository…'
                        : 'Creating…'
                    : isEdit
                      ? 'Save changes'
                      : 'Create project'}
                </Button>
              </div>
            </div>
          )}
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
