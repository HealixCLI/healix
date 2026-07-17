import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * Run lifecycle messages pushed from the main process. These mirror the
 * payloads sent in src/main/index.ts. Kept structural (no @healix/core import)
 * so the preload bundle stays light; the renderer's env.d.ts holds rich types.
 */
export type RunChannelMessage =
  | { channel: 'run:started'; payload: { runId: string; projectId: string } }
  | { channel: 'run:event'; payload: { runId: string; event: unknown } }
  | { channel: 'run:plan'; payload: { runId: string; plan: unknown } }
  | { channel: 'run:done'; payload: { runId: string; summary: unknown } }
  // Live browser mirror frame (JPEG, base64) for computer-use runs.
  | { channel: 'run:frame'; payload: { runId: string; frameBase64: string } }
  // Broadcast to every window whenever the pending-run queue changes.
  | { channel: 'queue:updated'; payload: { queue: unknown[] } }
  // Broadcast to every window when a queued run fails to start (before it ever got its own runId).
  | { channel: 'queue:failed'; payload: { message: string } };

const RUN_CHANNELS = [
  'run:started',
  'run:event',
  'run:plan',
  'run:done',
  'run:frame',
  'queue:updated',
  'queue:failed',
] as const;

const api = {
  // existing
  doctor: (args?: { probe?: boolean }) => ipcRenderer.invoke('healix:doctor', args),
  providers: () => ipcRenderer.invoke('healix:providers'),

  // provider auth
  providerLogin: (id: 'claude' | 'openai') => ipcRenderer.invoke('provider:login', { id }),
  providerHealth: (id: 'claude' | 'openai', probe?: boolean) =>
    ipcRenderer.invoke('provider:health', { id, probe }),

  // projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (input: {
    name: string;
    mode?: string;
    repoPath?: string | null;
    baseUrl?: string | null;
    testUsername?: string | null;
    testPassword?: string | null;
  }) => ipcRenderer.invoke('projects:create', input),
  updateProject: (
    id: string,
    input: {
      name: string;
      mode?: string;
      repoPath?: string | null;
      baseUrl?: string | null;
      testUsername?: string | null;
      testPassword?: string | null;
    },
  ) => ipcRenderer.invoke('projects:update', { id, ...input }),
  deleteProject: (id: string) => ipcRenderer.invoke('projects:delete', id),
  archiveProject: (id: string, archived: boolean) => ipcRenderer.invoke('projects:archive', { id, archived }),

  // runs
  startRun: (args: {
    projectId: string;
    testingScope?: string;
    provider?: string;
    autoApprove?: boolean;
    prd?: string;
    instructions?: string;
    suiteMode?: string;
    baseRunId?: string;
  }) => ipcRenderer.invoke('run:start', args),
  approveRun: (runId: string, decision: { decision: 'cancel' } | { decision: 'proceed'; plan: unknown }) =>
    ipcRenderer.invoke('run:approve', { runId, ...decision }),
  cancelRun: (runId: string) => ipcRenderer.invoke('run:cancel', { runId }),
  pauseRun: (runId: string) => ipcRenderer.invoke('run:pause', { runId }),
  resumeRun: (runId: string) => ipcRenderer.invoke('run:resume', { runId }),
  getActiveRun: () => ipcRenderer.invoke('run:active'),

  // run queue (requests that arrived while another run was executing)
  listQueue: () => ipcRenderer.invoke('queue:list'),
  queueRemove: (queueEntryId: string) => ipcRenderer.invoke('queue:remove', { queueEntryId }),

  listRuns: (projectId?: string) => ipcRenderer.invoke('runs:list', { projectId }),
  runDetail: (runId: string) => ipcRenderer.invoke('runs:detail', { runId }),
  deleteRun: (runId: string) => ipcRenderer.invoke('runs:delete', { runId }),
  lastSuccessfulRun: (projectId: string) => ipcRenderer.invoke('runs:lastSuccessful', { projectId }),
  suiteDiff: (runId: string) => ipcRenderer.invoke('runs:suiteDiff', { runId }),
  caseHistory: (projectId: string, key: { reqTag?: string; title?: string }) =>
    ipcRenderer.invoke('runs:caseHistory', { projectId, ...key }),
  projectMetrics: (projectId: string) => ipcRenderer.invoke('runs:projectMetrics', { projectId }),

  // per-item plan revision (AI-regenerates one item from human feedback)
  reviseItem: (args: { projectId: string; item: unknown; suggestion: string }) =>
    ipcRenderer.invoke('plan:reviseItem', args),

  // export / shell
  exportSuite: (args: { suiteDir: string; outDir?: string; sanitize?: boolean; zip?: boolean }) =>
    ipcRenderer.invoke('export:suite', args),
  revealPath: (target: string) => ipcRenderer.invoke('shell:reveal', target),
  showItemInFolder: (target: string) => ipcRenderer.invoke('shell:showItem', target),

  // PRD file upload (native picker + text extraction, main-process side)
  pickPrdFile: () => ipcRenderer.invoke('dialog:pickPrdFile'),

  // Repo path folder picker (Project create/edit form)
  pickRepoPath: () => ipcRenderer.invoke('dialog:pickRepoPath'),

  /**
   * Subscribe to the full run lifecycle. The callback receives a discriminated
   * message ({ channel, payload }). Returns an unsubscribe function that detaches
   * every underlying listener — call it on component unmount to avoid leaks.
   */
  onRunEvent: (cb: (msg: RunChannelMessage) => void): (() => void) => {
    const disposers = RUN_CHANNELS.map((channel) => {
      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        cb({ channel, payload } as RunChannelMessage);
      };
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    });
    return () => disposers.forEach((dispose) => dispose());
  },
};

contextBridge.exposeInMainWorld('healix', api);

export type HealixApi = typeof api;
