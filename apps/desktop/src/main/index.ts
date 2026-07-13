import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
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
  deleteProjectAssets,
  type NewProject,
  type Project,
  type ExplorationMode,
  type ProviderId,
  type TestPlan,
  type RunSummary,
  type Run,
  type TestCase,
  type TestResult,
  type AgentEvent,
  type HealthResult,
} from '@healix/core';

/**
 * Custom scheme that serves run artifacts (screenshots / videos / traces) into
 * the renderer's <img>/<video> tags. Must be registered before app ready.
 * The handler only serves files that live inside the Healix projects dir.
 */
const ARTIFACT_SCHEME = 'healix-artifact';

protocol.registerSchemesAsPrivileged([
  { scheme: ARTIFACT_SCHEME, privileges: { secure: true, supportFetchAPI: true, stream: true } },
]);

/** Resolve a healix-artifact:// request to a file inside projectsDir, or null. */
function artifactRequestPath(rawUrl: string): string | null {
  let decoded: string;
  try {
    const url = new URL(rawUrl);
    // The renderer URL-encodes the absolute path as the single path segment.
    decoded = decodeURIComponent(url.pathname).replace(/^\/+/, '/');
  } catch {
    return null;
  }
  // Windows: "/C:\foo" → "C:\foo".
  const abs = resolve(decoded.replace(/^\/([A-Za-z]:)/, '$1'));
  const root = resolve(projectsDir());
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

function registerArtifactProtocol(): void {
  protocol.handle(ARTIFACT_SCHEME, async (request) => {
    const abs = artifactRequestPath(request.url);
    if (!abs) return new Response('Not allowed', { status: 403 });
    try {
      return await net.fetch(pathToFileURL(abs).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/**
 * Dev-mode branding: the packaged app carries the leaf icon in its bundle, but
 * a bare `electron .` shows Electron's default atom. Point the dock/window at
 * the leaf explicitly when running unpackaged.
 */
const DEV_ICON = join(app.getAppPath(), 'build', 'icon.png');

function applyDevDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin') return;
  try {
    app.dock?.setIcon(DEV_ICON);
  } catch {
    /* icon missing or unreadable — keep the default rather than crash */
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0a0e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Windows/Linux take the window icon from here; macOS uses the dock icon.
    ...(app.isPackaged ? {} : { icon: DEV_ICON }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload only touches contextBridge/ipcRenderer (no node built-ins),
      // so it runs fine inside Chromium's renderer sandbox.
      sandbox: true,
    },
  });

  win.on('ready-to-show', () => {
    win.show();
    // GUI boot smoke: when HEALIX_SMOKE is set, prove the window mounted, then
    // quit shortly after so the app can be boot-verified headlessly/briefly.
    // Guarded so normal launches are entirely unaffected.
    if (process.env.HEALIX_SMOKE) {
      console.log('HEALIX_SMOKE_OK');
      setTimeout(() => app.quit(), 1500);
    }
  });
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
  new ProviderRouter().list().map((p) => ({ id: p.id, label: p.label, capabilities: p.capabilities })),
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

ipcMain.handle('projects:delete', async (_e, id: string): Promise<{ ok: true; assetsRemoved: boolean }> => {
  const store = await requireStore();
  if (!id) throw new Error('Project id is required.');
  store.deleteProject(id);
  // Remove the project's on-disk assets (runs, suites, screenshots, videos).
  // Best-effort: the DB rows are already gone; a disk failure should not
  // resurrect the project, only be reported.
  let assetsRemoved = true;
  try {
    await deleteProjectAssets(id);
  } catch {
    assetsRemoved = false;
  }
  return { ok: true, assetsRemoved };
});

ipcMain.handle(
  'projects:archive',
  async (_e, payload: { id: string; archived: boolean }): Promise<{ ok: true }> => {
    const store = await requireStore();
    if (!payload?.id) throw new Error('Project id is required.');
    store.setProjectArchived(payload.id, payload.archived === true);
    return { ok: true };
  },
);

// ---- Run lifecycle (orchestrator with streamed events + correlated approval gate) ----

interface PendingApproval {
  resolve: (ok: boolean) => void;
}

/** runId -> resolver for the in-flight approval gate awaiting a renderer reply. */
const pendingApprovals = new Map<string, PendingApproval>();

/**
 * runId -> AbortController for the in-flight run, registered once the
 * orchestrator reports the canonical runId. Aborting cancels the run at the
 * next phase boundary; the orchestrator resolves with status 'cancelled'.
 */
const activeRuns = new Map<string, AbortController>();

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
  // One run at a time: every run shares the single live-browser mirror surface
  // and the target adapter binds fixed local ports, so concurrent runs would
  // fight over both. Guard here until the run pipeline is multi-tenant.
  if (activeRuns.size > 0) {
    throw new Error('A run is already in progress. Cancel it or wait for it to finish.');
  }
  const sender = event.sender;

  // The orchestrator owns the canonical runId. We learn it via the onRunCreated
  // hook (fired right after the run row is created, before any phase event) and
  // correlate run:started / approval / events to THAT id — no duplicate run row.
  const store = await requireStore();
  const project = store.getProject(args.projectId);
  if (!project) throw new Error(`Project not found: ${args.projectId}`);

  let runId: string | null = null;

  // One controller per run; run:cancel aborts it and the orchestrator winds the
  // run down cooperatively at the next phase boundary (status 'cancelled').
  const controller = new AbortController();

  const orchestrator = createOrchestrator();

  const summary = await orchestrator
    .run(
      {
        projectId: args.projectId,
        provider: args.provider,
        explorationMode: args.mode,
        autoApprove: args.autoApprove ?? false,
        prd: args.prd,
        signal: controller.signal,
      },
      {
        onRunCreated: (id: string) => {
          runId = id;
          // Register under the canonical runId so run:cancel can find it.
          activeRuns.set(id, controller);
          // Tell the renderer the real run id so it can approve / subscribe.
          safeSend(sender, 'run:started', { runId: id, projectId: args.projectId });
        },
        onEvent: (e) => {
          if (runId) safeSend(sender, 'run:event', { runId, event: e });
        },
        onPlan: (plan: TestPlan) => {
          if (runId) safeSend(sender, 'run:plan', { runId, plan });
          // Auto-approve short-circuits the human gate.
          if (args.autoApprove || !runId) return Promise.resolve(true);
          return waitForApproval(runId, sender);
        },
        // Live browser mirroring for computer-use runs. Throttling (~2fps) and
        // JPEG encoding happen in the browser surface; we only base64 + forward.
        onFrame: (frame: Buffer) => {
          if (runId) safeSend(sender, 'run:frame', { runId, frameBase64: frame.toString('base64') });
        },
      },
    )
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      safeSend(sender, 'run:event', {
        runId: runId ?? 'unknown',
        event: { phase: 'error', level: 'error', message },
      });
      const failed: RunSummary = { runId: runId ?? 'unknown', status: 'error' };
      return failed;
    })
    .finally(() => {
      // Never leak a parked gate or a stale controller, however the run ended.
      if (runId) {
        settleApproval(runId, false);
        activeRuns.delete(runId);
      }
    });

  safeSend(sender, 'run:done', { runId: runId ?? summary.runId, summary });
  return summary;
});

ipcMain.handle('run:approve', (_e, payload: { runId: string; ok: boolean }): { settled: boolean } => {
  if (!payload?.runId) return { settled: false };
  return { settled: settleApproval(payload.runId, payload.ok === true) };
});

ipcMain.handle('run:cancel', (_e, payload: { runId: string }): { cancelled: boolean } => {
  const runId = payload?.runId;
  if (!runId) return { cancelled: false };
  // A parked approval gate would hold the orchestrator before it ever checks
  // the abort signal, so cancelling also rejects any pending plan approval.
  settleApproval(runId, false);
  const controller = activeRuns.get(runId);
  if (!controller) return { cancelled: false };
  controller.abort();
  return { cancelled: true };
});

// ---- Suite export ----

ipcMain.handle(
  'export:suite',
  async (_e, args: { suiteDir: string; outDir?: string; sanitize?: boolean; zip?: boolean }) => {
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

// ---- Select a file in the OS file manager (true "reveal", not "open") ----

ipcMain.handle('shell:showItem', (_e, target: string): { ok: boolean } => {
  if (!target) return { ok: false };
  shell.showItemInFolder(target);
  return { ok: true };
});

// ---- Provider login (open the CLI login flow) ----

export interface ProviderLoginResult {
  launched: boolean;
  command: string;
  detail: string;
}

/** The interactive command a user runs to authenticate each provider's CLI. */
const LOGIN_COMMANDS: Record<ProviderId, string> = {
  // Claude Code authenticates by running `claude` once and signing into the subscription.
  claude: 'claude',
  // Codex CLI exposes an explicit login subcommand.
  openai: 'codex login',
};

/** Install guidance shown when a provider's CLI is not detected on PATH. */
const INSTALL_GUIDANCE: Record<ProviderId, string> = {
  claude: 'Claude Code CLI not found. Install it from https://claude.com/claude-code, then retry login.',
  openai: 'Codex CLI not found. Install the OpenAI Codex CLI (npm i -g @openai/codex), then retry login.',
};

ipcMain.handle('provider:login', async (_e, payload: { id: ProviderId }): Promise<ProviderLoginResult> => {
  const id = payload?.id;
  if (!isProviderId(id)) {
    return { launched: false, command: '', detail: `Unknown provider: ${String(id)}` };
  }
  const command = LOGIN_COMMANDS[id];
  try {
    const provider = new ProviderRouter().get(id);
    if (!provider) {
      return { launched: false, command, detail: `Unknown provider: ${id}` };
    }
    const det = await provider.detect();
    if (!det.installed) {
      return { launched: false, command, detail: INSTALL_GUIDANCE[id] };
    }
    if (process.platform === 'darwin') {
      // Open Terminal.app and run the interactive login command there, so the
      // user can complete an OAuth/device flow in a real TTY.
      const osa = `tell application "Terminal" to do script "${escapeForAppleScript(command)}"`;
      spawn('osascript', ['-e', osa], { stdio: 'ignore', detached: true }).unref();
      return {
        launched: true,
        command,
        detail: `Opened Terminal running "${command}". Complete the login there, then re-check health.`,
      };
    }
    // Non-darwin: we can't reliably pop a terminal; hand back the command to run.
    return {
      launched: false,
      command,
      detail: `Run "${command}" in a terminal to log in, then re-check health.`,
    };
  } catch (err) {
    // Never throw across the IPC boundary — surface as a non-launched result.
    return { launched: false, command, detail: `Login could not be started: ${errMsg(err)}` };
  }
});

// ---- Provider health (single provider) ----

ipcMain.handle(
  'provider:health',
  async (_e, payload: { id: ProviderId; probe?: boolean }): Promise<HealthResult> => {
    const id = payload?.id;
    const provider = isProviderId(id) ? new ProviderRouter().get(id) : undefined;
    if (!provider) {
      // Shape-compatible "missing" result rather than throwing.
      return {
        provider: isProviderId(id) ? id : (String(id) as ProviderId),
        status: 'error',
        installed: false,
        binPath: null,
        version: null,
        authenticated: false,
        model: null,
        latencyMs: null,
        detail: `Unknown provider: ${String(id)}`,
      };
    }
    return provider.health({ probe: payload?.probe ?? true });
  },
);

// ---- Runs: list + detail (read from store + on-disk run artifacts) ----

/**
 * Cap the history payload at the newest 200 runs: the renderer's history rail
 * is an unvirtualized list, so shipping every run ever recorded both bloats
 * the IPC payload and makes the DOM crawl. listRuns orders newest-first.
 */
const RUNS_LIST_LIMIT = 200;

ipcMain.handle('runs:list', async (_e, payload: { projectId?: string } | undefined): Promise<Run[]> => {
  const store = await getStore();
  if (!store) return [];
  try {
    return store.listRuns(payload?.projectId).slice(0, RUNS_LIST_LIMIT);
  } catch {
    return [];
  }
});

export interface RunDetail {
  run: Run | null;
  tests: TestCase[];
  results: TestResult[];
  events: AgentEvent[];
  report: unknown | null;
  suiteDir: string | null;
  artifacts: string[];
  /** Absolute path to the run's rendered HTML report, when present on disk. */
  reportHtmlPath: string | null;
}

ipcMain.handle('runs:detail', async (_e, payload: { runId: string }): Promise<RunDetail> => {
  const empty: RunDetail = {
    run: null,
    tests: [],
    results: [],
    events: [],
    report: null,
    suiteDir: null,
    artifacts: [],
    reportHtmlPath: null,
  };
  const runId = payload?.runId;
  if (!runId) return empty;

  const store = await getStore();
  if (!store) return empty;

  // Store reads — best-effort, never throw.
  let run: Run | null = null;
  let tests: TestCase[] = [];
  let results: TestResult[] = [];
  let events: AgentEvent[] = [];
  try {
    run = store.getRun(runId);
  } catch {
    run = null;
  }
  try {
    tests = store.listTests(runId);
  } catch {
    tests = [];
  }
  try {
    results = store.listResults(runId);
  } catch {
    results = [];
  }
  try {
    events = store.listEvents(runId);
  } catch {
    events = [];
  }

  // On-disk artifacts live under <projectsDir>/<projectId>/runs/<runId>/...
  // We need the projectId; prefer the run row, fall back to empty disk reads.
  let report: unknown | null = null;
  let suiteDir: string | null = null;
  let artifacts: string[] = [];
  let reportHtmlPath: string | null = null;

  if (run) {
    const runDir = join(projectsDir(), run.projectId, 'runs', runId);
    report = await readJsonIfExists(join(runDir, 'reports', 'report.json'));
    const suite = join(runDir, 'suite');
    if (await isDir(suite)) suiteDir = suite;
    artifacts = await listFilesRecursive(join(runDir, 'suite', 'test-results'));
    const html = join(runDir, 'reports', 'report.html');
    if (await isFile(html)) reportHtmlPath = html;
  }

  return { run, tests, results, events, report, suiteDir, artifacts, reportHtmlPath };
});

// ---- helpers ----

/** Parse a JSON file if it exists; return null on any error (missing/malformed). */
async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** True if the path exists and is a directory. */
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** True if the path exists and is a regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Recursively list every file under `root`, returned as paths relative to `root`
 * with forward slashes. Returns [] when the directory is missing or unreadable.
 */
async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  if (await isDir(root)) await walk(root);
  return out.sort();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Narrow an untyped IPC value to a known ProviderId. */
function isProviderId(v: unknown): v is ProviderId {
  return v === 'claude' || v === 'openai';
}

/** Escape a string for safe embedding inside an AppleScript double-quoted literal. */
function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

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

    // If the window is torn down while we wait, fail closed.
    const onDestroyed = (): void => {
      settleApproval(runId, false);
    };

    // Wrap resolve so settling the gate (approve, reject, or destroy) also
    // detaches the 'destroyed' listener. Without this, a normally-approved run
    // leaves a dead listener on the long-lived window every time — after enough
    // runs Node emits MaxListenersExceededWarning and each closure leaks.
    const settle = (ok: boolean): void => {
      sender.removeListener('destroyed', onDestroyed);
      resolve(ok);
    };

    pendingApprovals.set(runId, { resolve: settle });
    sender.once('destroyed', onDestroyed);
  });
}

/** Send to a renderer only if it's still alive (windows can close mid-run). */
function safeSend(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return;
  sender.send(channel, payload);
}

app.whenReady().then(() => {
  registerArtifactProtocol();
  // Orphaned-run janitor: runs left in non-terminal states by a crashed or
  // quit session would otherwise look "running" forever in the history rail
  // (a real one sat in 'planning' for a week). Best-effort and fire-and-forget
  // so a missing/broken store never blocks window creation.
  void (async () => {
    try {
      const reaped = (await getStore())?.failOrphanedRuns() ?? 0;
      if (reaped > 0) console.log(`[healix] janitor: marked ${reaped} orphaned run(s) as error`);
    } catch {
      /* storage unavailable — nothing to reap */
    }
  })();
  applyDevDockIcon();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
