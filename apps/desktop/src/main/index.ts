import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import {
  doctor,
  ProviderRouter,
  getStore,
  createOrchestrator,
  exportSuite,
  projectsDir,
  type NewProject,
  type Project,
  type ExplorationMode,
  type ProviderId,
  type TestPlan,
  type RunSummary,
} from '@healix/core';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  win.on('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// ---- IPC: typed bridge to @healix/core ----

ipcMain.handle('healix:doctor', (_e, args: { probe?: boolean } | undefined) =>
  doctor({ probe: args?.probe ?? true }),
);
ipcMain.handle('healix:providers', () =>
  new ProviderRouter()
    .list()
    .map((p) => ({ id: p.id, label: p.label, capabilities: p.capabilities })),
);

// ---- Projects (persisted via the local SQLite store) ----

async function requireStore() {
  const store = await getStore();
  if (!store) {
    throw new Error('Local storage is unavailable (node:sqlite missing). Projects cannot be persisted.');
  }
  return store;
}

ipcMain.handle('projects:list', async (): Promise<Project[]> => {
  const store = await requireStore();
  return store.listProjects();
});

ipcMain.handle('projects:create', async (_e, input: NewProject): Promise<Project> => {
  const store = await requireStore();
  const name = (input?.name ?? '').trim();
  if (!name) throw new Error('Project name is required.');
  return store.createProject({
    name,
    mode: input.mode ?? 'playwright',
    repoPath: normalizeOptional(input.repoPath),
    baseUrl: normalizeOptional(input.baseUrl),
  });
});

ipcMain.handle('projects:delete', async (_e, id: string): Promise<{ ok: true }> => {
  const store = await requireStore();
  if (!id) throw new Error('Project id is required.');
  store.deleteProject(id);
  return { ok: true };
});

// ---- Run lifecycle (orchestrator with streamed events + correlated approval gate) ----

interface PendingApproval {
  resolve: (ok: boolean) => void;
}

/** runId -> resolver for the in-flight approval gate awaiting a renderer reply. */
const pendingApprovals = new Map<string, PendingApproval>();

/** Resolve a parked approval gate. Returns true when a gate was actually waiting. */
function settleApproval(runId: string, ok: boolean): boolean {
  const pending = pendingApprovals.get(runId);
  if (!pending) return false;
  pendingApprovals.delete(runId);
  pending.resolve(ok);
  return true;
}

export interface StartRunArgs {
  projectId: string;
  /** Maps to the orchestrator's exploration mode (codegen | computer-use). */
  mode?: ExplorationMode;
  provider?: ProviderId;
  autoApprove?: boolean;
  prd?: string;
}

ipcMain.handle('run:start', async (event: IpcMainInvokeEvent, args: StartRunArgs): Promise<RunSummary> => {
  if (!args?.projectId) throw new Error('A projectId is required to start a run.');
  const sender = event.sender;

  // The orchestrator owns the canonical runId, but the approval gate must be
  // correlated to a stable key the renderer can reference before run() resolves.
  // We pre-create a run row so renderer + main agree on the id up-front.
  const store = await requireStore();
  const project = store.getProject(args.projectId);
  if (!project) throw new Error(`Project not found: ${args.projectId}`);

  const run = store.createRun(args.projectId, {
    provider: args.provider ?? null,
    mode: project.mode,
  });
  const runId = run.id;

  // Tell the renderer the run id so it can target approve/subscribe to events.
  safeSend(sender, 'run:started', { runId, projectId: args.projectId });

  const orchestrator = createOrchestrator();

  const summary = await orchestrator
    .run(
      {
        projectId: args.projectId,
        provider: args.provider,
        explorationMode: args.mode,
        autoApprove: args.autoApprove ?? false,
        prd: args.prd,
      },
      {
        onEvent: (e) => {
          safeSend(sender, 'run:event', { runId, event: e });
        },
        onPlan: (plan: TestPlan) => {
          safeSend(sender, 'run:plan', { runId, plan });
          // Auto-approve short-circuits the human gate.
          if (args.autoApprove) return Promise.resolve(true);
          return waitForApproval(runId, sender);
        },
      },
    )
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      safeSend(sender, 'run:event', {
        runId,
        event: { phase: 'error', level: 'error', message },
      });
      const failed: RunSummary = { runId, status: 'error' };
      return failed;
    })
    .finally(() => {
      // Never leak a parked gate if the run ended for any other reason.
      settleApproval(runId, false);
    });

  safeSend(sender, 'run:done', { runId, summary });
  return summary;
});

ipcMain.handle('run:approve', (_e, payload: { runId: string; ok: boolean }): { settled: boolean } => {
  if (!payload?.runId) return { settled: false };
  return { settled: settleApproval(payload.runId, payload.ok === true) };
});

// ---- Suite export ----

ipcMain.handle(
  'export:suite',
  async (
    _e,
    args: { suiteDir: string; outDir?: string; sanitize?: boolean; zip?: boolean },
  ) => {
    if (!args?.suiteDir) throw new Error('suiteDir is required to export a suite.');
    const outDir = args.outDir ?? join(projectsDir(), 'exports');
    const bundle = await exportSuite({
      suiteDir: args.suiteDir,
      outDir,
      sanitize: args.sanitize ?? true,
      zip: args.zip ?? true,
    });
    return bundle;
  },
);

// ---- Reveal a folder in the OS file manager (for "Reveal suite folder") ----

ipcMain.handle('shell:reveal', async (_e, target: string): Promise<{ ok: boolean }> => {
  if (!target) return { ok: false };
  const err = await shell.openPath(target);
  // openPath returns '' on success, otherwise an error string.
  return { ok: err === '' };
});

// ---- helpers ----

function normalizeOptional(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : null;
}

/** Park the orchestrator until the renderer replies via 'run:approve'. */
function waitForApproval(runId: string, sender: WebContents): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // If a stale gate somehow exists for this id, reject it first.
    settleApproval(runId, false);
    pendingApprovals.set(runId, { resolve });

    // If the window is torn down while we wait, fail closed.
    const onDestroyed = (): void => {
      settleApproval(runId, false);
    };
    sender.once('destroyed', onDestroyed);
  });
}

/** Send to a renderer only if it's still alive (windows can close mid-run). */
function safeSend(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return;
  sender.send(channel, payload);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
