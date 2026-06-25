import type { ModeId } from '../storage/types.js';
import type { TestMode } from './types.js';
import { createPlaywrightMode } from './playwright/index.js';

export * from './types.js';

const factories: Partial<Record<string, () => TestMode>> = {
  playwright: createPlaywrightMode,
};

/** Resolve a test-engine plugin by id. */
export function getTestMode(id: ModeId): TestMode {
  const factory = factories[id];
  if (!factory) {
    throw new Error(`[healix] Unknown test mode "${id}". Available: ${Object.keys(factories).join(', ')}`);
  }
  return factory();
}

export function availableModes(): ModeId[] {
  return Object.keys(factories);
}
