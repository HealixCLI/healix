import { notImplemented } from '../util/not-implemented.js';
import type { DetectedProject, LaunchHandle, LaunchOptions, RepoIndex, TargetAdapter, UrlProbe } from './types.js';

export * from './types.js';

/** Foundation stub — real detection/launch/index implemented in M1 (target/ module). */
export function createTargetAdapter(): TargetAdapter {
  return {
    detect(_repoPath: string): Promise<DetectedProject> {
      return notImplemented('TargetAdapter.detect');
    },
    indexRepo(_repoPath: string, _opts?: { maxFiles?: number }): Promise<RepoIndex> {
      return notImplemented('TargetAdapter.indexRepo');
    },
    launch(_opts: LaunchOptions): Promise<LaunchHandle> {
      return notImplemented('TargetAdapter.launch');
    },
    probeUrl(_url: string, _timeoutMs?: number): Promise<UrlProbe> {
      return notImplemented('TargetAdapter.probeUrl');
    },
  };
}
