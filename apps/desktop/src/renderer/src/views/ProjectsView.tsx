import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { NewProject, Project } from '@healix/core';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FolderGit2,
  LayoutDashboard,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { useProjects } from '../lib/use-projects';
import { cn } from '../lib/utils';

/**
 * Which form (if any) is currently shown in the main pane: nothing selected,
 * creating a new project, editing an existing one, or viewing an existing one
 * read-only. Selecting a project in the explorer panel always lands on 'view'
 * first — 'edit' is only reached from the view page's own Edit button.
 */
type FormState =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; project: Project }
  | { kind: 'view'; project: Project };

/**
 * VSCode-Explorer-style two-pane layout: a slim list of project names on the
 * left (this file's ProjectExplorerPanel), and the selected project's detail
 * page (view/edit) or the create form in the main pane to its right.
 */
export function ProjectsView({
  onRunProject,
  onOpenDashboard,
  sidebarCollapsed = false,
}: {
  onRunProject?: (project: Project) => void;
  onOpenDashboard?: (project: Project) => void;
  /** Hides the explorer panel entirely — toggled from the activity bar by re-clicking the Projects icon. */
  sidebarCollapsed?: boolean;
}) {
  const { projects, loading, error, create, update, remove, archive, refresh } = useProjects();
  const [formState, setFormState] = useState<FormState>({ kind: 'closed' });

  const active = useMemo(() => projects.filter((p) => !p.archivedAt), [projects]);

  const closeForm = () => setFormState({ kind: 'closed' });

  // Keep the open detail page in sync with the underlying project list (e.g.
  // after an edit's refresh() resolves) — otherwise 'view'/'edit' would keep
  // showing the stale project object captured at selection time.
  useEffect(() => {
    setFormState((s) => {
      if (s.kind !== 'view' && s.kind !== 'edit') return s;
      const fresh = projects.find((p) => p.id === s.project.id);
      if (!fresh) return { kind: 'closed' };
      return fresh === s.project ? s : { ...s, project: fresh };
    });
  }, [projects]);

  const selectedProjectId =
    formState.kind === 'view' || formState.kind === 'edit' ? formState.project.id : null;

  return (
    <div className="flex h-full min-h-0">
      {!sidebarCollapsed && (
        <ProjectExplorerPanel
          projects={projects}
          loading={loading}
          selectedProjectId={selectedProjectId}
          onSelect={(p) => setFormState({ kind: 'view', project: p })}
          onNewProject={() =>
            setFormState((s) => (s.kind === 'create' ? { kind: 'closed' } : { kind: 'create' }))
          }
          creating={formState.kind === 'create'}
          onRefresh={() => void refresh()}
        />
      )}

      <div className="min-w-0 flex-1 overflow-y-auto px-8 pb-16 pt-8">
        {error && (
          <p className="mb-4 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error}</p>
        )}

        {formState.kind === 'closed' && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted">
            <FolderGit2 className="h-16 w-16 text-muted/20" />
            <p>Select a project from the list, or create a new one.</p>
          </div>
        )}

        {formState.kind === 'create' && (
          <ProjectForm key="create" onSubmit={create} onDone={closeForm} existingActiveProjects={active} />
        )}

        {formState.kind === 'edit' && (
          <ProjectForm
            key={`edit-${formState.project.id}`}
            project={formState.project}
            onSubmit={(input) => update(formState.project.id, input)}
            onDone={() => setFormState({ kind: 'view', project: formState.project })}
            existingActiveProjects={active}
          />
        )}

        {formState.kind === 'view' && (
          <ProjectForm
            key={`view-${formState.project.id}`}
            project={formState.project}
            readOnly
            onEdit={() => setFormState({ kind: 'edit', project: formState.project })}
            onDone={closeForm}
            onDelete={() => {
              closeForm();
              void remove(formState.project.id);
            }}
            onArchive={
              !formState.project.archivedAt ? () => void archive(formState.project.id, true) : undefined
            }
            onUnarchive={
              formState.project.archivedAt ? () => void archive(formState.project.id, false) : undefined
            }
            onRun={onRunProject ? () => onRunProject(formState.project) : undefined}
            onOpenDashboard={onOpenDashboard ? () => onOpenDashboard(formState.project) : undefined}
          />
        )}
      </div>
    </div>
  );
}

/** Shorten a long absolute path to its trailing segments (…/a/b) for a compact title attribute. */
function shortenPath(p: string, segments = 2): string {
  const parts = p
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter(Boolean);
  if (parts.length <= segments) return p;
  return `…/${parts.slice(-segments).join('/')}`;
}

/**
 * Slim, name-only project list (VSCode Explorer style) — no inline row
 * actions; every action (Run, Edit, Archive, Delete, Dashboard) lives on the
 * detail page a row opens, not on the row itself.
 */
function ProjectExplorerPanel({
  projects,
  loading,
  selectedProjectId,
  onSelect,
  onNewProject,
  creating,
  onRefresh,
}: {
  projects: Project[];
  loading: boolean;
  selectedProjectId: string | null;
  onSelect: (project: Project) => void;
  onNewProject: () => void;
  creating: boolean;
  onRefresh: () => void;
}) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const active = useMemo(() => projects.filter((p) => !p.archivedAt), [projects]);
  const archived = useMemo(() => projects.filter((p) => p.archivedAt), [projects]);

  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-border pb-6 pt-8 pl-4 pr-2">
      <div className="mb-1.5 flex items-center justify-between pr-2">
        <span className="text-xs font-medium text-muted">Projects</span>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant={creating ? 'outline' : 'ghost'}
            onClick={onNewProject}
            aria-label="New project"
            title="New project"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onRefresh}
            aria-label="Refresh projects"
            disabled={loading}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-panel/40">
        {loading && projects.length === 0 && <p className="px-3 py-4 text-xs text-muted">Loading…</p>}
        {!loading && projects.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted">No projects yet. Create one to start.</p>
        )}
        <ul className="divide-y divide-border/50">
          {active.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              selected={p.id === selectedProjectId}
              onSelect={() => onSelect(p)}
            />
          ))}
        </ul>

        {archived.length > 0 && (
          <div className="border-t border-border/50">
            <button
              type="button"
              onClick={() => setArchivedOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted hover:text-fg"
            >
              {archivedOpen ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <Archive className="h-3 w-3 shrink-0" />
              Archived
              <span className="font-normal">· {archived.length}</span>
            </button>
            {archivedOpen && (
              <ul className="divide-y divide-border/50">
                {archived.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    selected={p.id === selectedProjectId}
                    onSelect={() => onSelect(p)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectRow({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: boolean;
  onSelect: () => void;
}) {
  const isArchived = Boolean(project.archivedAt);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        title={project.repoPath ? shortenPath(project.repoPath, 3) : (project.baseUrl ?? project.name)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
          selected ? 'bg-accent/10' : 'hover:bg-panel',
          isArchived && 'opacity-60',
        )}
      >
        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {isArchived && <Badge tone="muted">archived</Badge>}
      </button>
    </li>
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
 * with a `project`) every field is shown but disabled — this is the detail
 * page opened from the explorer panel, so it also carries every project-level
 * action (Run, Open dashboard, Edit, Archive/Restore, Delete) alongside Close.
 */
function ProjectForm({
  project,
  onSubmit,
  onEdit,
  onDone,
  onDelete,
  onArchive,
  onUnarchive,
  onRun,
  onOpenDashboard,
  readOnly = false,
  existingActiveProjects = [],
}: {
  project?: Project;
  onSubmit?: (input: NewProject) => Promise<Project | null>;
  onEdit?: () => void;
  onDone: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onRun?: () => void;
  onOpenDashboard?: () => void;
  readOnly?: boolean;
  /** Active (non-archived) projects, for inline duplicate-name feedback. */
  existingActiveProjects?: Project[];
}) {
  const isEdit = project !== undefined && !readOnly;
  const [name, setName] = useState(project?.name ?? '');
  const [repoPath, setRepoPath] = useState(project?.repoPath ?? '');
  const [baseUrl, setBaseUrl] = useState(project?.baseUrl ?? '');
  const [mode, setMode] = useState<'playwright'>((project?.mode as 'playwright') ?? 'playwright');
  const [testUsername, setTestUsername] = useState(project?.testUsername ?? '');
  const [testPassword, setTestPassword] = useState(project?.testPassword ?? '');
  const [showTestPassword, setShowTestPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [browsingRepoPath, setBrowsingRepoPath] = useState(false);

  const browseRepoPath = async (): Promise<void> => {
    setBrowsingRepoPath(true);
    try {
      const result = await window.healix.pickRepoPath();
      if (!result.canceled && result.path) setRepoPath(result.path);
    } finally {
      setBrowsingRepoPath(false);
    }
  };

  // Same rules as core validateNewProject: a project needs a name, at least one
  // of repo/URL, and a well-formed http(s) URL when a base URL is provided.
  const trimmedName = name.trim();
  const hasTarget = repoPath.trim().length > 0 || baseUrl.trim().length > 0;
  const baseUrlInvalid = baseUrl.trim().length > 0 && !isValidBaseUrl(baseUrl);
  // Mirrors HealixStore's case-insensitive, active-projects-only duplicate
  // guard — excludes the project being edited itself, so resubmitting an
  // unchanged name never false-positives.
  const nameTaken =
    trimmedName.length > 0 &&
    existingActiveProjects.some(
      (p) => p.id !== project?.id && p.name.trim().toLowerCase() === trimmedName.toLowerCase(),
    );
  const canSubmit = trimmedName.length > 0 && hasTarget && !baseUrlInvalid && !nameTaken && !submitting;
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
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        {readOnly && (
          <div className="flex shrink-0 items-center gap-1">
            {onOpenDashboard && (
              <Button
                size="icon"
                variant="ghost"
                onClick={onOpenDashboard}
                aria-label="Open project dashboard"
                title="Open project dashboard"
              >
                <LayoutDashboard className="h-4 w-4" />
              </Button>
            )}
            {onRun && (
              <Button size="sm" variant="outline" onClick={onRun}>
                <Play className="h-4 w-4" />
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
            {onDelete && <DeleteButton projectName={project?.name ?? ''} onDelete={onDelete} />}
          </div>
        )}
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
              aria-invalid={nameTaken}
            />
            {!readOnly && nameTaken && (
              <p className="mt-1 text-xs text-err">A project named "{trimmedName}" already exists.</p>
            )}
          </Field>
          <Field label="Repo path or git URL (white-box)">
            <div className="flex gap-1.5">
              <div className="min-w-0 flex-1">
                <Input
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  placeholder="/Users/me/code/acme or https://github.com/org/repo"
                  className="font-mono"
                  disabled={readOnly}
                />
              </div>
              {!readOnly && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void browseRepoPath()}
                  disabled={browsingRepoPath}
                  title="Browse for a local folder"
                >
                  <FolderGit2 className="h-4 w-4" />
                  Browse…
                </Button>
              )}
            </div>
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
            <div className="relative">
              <Input
                type={showTestPassword ? 'text' : 'password'}
                value={testPassword}
                onChange={(e) => setTestPassword(e.target.value)}
                placeholder="Password for the credential above"
                className="pr-9 font-mono"
                autoComplete="new-password"
                disabled={readOnly}
              />
              <button
                type="button"
                onClick={() => setShowTestPassword((v) => !v)}
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted hover:text-fg"
                aria-label={showTestPassword ? 'Hide test password' : 'Show test password'}
                aria-pressed={showTestPassword}
                tabIndex={-1}
              >
                {showTestPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
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

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block">{label}</Label>
      {children}
    </div>
  );
}
