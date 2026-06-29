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
  | { channel: 'run:frame'; payload: { runId: string; pngBase64: string } };

const RUN_CHANNELS = ['run:started', 'run:event', 'run:plan', 'run:done', 'run:frame'] as const;

const api = {
  // existing
  doctor: (args?: { probe?: boolean }) => ipcRenderer.invoke('healix:doctor', args),
  providers: () => ipcRenderer.invoke('healix:providers'),

  // provider auth
  providerLogin: (id: 'claude' | 'openai') =>
    ipcRenderer.invoke('provider:login', { id }),
  providerHealth: (id: 'claude' | 'openai', probe?: boolean) =>
    ipcRenderer.invoke('provider:health', { id, probe }),

  // projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (input: {
    name: string;
    mode?: string;
    repoPath?: string | null;
    baseUrl?: string | null;
  }) => ipcRenderer.invoke('projects:create', input),
  deleteProject: (id: string) => ipcRenderer.invoke('projects:delete', id),

  // runs
  startRun: (args: {
    projectId: string;
    mode?: string;
    provider?: string;
    autoApprove?: boolean;
    prd?: string;
  }) => ipcRenderer.invoke('run:start', args),
  approveRun: (runId: string, ok: boolean) =>
    ipcRenderer.invoke('run:approve', { runId, ok }),
  listRuns: (projectId?: string) => ipcRenderer.invoke('runs:list', { projectId }),
  runDetail: (runId: string) => ipcRenderer.invoke('runs:detail', { runId }),

  // export / shell
  exportSuite: (args: { suiteDir: string; outDir?: string; sanitize?: boolean; zip?: boolean }) =>
    ipcRenderer.invoke('export:suite', args),
  revealPath: (target: string) => ipcRenderer.invoke('shell:reveal', target),

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
