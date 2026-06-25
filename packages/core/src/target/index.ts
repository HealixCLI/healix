import type { TargetAdapter } from './types.js';
import { detect } from './detector.js';
import { indexRepo } from './repo-index.js';
import { launch } from './launcher.js';
import { probeUrl } from './http-probe.js';

export * from './types.js';

/**
 * White-box (repo) + black-box (URL) access to the app under test.
 *
 * Composed from focused modules:
 *  - detector.ts   -> detect(): framework / package manager / start command / port
 *  - repo-index.ts -> indexRepo(): bounded file list + summary for AI context
 *  - launcher.ts   -> launch(): spawn + readiness-poll + process-tree teardown
 *  - http-probe.ts -> probeUrl(): non-throwing HTTP reachability check
 */
export function createTargetAdapter(): TargetAdapter {
  return {
    detect,
    indexRepo,
    launch,
    probeUrl,
  };
}
