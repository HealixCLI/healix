import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { extractSheets, previewSheets, type SheetPreview } from './spreadsheet.js';
import { matchGenerationGaps, matchRepairCandidates, type GenerationGapItem } from './repair-candidates.js';
import {
  doctor,
  ProviderRouter,
  getStore,
  createOrchestrator,
  exportSuite,
  projectsDir,
  reposDir,
  deleteProjectAssets,
  deleteRunAssets,
  isGitRemoteUrl,
  cloneRepo,
  computeIdentityKey,
  resolveProvider,
  reviseItem,
  type NewProject,
  type Project,
  type TestingScope,
  type ProviderId,
  type TestPlan,
  type TestPlanItem,
  type PlanApprovalResult,
  type RunSummary,
  type Run,
  reconcileRuns,
  readRunConfigSnapshot,
  type RunConfigSnapshot,
  type SuiteMode,
  type TestCase,
  type TestResult,
  type AgentEvent,
  type HealthResult,
  DEFAULT_MODEL_CONFIG,
  readModelConfigOverrides,
  writeModelConfigOverrides,
  type ModelEffortConfig,
  type ModelEffortOverrides,
  type UsageRow,
  type UsageAggregate,
} from '@healix/core';

// Last-resort net: every ipcMain handler already catches its own errors and
// reports them as run/queue failures, but an error escaping that net (a bug
// in the catch path itself, a rejection with no attached .catch, an error
// thrown outside any handler) would otherwise crash the whole Electron main
// process and take the app down with it. Log and keep running instead.
process.on('uncaughtException', (err) => {
  console.error('[healix:uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[healix:unhandledRejection]', reason);
});

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
  // Windows filesystems are case-insensitive, but this is a plain string
  // comparison — without normalizing case here, a containment check can
  // fail (and silently 403 an otherwise-legitimate artifact) whenever the
  // drive letter or a path segment's case differs from projectsDir()'s own
  // resolved casing, which shows up as one artifact rendering fine and an
  // otherwise-identical one appearing broken for no visible reason.
  const cmp = process.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s;
  if (cmp(abs) !== cmp(root) && !cmp(abs).startsWith(cmp(root) + sep)) return null;
  return abs;
}

function registerArtifactProtocol(): void {
  protocol.handle(ARTIFACT_SCHEME, async (request) => {
    const abs = artifactRequestPath(request.url);
    if (!abs) return new Response('Not allowed', { status: 403 });
    try {
      // Forward the incoming Range header (sent by <video> for seeking, and
      // by Chromium's own metadata-preload probe even before playback starts)
      // through to the file:// fetch. Without it, every request — ranged or
      // not — got the FULL file back with a 200, which a <video> element
      // that asked for a byte range doesn't accept as valid: seeking breaks,
      // and some files fail to decode at all and render as "corrupted"/black.
      // Chromium's own file:// loader (which net.fetch uses under the hood)
      // already knows how to answer a Range request correctly — it just
      // needs the header passed through.
      const range = request.headers.get('range');
      return await net.fetch(pathToFileURL(abs).toString(), {
        headers: range ? { Range: range } : undefined,
      });
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

  // "Repo path" accepts a local folder OR a git URL (GitHub/GitLab/etc.) — a
  // URL is cloned here, up front, so the store only ever sees a local path.
  let repoPath = normalizeOptional(input.repoPath);
  if (repoPath && isGitRemoteUrl(repoPath)) {
    try {
      repoPath = (await cloneRepo(repoPath, reposDir())).path;
    } catch (err) {
      throw new Error(`Could not clone ${repoPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return store.createProject({
    name,
    mode: input.mode ?? 'playwright',
    repoPath,
    baseUrl: normalizeOptional(input.baseUrl),
    credentials: input.credentials,
  });
});

ipcMain.handle('projects:update', async (_e, payload: { id: string } & NewProject): Promise<Project> => {
  const store = await requireStore();
  const { id, ...input } = payload ?? ({} as { id: string } & NewProject);
  if (!id) throw new Error('Project id is required.');
  const name = (input?.name ?? '').trim();
  if (!name) throw new Error('Project name is required.');
  return store.updateProject(id, {
    name,
    mode: input.mode ?? 'playwright',
    repoPath: normalizeOptional(input.repoPath),
    baseUrl: normalizeOptional(input.baseUrl),
    credentials: input.credentials,
  });
});

ipcMain.handle('projects:delete', async (_e, id: string): Promise<{ ok: true; assetsRemoved: boolean }> => {
  const store = await requireStore();
  if (!id) throw new Error('Project id is required.');

  // Cancel any run of this project that's actively executing right now —
  // must happen BEFORE store.deleteProject, which cascade-deletes the run
  // row this looks up. Without this, the engine watching that run would sit
  // on "running" (button stuck on "Queue run") forever: the orchestrator has
  // no idea its project just vanished, so run:done would never arrive to
  // settle it. Mirrors run:cancel's own settleApproval + abort sequence.
  for (const [runId, controller] of activeRuns) {
    if (store.getRun(runId)?.projectId !== id) continue;
    broadcastAll('run:event', {
      runId,
      event: { phase: 'error', level: 'error', message: "This run's project was deleted — cancelling." },
    });
    settleApproval(runId, { decision: 'cancel' });
    controller.abort();
  }

  store.deleteProject(id);

  // Drop any of this project's requests still waiting in the run queue —
  // otherwise they'd sit there until their turn, then fail once dequeued
  // (still handled gracefully, but there's no reason to let a doomed request
  // occupy a queue slot when we already know it can never run).
  const remaining = runQueue.filter((q) => q.projectId !== id);
  if (remaining.length !== runQueue.length) {
    runQueue.length = 0;
    runQueue.push(...remaining);
    broadcastAll('queue:updated', { queue: serializeQueue() });
  }

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
  resolve: (result: PlanApprovalResult) => void;
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
function settleApproval(runId: string, result: PlanApprovalResult): boolean {
  const pending = pendingApprovals.get(runId);
  if (!pending) return false;
  pendingApprovals.delete(runId);
  pending.resolve(result);
  return true;
}

/**
 * A run request that arrived while another run was active. Queued explicitly
 * (the renderer only calls this path when the user chose "Queue run", not
 * "Run now") and started automatically, in order, once the run ahead of it
 * settles — see startNextQueued(). Planning/approval for a queued entry never
 * happens ahead of time; it's just "project + options waiting its turn."
 */
interface QueuedRunRequest {
  id: string;
  projectId: string;
  projectName: string;
  args: StartRunArgs;
  queuedAt: string;
  sender: WebContents;
}

/** FIFO queue of pending run requests. Only ever mutated by run:start, queue:remove, and startNextQueued. */
const runQueue: QueuedRunRequest[] = [];

/** Serializable (no WebContents) view of the queue, sent to every renderer. */
function serializeQueue(): Array<
  Omit<QueuedRunRequest, 'sender' | 'args'> & { testingScope?: TestingScope; suiteMode?: SuiteMode }
> {
  return runQueue.map(({ sender: _sender, args, ...rest }) => ({
    ...rest,
    testingScope: args.testingScope,
    suiteMode: args.suiteMode,
  }));
}

/** Send a message to every open window — queue updates aren't scoped to whichever window started a particular run. */
function broadcastAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) safeSend(win.webContents, channel, payload);
}

export interface StartRunArgs {
  projectId: string;
  /** What to test — drives tier selection; the underlying exploration
   * mechanism (codegen vs. computer-use) is derived internally from the
   * project's config. */
  testingScope?: TestingScope;
  provider?: ProviderId;
  autoApprove?: boolean;
  prd?: string;
  /**
   * Freeform additional instructions from the user, steering HOW the plan is
   * built (e.g. "focus on accessibility", "prefer data-testid selectors") —
   * distinct from the PRD, which describes WHAT the app does.
   */
  instructions?: string;
  /** How `prd` was produced — free typing, a prose file upload, or a parsed spreadsheet. */
  prdSourceKind?: 'text' | 'file' | 'spreadsheet';
  /** Original uploaded file name, when `prd` came from a file/spreadsheet upload. */
  prdFileName?: string;
  /** Sheet names included in `prd`, when `prdSourceKind` is 'spreadsheet'. */
  prdSelectedSheets?: string[];
  /** Suite lifecycle: fresh (default), top-up an existing suite, or reuse one as-is. */
  suiteMode?: SuiteMode;
  /** Pin top-up/reuse to a specific prior run instead of the project's latest passed run. */
  baseRunId?: string;
  /** Opt-in for the coverage feedback loop's iterative re-plan/generate/execute retry — off by default. */
  coverageLoopEnabled?: boolean;
  /** Overrides the coverage loop's target ratio (0-1) when coverageLoopEnabled is true. */
  coverageTarget?: number;
  /** Targeted regeneration for the results-page Retry-pass/Repair actions — see RunOptions.retryItemIds. */
  retryItemIds?: string[];
}

/**
 * Run the orchestrator end-to-end for `args`, streaming events to `sender`.
 * Shared by the immediate ("Run now") and queued ("Queue run", once its turn
 * comes) paths — the only difference between them is what happens BEFORE
 * this is called (queued requests wait in runQueue first).
 */
async function executeRun(args: StartRunArgs, sender: WebContents): Promise<RunSummary> {
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
        testingScope: args.testingScope,
        autoApprove: args.autoApprove ?? false,
        prd: args.prd,
        instructions: args.instructions,
        prdSourceKind: args.prdSourceKind,
        prdFileName: args.prdFileName,
        prdSelectedSheets: args.prdSelectedSheets,
        suiteMode: args.suiteMode,
        baseRunId: args.baseRunId,
        coverageLoopEnabled: args.coverageLoopEnabled,
        coverageTarget: args.coverageTarget,
        retryItemIds: args.retryItemIds,
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
          if (args.autoApprove || !runId)
            return Promise.resolve<PlanApprovalResult>({ decision: 'proceed', plan });
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
        settleApproval(runId, { decision: 'cancel' });
        activeRuns.delete(runId);
      }
    });

  safeSend(sender, 'run:done', { runId: runId ?? summary.runId, summary });
  return summary;
}

/**
 * Continue a paused run from its last checkpoint (see @healix/core's
 * orchestrator/checkpoint.ts) — a manual pause, or an automatic one from a
 * network/credits interruption. Shares executeRun's event/frame wiring, but
 * `send` is a callback instead of a fixed WebContents: boot-time auto-resume
 * has no single renderer to target yet, so it passes broadcastAll, while the
 * run:resume IPC handler passes a sender-scoped safeSend.
 *
 * A resumed run re-registers under activeRuns exactly like a fresh one (a
 * paused run's controller was already deleted when it paused — see
 * executeRun's finally), so the "one run at a time" gate and the queue both
 * treat it identically to a brand-new run.
 */
async function resumeRun(
  runId: string,
  send: (channel: string, payload: unknown) => void,
): Promise<RunSummary> {
  const controller = new AbortController();
  activeRuns.set(runId, controller);

  const store = await requireStore();
  const run = store.getRun(runId);
  // Reuses 'run:started' (not a distinct channel) — the renderer's handler
  // already does exactly what a resume needs: reset its live view to
  // 'running' for this runId. See run-engine.ts's onRunEvent switch.
  send('run:started', { runId, projectId: run?.projectId ?? 'unknown' });

  const orchestrator = createOrchestrator();
  const summary = await orchestrator
    .resume(
      runId,
      {
        onEvent: (e) => send('run:event', { runId, event: e }),
        onFrame: (frame: Buffer) => send('run:frame', { runId, frameBase64: frame.toString('base64') }),
      },
      controller.signal,
    )
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      send('run:event', { runId, event: { phase: 'error', level: 'error', message } });
      const failed: RunSummary = { runId, status: 'error' };
      return failed;
    })
    .finally(() => {
      settleApproval(runId, { decision: 'cancel' });
      activeRuns.delete(runId);
    });

  send('run:done', { runId, summary });
  return summary;
}

/**
 * Pop the next queued request (if any) and run it, chaining onward to the one
 * after that once IT settles — this is what makes the queue actually drain
 * itself, one at a time, without any renderer involvement.
 */
async function startNextQueued(): Promise<void> {
  const next = runQueue.shift();
  if (!next) return;
  broadcastAll('queue:updated', { queue: serializeQueue() });
  try {
    await executeRun(next.args, next.sender);
  } catch (err) {
    // executeRun already turns orchestrator failures into a resolved 'error'
    // summary internally — this only catches something failing before that
    // safety net (e.g. createOrchestrator() throwing synchronously). Without
    // this, one bad queued run would reject here and the recursive call below
    // would never run, silently stranding every request still waiting behind it.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[healix] queued run for "${next.projectName}" failed to start:`, err);
    broadcastAll('queue:failed', {
      message: `Queued run for "${next.projectName}" failed to start: ${message}`,
    });
  } finally {
    void startNextQueued();
  }
}

ipcMain.handle(
  'run:start',
  async (
    event: IpcMainInvokeEvent,
    args: StartRunArgs,
  ): Promise<
    { queued: false; summary: RunSummary } | { queued: true; queueEntryId: string; position: number }
  > => {
    if (!args?.projectId) throw new Error('A projectId is required to start a run.');

    const store = await requireStore();
    const project = store.getProject(args.projectId);
    if (!project) throw new Error(`Project not found: ${args.projectId}`);

    // One run EXECUTES at a time — every run shares the single live-browser
    // mirror surface and the target adapter binds fixed local ports, so
    // concurrent execution would fight over both. A request that arrives
    // while another is active queues instead of being rejected; it starts
    // automatically once the run ahead of it finishes (see startNextQueued).
    if (activeRuns.size > 0) {
      const entry: QueuedRunRequest = {
        id: `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        projectId: args.projectId,
        projectName: project.name,
        args,
        queuedAt: new Date().toISOString(),
        sender: event.sender,
      };
      runQueue.push(entry);
      broadcastAll('queue:updated', { queue: serializeQueue() });
      return { queued: true, queueEntryId: entry.id, position: runQueue.length };
    }

    const summary = await executeRun(args, event.sender);
    void startNextQueued();
    return { queued: false, summary };
  },
);

ipcMain.handle('queue:remove', (_e, payload: { queueEntryId: string }): { removed: boolean } => {
  const index = runQueue.findIndex((q) => q.id === payload?.queueEntryId);
  if (index === -1) return { removed: false };
  runQueue.splice(index, 1);
  broadcastAll('queue:updated', { queue: serializeQueue() });
  return { removed: true };
});

ipcMain.handle('queue:list', (): ReturnType<typeof serializeQueue> => serializeQueue());

/** Snapshot of the currently-executing run (if any), for a fresh renderer to hydrate its live view against. */
ipcMain.handle('run:active', async (): Promise<{ runId: string; projectId: string } | null> => {
  const [runId] = activeRuns.keys();
  if (!runId) return null;
  const store = await getStore();
  if (!store) return null;
  try {
    const run = store.getRun(runId);
    return run ? { runId, projectId: run.projectId } : null;
  } catch {
    return null;
  }
});

/**
 * Force-settle a run's persisted status directly, bypassing the (dead) live
 * orchestrator promise. Used when the user made a decision (reject/cancel) on
 * a run whose in-memory gate no longer exists — most likely orphaned by an
 * app restart that happened after it started. Without this the row sits at
 * whatever non-terminal status it was last at (e.g. 'awaiting-approval')
 * until HealixStore.failOrphanedRuns() reaps it as 'error', hours later, even
 * though the user just explicitly told us what they wanted to happen to it.
 * Also appends the same Timeline event a live orchestrator would have logged
 * for this decision, so the run's history reads the same either way.
 */
async function forceSettleOrphanedRun(
  runId: string,
  status: 'cancelled' | 'error',
  eventMessage: string,
): Promise<void> {
  try {
    const store = await getStore();
    if (!store) return;
    store.appendEvent(runId, 'approve', eventMessage, { level: 'info' });
    store.updateRunStatus(runId, status, { finishedAt: new Date().toISOString() });
  } catch {
    /* best-effort — the janitor is the fallback if this fails too */
  }
}

ipcMain.handle(
  'run:approve',
  async (_e, payload: { runId: string } & PlanApprovalResult): Promise<{ settled: boolean }> => {
    if (!payload?.runId) return { settled: false };
    const result: PlanApprovalResult =
      payload.decision === 'proceed' ? { decision: 'proceed', plan: payload.plan } : { decision: 'cancel' };
    const settled = settleApproval(payload.runId, result);
    if (!settled) {
      // Rejecting/cancelling is a deliberate cancellation either way;
      // approving a run that can no longer actually resume never runs, which
      // is an error. Wording matches exactly what a live orchestrator logs
      // for the same decisions (packages/core/src/orchestrator/index.ts).
      await (result.decision === 'proceed'
        ? forceSettleOrphanedRun(
            payload.runId,
            'error',
            "Approved, but the run's session had already ended and it could not resume.",
          )
        : forceSettleOrphanedRun(payload.runId, 'cancelled', 'Plan rejected; cancelling run.'));
    }
    return { settled };
  },
);

ipcMain.handle('run:cancel', async (_e, payload: { runId: string }): Promise<{ cancelled: boolean }> => {
  const runId = payload?.runId;
  if (!runId) return { cancelled: false };
  // A parked approval gate would hold the orchestrator before it ever checks
  // the abort signal, so cancelling also rejects any pending plan approval.
  settleApproval(runId, { decision: 'cancel' });
  const controller = activeRuns.get(runId);
  if (!controller) {
    // Nothing live to abort — same orphaned-run situation as above. The user
    // explicitly asked to cancel it, so that's the status it gets. Wording
    // matches the live cancel path's own default message.
    await forceSettleOrphanedRun(runId, 'cancelled', 'Run cancelled by caller.');
    return { cancelled: false };
  }
  controller.abort();
  return { cancelled: true };
});

ipcMain.handle('run:pause', async (_e, payload: { runId: string }): Promise<{ paused: boolean }> => {
  const runId = payload?.runId;
  if (!runId) return { paused: false };
  // A parked approval gate would hold the orchestrator before it ever checks
  // the abort signal — same reasoning as run:cancel.
  settleApproval(runId, { decision: 'cancel' });
  const controller = activeRuns.get(runId);
  if (!controller) return { paused: false };
  // The reason string IS the signal: the orchestrator's isPauseRequested()
  // checks `signal.reason === 'pause'` to distinguish this from a plain cancel.
  controller.abort('pause');
  return { paused: true };
});

ipcMain.handle(
  'run:resume',
  async (
    event,
    payload: { runId: string },
  ): Promise<{ resumed: true; summary: RunSummary } | { resumed: false; reason: string }> => {
    const runId = payload?.runId;
    if (!runId) return { resumed: false, reason: 'A runId is required.' };

    const store = await requireStore();
    const run = store.getRun(runId);
    if (!run) return { resumed: false, reason: `No run found with id ${runId}.` };
    if (run.status !== 'paused') {
      return { resumed: false, reason: `Run is ${run.status}, not paused.` };
    }
    // Same "one run executes at a time" gate run:start enforces — resuming
    // doesn't get to cut in front of whatever is currently live.
    if (activeRuns.size > 0) {
      return { resumed: false, reason: 'Another run is currently active. Try again once it finishes.' };
    }

    // Mirrors run:start: block on the full run (the renderer already gets live
    // progress via the run:started/run:event/run:done push channels), then
    // let the queue advance once this one truly settles.
    const sender = event.sender;
    const summary = await resumeRun(runId, (channel, msg) => safeSend(sender, channel, msg));
    void startNextQueued();
    return { resumed: true, summary };
  },
);

/**
 * Same-run recovery for a completed run: regenerate whatever the Knowledge
 * Base flags as dropped, execute everything still pending, refresh the
 * report in place — no new run row. Mirrors resumeRun's shape (registers in
 * activeRuns so it shares the "one run executes at a time" gate, reuses
 * 'run:started' so the renderer's existing handler resets its live view for
 * this SAME runId instead of treating it as a new one). See
 * docs/design/retry-pass-coverage-kb-redesign.md.
 */
async function retryPassRun(
  runId: string,
  send: (channel: string, payload: unknown) => void,
): Promise<RunSummary> {
  const controller = new AbortController();
  activeRuns.set(runId, controller);

  const store = await requireStore();
  const run = store.getRun(runId);
  send('run:started', { runId, projectId: run?.projectId ?? 'unknown' });

  const orchestrator = createOrchestrator();
  const summary = await orchestrator
    .retryPass(
      runId,
      {
        onEvent: (e) => send('run:event', { runId, event: e }),
      },
      controller.signal,
    )
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      send('run:event', { runId, event: { phase: 'error', level: 'error', message } });
      const failed: RunSummary = { runId, status: 'error' };
      return failed;
    })
    .finally(() => {
      activeRuns.delete(runId);
    });

  send('run:done', { runId, summary });
  return summary;
}

ipcMain.handle(
  'run:retryPass',
  async (
    event,
    payload: { runId: string },
  ): Promise<{ ok: true; summary: RunSummary } | { ok: false; reason: string }> => {
    const runId = payload?.runId;
    if (!runId) return { ok: false, reason: 'A runId is required.' };

    const store = await requireStore();
    const run = store.getRun(runId);
    if (!run) return { ok: false, reason: `No run found with id ${runId}.` };
    // Same "one run executes at a time" gate run:start/run:resume enforce.
    if (activeRuns.size > 0) {
      return { ok: false, reason: 'Another run is currently active. Try again once it finishes.' };
    }

    const sender = event.sender;
    const summary = await retryPassRun(runId, (channel, msg) => safeSend(sender, channel, msg));
    void startNextQueued();
    return { ok: true, summary };
  },
);

/** Swallows the level param so resolveProvider's emit callback has somewhere harmless to go. */
function noopEmit(_phase: string, _level: 'debug' | 'info' | 'warn' | 'error', _message: string): void {
  /* no-op: revise-item is a one-off call, not worth a Timeline entry */
}

/**
 * Revise a single plan item with AI-incorporated human feedback, while the
 * run stays parked at the approval gate. Stateless beyond looking up the
 * project — no coupling to activeRuns/pendingApprovals, since this happens
 * independently of (and possibly concurrently with) the gate's own lifecycle.
 */
ipcMain.handle(
  'plan:reviseItem',
  async (
    _e,
    payload: { projectId: string; item: TestPlanItem; suggestion: string },
  ): Promise<{ ok: true; item: TestPlanItem } | { ok: false; detail: string }> => {
    if (!payload?.projectId || !payload.item || !payload.suggestion?.trim()) {
      return { ok: false, detail: 'projectId, item, and a non-empty suggestion are required.' };
    }
    const store = await requireStore();
    const project = store.getProject(payload.projectId);
    if (!project) return { ok: false, detail: `Project not found: ${payload.projectId}` };
    const provider = await resolveProvider(undefined, noopEmit);
    if (!provider) return { ok: false, detail: 'No ready provider available for revising this item.' };
    return reviseItem(provider, project, { projectId: payload.projectId }, payload.item, payload.suggestion);
  },
);

// ---- Suite export ----

ipcMain.handle(
  'export:suite',
  async (
    _e,
    args: { suiteDir: string; outDir?: string; sanitize?: boolean; zip?: boolean; projectId?: string },
  ) => {
    if (!args?.suiteDir) throw new Error('suiteDir is required to export a suite.');
    const outDir = args.outDir ?? join(projectsDir(), 'exports');
    // Thread the project's own test-login credentials through so sanitize can
    // redact literal occurrences of them (e.g. a hardcoded password in a
    // generated spec) — the generic KEY=value secret patterns don't catch that.
    const store = await getStore();
    const project = args.projectId ? store?.getProject(args.projectId) : undefined;
    const bundle = await exportSuite({
      suiteDir: args.suiteDir,
      outDir,
      sanitize: args.sanitize ?? true,
      zip: args.zip ?? true,
      // A url-token credential's secret lives in `token`, not `password` — pass
      // it through the same `password` slot so sanitize's literal-value
      // redaction (which only looks at username/password) still catches it.
      credentials: project?.credentials.map((c) => ({
        username: c.username,
        password: c.authType === 'url-token' ? c.token : c.password,
      })),
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

// ---- PRD file upload (native file picker + text extraction) ----

const PRD_FILE_FILTERS = [
  { name: 'All PRD files', extensions: ['pdf', 'doc', 'docx', 'md', 'txt', 'xlsx', 'xls', 'csv'] },
  { name: 'PRD documents', extensions: ['pdf', 'doc', 'docx', 'md', 'txt'] },
  { name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'csv'] },
];

const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);

export interface PickPrdFileResult {
  canceled: boolean;
  fileName?: string;
  text?: string;
  error?: string;
  /** True only when the workbook has more than one non-empty sheet and the renderer must show a picker. */
  needsSheetPicker?: boolean;
  /** Present alongside needsSheetPicker so the renderer's follow-up extractPrdSheets call knows which file to reread. */
  filePath?: string;
  /** Preview of every non-empty sheet, present alongside needsSheetPicker. */
  sheets?: SheetPreview[];
  /** Present when text came from a spreadsheet (single-sheet fast path or after picker selection). */
  sourceKind?: 'file' | 'spreadsheet';
  selectedSheets?: string[];
  /** Non-fatal notes (e.g. row-cap truncation) — distinct from `error`, which means the upload failed outright. */
  warnings?: string[];
}

export interface PreviewPrdSheetsResult {
  sheets?: SheetPreview[];
  error?: string;
}

export interface ExtractPrdSheetsResult {
  sheets?: { name: string; content: string }[];
  warnings?: string[];
  error?: string;
}

/** Extract plain text from an uploaded prose PRD file, used verbatim as acceptance criteria. */
async function extractPrdText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.txt':
    case '.md':
      return readFile(filePath, 'utf8');
    case '.docx':
      return (await mammoth.extractRawText({ path: filePath })).value;
    case '.pdf':
      return (await pdfParse(await readFile(filePath))).text;
    case '.doc':
      throw new Error(
        'Legacy .doc files are not supported — please save as .docx, .txt, or .md and try again.',
      );
    default:
      throw new Error(`Unsupported file type: ${ext || '(unknown)'}`);
  }
}

/** Joins extracted sheets into one PRD-ready string, labeling each under its own heading. */
function joinSheetsAsPrd(sheets: { name: string; content: string }[]): string {
  return sheets.map((s) => `--- Sheet: ${s.name} ---\n${s.content}`).join('\n\n');
}

ipcMain.handle('dialog:pickPrdFile', async (event: IpcMainInvokeEvent): Promise<PickPrdFileResult> => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const picked = win
    ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters: PRD_FILE_FILTERS })
    : await dialog.showOpenDialog({ properties: ['openFile'], filters: PRD_FILE_FILTERS });
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };

  const filePath = picked.filePaths[0];
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const ext = extname(filePath).toLowerCase();

  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    try {
      const sheets = await previewSheets(filePath);
      if (sheets.length === 0) {
        return { canceled: false, fileName, error: 'This file has no data to import.' };
      }
      if (sheets.length === 1) {
        // A CSV can never have more than one sheet, and a single-sheet workbook
        // doesn't need a picker either — go straight through, same shape as the
        // existing prose-file path.
        const { sheets: extracted, warnings } = await extractSheets(filePath, [sheets[0].name]);
        return {
          canceled: false,
          fileName,
          text: joinSheetsAsPrd(extracted),
          sourceKind: 'spreadsheet',
          selectedSheets: [sheets[0].name],
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }
      return { canceled: false, fileName, filePath, needsSheetPicker: true, sheets };
    } catch (err) {
      return { canceled: false, fileName, error: errMsg(err) };
    }
  }

  try {
    const text = (await extractPrdText(filePath)).trim();
    return { canceled: false, fileName, text, sourceKind: 'file' };
  } catch (err) {
    return { canceled: false, fileName, error: errMsg(err) };
  }
});

ipcMain.handle(
  'dialog:previewPrdSheets',
  async (_event: IpcMainInvokeEvent, filePath: string): Promise<PreviewPrdSheetsResult> => {
    try {
      return { sheets: await previewSheets(filePath) };
    } catch (err) {
      return { error: errMsg(err) };
    }
  },
);

ipcMain.handle(
  'dialog:extractPrdSheets',
  async (
    _event: IpcMainInvokeEvent,
    filePath: string,
    selectedSheetNames: string[],
  ): Promise<ExtractPrdSheetsResult> => {
    try {
      const { sheets, warnings } = await extractSheets(filePath, selectedSheetNames);
      return { sheets, warnings };
    } catch (err) {
      return { error: errMsg(err) };
    }
  },
);

// ---- Repo path folder picker (Project create/edit form) ----

export interface PickRepoPathResult {
  canceled: boolean;
  path?: string;
}

ipcMain.handle('dialog:pickRepoPath', async (event: IpcMainInvokeEvent): Promise<PickRepoPathResult> => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const picked = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: picked.filePaths[0] };
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

// ---- Claude per-task-type model/effort config (Settings page) ----

ipcMain.handle(
  'settings:getModelConfig',
  async (): Promise<{ defaults: ModelEffortConfig; overrides: ModelEffortOverrides }> => {
    const overrides = (await readModelConfigOverrides()) ?? {};
    return { defaults: DEFAULT_MODEL_CONFIG, overrides };
  },
);

ipcMain.handle(
  'settings:setModelConfig',
  async (_e, overrides: ModelEffortOverrides): Promise<{ ok: true }> => {
    await writeModelConfigOverrides(overrides ?? {});
    return { ok: true };
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
  /** The plan persisted to disk at plan/plan.json, when present. */
  plan: TestPlan | null;
  /**
   * The user-facing options (testingScope/suiteMode/provider/prd/instructions)
   * this run was started with, read from run-config.json — null when absent
   * (a run from before this feature existed, or the write failed).
   */
  runConfig: RunConfigSnapshot | null;
  /** Per-call token/cost usage captured during this run (plan/generate/triage) — feeds the Usage tab. */
  usage: UsageRow[];
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
    plan: null,
    runConfig: null,
    usage: [],
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
  let usage: UsageRow[] = [];
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
  try {
    usage = store.listUsageForRun(runId);
  } catch {
    usage = [];
  }

  // On-disk artifacts live under <projectsDir>/<projectId>/runs/<runId>/...
  // We need the projectId; prefer the run row, fall back to empty disk reads.
  let report: unknown | null = null;
  let suiteDir: string | null = null;
  let artifacts: string[] = [];
  let reportHtmlPath: string | null = null;
  let plan: TestPlan | null = null;
  let runConfig: RunConfigSnapshot | null = null;

  if (run) {
    const runDir = join(projectsDir(), run.projectId, 'runs', runId);
    report = await readJsonIfExists(join(runDir, 'reports', 'report.json'));
    const suite = join(runDir, 'suite');
    if (await isDir(suite)) suiteDir = suite;
    artifacts = await listFilesRecursive(join(runDir, 'suite', 'test-results'));
    const html = join(runDir, 'reports', 'report.html');
    if (await isFile(html)) reportHtmlPath = html;
    plan = (await readJsonIfExists(join(runDir, 'plan', 'plan.json'))) as TestPlan | null;
    runConfig = await readRunConfigSnapshot(runDir);
  }

  return { run, tests, results, events, report, suiteDir, artifacts, reportHtmlPath, plan, runConfig, usage };
});

/** Cross-run usage aggregation for the Reports/Usage page — omit projectId for every project. */
ipcMain.handle(
  'usage:crossRun',
  async (_e, payload: { projectId?: string } | undefined): Promise<UsageAggregate> => {
    const empty: UsageAggregate = { perRun: [], perPhase: [], perModel: [] };
    const store = await getStore();
    if (!store) return empty;
    try {
      return store.getUsageAggregate({ projectId: payload?.projectId });
    } catch {
      return empty;
    }
  },
);

/** Most recent fully-passed run for a project — drives the Suite Mode toggle's enable/disable state. */
ipcMain.handle('runs:lastSuccessful', async (_e, payload: { projectId: string }): Promise<Run | null> => {
  const store = await getStore();
  if (!store || !payload?.projectId) return null;
  try {
    return store.getLastSuccessfulRun(payload.projectId);
  } catch {
    return null;
  }
});

export interface SuiteDiffSummary {
  runId: string;
  baseRunId: string | null;
  addedCount: number;
  carriedCount: number;
  removedCount: number;
  totalCount: number;
}

/** Added/carried/removed test counts for one run vs. the run it topped-up/reused from, computed on read. */
ipcMain.handle('runs:suiteDiff', async (_e, payload: { runId: string }): Promise<SuiteDiffSummary | null> => {
  const store = await getStore();
  if (!store || !payload?.runId) return null;
  const run = store.getRun(payload.runId);
  if (!run) return null;

  const tests = store.listTests(run.id);
  const totalCount = tests.length;
  if (!run.baseRunId) {
    return {
      runId: run.id,
      baseRunId: null,
      addedCount: totalCount,
      carriedCount: 0,
      removedCount: 0,
      totalCount,
    };
  }

  const baseTests = store.listTests(run.baseRunId);
  const baseKeys = new Set(baseTests.map((t) => computeIdentityKey(t.reqTag, t.title)));
  const thisKeys = new Set(tests.map((t) => computeIdentityKey(t.reqTag, t.title)));

  let addedCount = 0;
  let carriedCount = 0;
  for (const t of tests) {
    if (baseKeys.has(computeIdentityKey(t.reqTag, t.title))) carriedCount += 1;
    else addedCount += 1;
  }
  let removedCount = 0;
  for (const key of baseKeys) {
    if (!thisKeys.has(key)) removedCount += 1;
  }

  return { runId: run.id, baseRunId: run.baseRunId, addedCount, carriedCount, removedCount, totalCount };
});

/**
 * Plan items from this run's OWN plan.json that either never got a matching
 * test row (generation silently dropped) or never got EXECUTED (a spec was
 * generated but the run errored out before its result was recorded — see
 * matchGenerationGaps's doc comment for the full 'pending'-status
 * reasoning). Feeds the results-page Retry-pass button. See
 * matchGenerationGaps (repair-candidates.js) for why this matches by
 * id/reqTag directly rather than via topup.ts's diffAgainstBase.
 */
ipcMain.handle(
  'runs:generationGaps',
  async (_e, payload: { runId: string }): Promise<GenerationGapItem[]> => {
    const store = await getStore();
    if (!store || !payload?.runId) return [];
    const run = store.getRun(payload.runId);
    if (!run) return [];

    const runDir = join(projectsDir(), run.projectId, 'runs', run.id);
    const plan = (await readJsonIfExists(join(runDir, 'plan', 'plan.json'))) as TestPlan | null;
    if (!plan || plan.items.length === 0) return [];

    return matchGenerationGaps(plan, store.listTests(run.id));
  },
);

/**
 * Plan items from this run whose test was triaged 'test_is_wrong' — feeds
 * the results-page Repair button, which reuses Retry-pass's exact
 * retryItemIds mechanism with this as its candidate source.
 */
ipcMain.handle(
  'runs:repairCandidates',
  async (_e, payload: { runId: string }): Promise<GenerationGapItem[]> => {
    const store = await getStore();
    if (!store || !payload?.runId) return [];
    const run = store.getRun(payload.runId);
    if (!run) return [];

    const runDir = join(projectsDir(), run.projectId, 'runs', run.id);
    const plan = (await readJsonIfExists(join(runDir, 'plan', 'plan.json'))) as TestPlan | null;
    if (!plan || plan.items.length === 0) return [];

    const wrongTestIds = new Set(
      store
        .listTriageResults(run.id)
        .filter((t) => t.verdict === 'test_is_wrong')
        .map((t) => t.testId),
    );
    if (wrongTestIds.size === 0) return [];

    return matchRepairCandidates(plan, store.listTests(run.id), wrongTestIds);
  },
);

/**
 * Delete a single historical run: its DB rows (tests/results/agent_events,
 * cascaded by store.deleteRun) plus its on-disk assets (suite, plan, reports,
 * artifacts). Refuses a run that's currently executing — its orchestrator has
 * no idea the row it's about to write to just vanished, and cancelling first
 * is the well-defined path (mirrors run:cancel) rather than racing a delete
 * against in-flight store writes.
 */
ipcMain.handle(
  'runs:delete',
  async (_e, payload: { runId: string }): Promise<{ ok: true; assetsRemoved: boolean }> => {
    const store = await requireStore();
    const runId = payload?.runId;
    if (!runId) throw new Error('Run id is required.');
    if (activeRuns.has(runId)) {
      throw new Error('This run is still executing — cancel it before deleting.');
    }

    const run = store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    store.deleteRun(runId);

    let assetsRemoved = true;
    try {
      await deleteRunAssets(run.projectId, runId);
    } catch {
      assetsRemoved = false;
    }
    return { ok: true, assetsRemoved };
  },
);

export interface TestCaseHistoryEntry {
  runId: string;
  runCreatedAt: string;
  suiteMode: SuiteMode | null;
  status: TestCase['status'];
  durationMs: number | null;
  specPath: string | null;
}

export interface TestCaseHistory {
  identityKey: string;
  currentTitle: string;
  reqTag: string | null;
  runHistory: TestCaseHistoryEntry[];
}

/**
 * One test's lineage + pass/fail history: walks the base_run_id chain
 * backward from the project's most recent run, matching a test by identity
 * key (reqTag, else normalized title) at each link. The chain only extends as
 * far back as an unbroken top-up/reuse lineage permits — a 'fresh' run has no
 * base_run_id, so history naturally stops there.
 */
ipcMain.handle(
  'runs:caseHistory',
  async (_e, payload: { projectId: string; reqTag?: string; title?: string }): Promise<TestCaseHistory> => {
    const empty: TestCaseHistory = { identityKey: '', currentTitle: '', reqTag: null, runHistory: [] };
    if (!payload?.projectId || (!payload.reqTag && !payload.title)) return empty;
    const store = await getStore();
    if (!store) return empty;

    const targetKey = computeIdentityKey(payload.reqTag ?? null, payload.title ?? '');
    const runs = store.listRuns(payload.projectId); // newest-first
    if (runs.length === 0) return empty;

    const byId = new Map(runs.map((r) => [r.id, r]));
    const chain: Run[] = [];
    let current: Run | undefined = runs[0];
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current = current.baseRunId ? byId.get(current.baseRunId) : undefined;
    }

    const runHistory: TestCaseHistoryEntry[] = [];
    let currentTitle = '';
    let reqTag: string | null = null;
    for (const run of chain) {
      const tests = store.listTests(run.id);
      const match = tests.find((t) => computeIdentityKey(t.reqTag, t.title) === targetKey);
      if (!match) continue;
      if (!currentTitle) {
        currentTitle = match.title;
        reqTag = match.reqTag;
      }
      const result = store.listResults(run.id).find((r) => r.testId === match.id);
      runHistory.push({
        runId: run.id,
        runCreatedAt: run.createdAt,
        suiteMode: run.suiteMode,
        status: match.status,
        durationMs: result?.durationMs ?? null,
        specPath: match.specPath,
      });
    }

    return { identityKey: targetKey, currentTitle, reqTag, runHistory };
  },
);

const METRICS_TREND_LIMIT = 20;

export interface ProjectMetrics {
  totalRuns: number;
  lastRunAt: string | null;
  /** Test count of the project's most recent run (any status), i.e. the current suite size. */
  latestRunTestCount: number;
  /** 0..1 over the trend window below; null when no results exist yet. */
  passRate: number | null;
  /** Oldest → newest, capped to the most recent METRICS_TREND_LIMIT runs. */
  failureTrend: Array<{
    runId: string;
    runCreatedAt: string;
    passed: number;
    failed: number;
    blocked: number;
    total: number;
  }>;
}

/** Project-level metrics for the dashboard Overview tab — pure aggregation over existing tables, no new schema. */
ipcMain.handle(
  'runs:projectMetrics',
  async (_e, payload: { projectId: string }): Promise<ProjectMetrics | null> => {
    const store = await getStore();
    if (!store || !payload?.projectId) return null;

    const runs = store.listRuns(payload.projectId); // newest-first
    const totalRuns = runs.length;
    const lastRunAt = runs[0]?.createdAt ?? null;
    const latestRunTestCount = runs[0] ? store.listTests(runs[0].id).length : 0;

    const failureTrend = runs
      .slice(0, METRICS_TREND_LIMIT)
      .map((run) => {
        const results = store.listResults(run.id);
        return {
          runId: run.id,
          runCreatedAt: run.createdAt,
          passed: results.filter((r) => r.status === 'passed').length,
          failed: results.filter((r) => r.status === 'failed').length,
          blocked: results.filter((r) => r.status === 'blocked').length,
          total: results.length,
        };
      })
      .reverse();

    const totalResults = failureTrend.reduce((n, t) => n + t.total, 0);
    const totalPassed = failureTrend.reduce((n, t) => n + t.passed, 0);
    const passRate = totalResults > 0 ? totalPassed / totalResults : null;

    return { totalRuns, lastRunAt, latestRunTestCount, passRate, failureTrend };
  },
);

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
function waitForApproval(runId: string, sender: WebContents): Promise<PlanApprovalResult> {
  return new Promise<PlanApprovalResult>((resolve) => {
    // If a stale gate somehow exists for this id, reject it first.
    settleApproval(runId, { decision: 'cancel' });

    // If the window is torn down while we wait, fail closed.
    const onDestroyed = (): void => {
      settleApproval(runId, { decision: 'cancel' });
    };

    // Wrap resolve so settling the gate (approve, reject, or destroy) also
    // detaches the 'destroyed' listener. Without this, a normally-approved run
    // leaves a dead listener on the long-lived window every time — after enough
    // runs Node emits MaxListenersExceededWarning and each closure leaks.
    const settle = (result: PlanApprovalResult): void => {
      sender.removeListener('destroyed', onDestroyed);
      resolve(result);
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

/**
 * Boot-time reconciliation: fully automatic, no confirmation prompt (a paused
 * run just quietly picks back up). Three cases, in order:
 *
 * 1. Runs already cleanly 'paused' for a non-manual reason (network/credits —
 *    see HealixStore.listAutoResumableRuns()) from a PRIOR session: resume
 *    each directly. A 'manual' pause is never touched here — the user must
 *    resume it themselves.
 * 2. Runs still showing an in-flight status (planning/generating/…) with a
 *    checkpoint surviving on disk — the process driving them is gone
 *    (crash/quit) before it could mark them 'paused' itself, but there IS
 *    something to pick back up: claim the row as 'paused'/'crashed' and
 *    resume it.
 * 3. Runs still in-flight with NO checkpoint — e.g. the app was closed mid
 *    PLAN, before GENERATE ever got a chance to write one. There is nothing
 *    to resume from (redoing PLAN from scratch is just... starting over), so
 *    unlike case 2 this fails the row immediately instead of leaving it
 *    stuck showing a live-looking status indefinitely (previously this fell
 *    through to failOrphanedRuns()'s 6-HOUR age buffer, which reads as
 *    "auto-resume is broken" to anyone testing this within the same hour).
 *
 * Runs strictly one at a time: each resumeRun() call is awaited fully before
 * the next one starts, so at most one auto-resume (and therefore at most one
 * orchestrator pipeline / Playwright invocation) is ever active from this
 * pass. Any run:start request that arrives mid-batch correctly queues itself
 * behind whichever resume is currently active (see run:start's activeRuns
 * gate) and is drained once, after the whole batch settles.
 */
async function reconcileRunsOnBoot(): Promise<void> {
  const store = await getStore();
  if (!store) return;

  // The "figure out what needs attention" half now lives in @healix/core (see
  // reconcileRuns's doc comment) so the CLI can run the exact same
  // reconciliation — this function keeps only the desktop-specific half:
  // actually driving each returned run through resume(), broadcast over IPC,
  // and respecting the single-active-run queue.
  const { toResume, markedError, orphansReaped } = await reconcileRuns(store);
  if (markedError > 0) {
    console.log(
      `[healix] boot: marked ${markedError} uncheckpointed in-flight run(s) as error (nothing to resume from).`,
    );
  }

  // Resumed strictly one at a time: resumeRun() registers into `activeRuns`
  // as soon as it starts, and every other run-starting path in this file
  // enforces "one run executes at a time" (see run:start's activeRuns.size
  // gate) because every run shares the single live-browser mirror surface and
  // fixed local ports. Firing all of these concurrently would violate that
  // invariant.
  for (const run of toResume) {
    console.log(`[healix] auto-resuming run ${run.id} (paused: ${run.pauseReason ?? 'unknown'}).`);
    try {
      await resumeRun(run.id, (channel, payload) => broadcastAll(channel, payload));
    } catch (err) {
      console.error(`[healix] auto-resume of run ${run.id} failed:`, err);
    }
  }
  // Drain any run:start requests that queued (behind activeRuns) while the
  // above was resuming — exactly once, after the whole batch, not per
  // iteration: draining mid-loop could let a queued run start concurrently
  // with the NEXT boot-time resume, reintroducing the same bug in a new spot.
  if (toResume.length > 0) void startNextQueued();

  if (orphansReaped > 0) console.log(`[healix] janitor: marked ${orphansReaped} orphaned run(s) as error`);
}

app.whenReady().then(() => {
  registerArtifactProtocol();
  // Best-effort and fire-and-forget so a missing/broken store never blocks
  // window creation.
  void reconcileRunsOnBoot().catch(() => {
    /* storage unavailable — nothing to reconcile */
  });
  applyDevDockIcon();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
