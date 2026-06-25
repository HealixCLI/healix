import { notImplemented } from '../util/not-implemented.js';
import type { Orchestrator, OrchestratorHooks, RunOptions, RunSummary } from './types.js';

export * from './types.js';

/** Foundation stub — real state machine implemented in M1 (orchestrator module). */
export function createOrchestrator(): Orchestrator {
  return {
    run(_opts: RunOptions, _hooks?: OrchestratorHooks): Promise<RunSummary> {
      return notImplemented('Orchestrator.run');
    },
  };
}
