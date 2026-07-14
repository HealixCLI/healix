// Public API for @healix/core

// Providers
export * from './providers/types.js';
export { ClaudeProvider } from './providers/claude.js';
export { OpenAIProvider } from './providers/openai.js';
export { ProviderRouter } from './providers/router.js';

// Doctor / facade
export { doctor, type DoctorReport } from './healix.js';

// Storage
export { openDb, dbInfo, type DbInfo } from './storage/db.js';
export { resetDbForTests } from './storage/db.js';
export { SCHEMA_VERSION } from './storage/schema.js';
export { HealixStore, getStore } from './storage/store.js';
export { resetStoreForTests } from './storage/store.js';
export {
  validateNewProject,
  isValidBaseUrl,
  type NewProjectValidation,
  type NormalizedNewProject,
} from './storage/validate.js';
export * from './storage/types.js';

// Target adapter (white-box / black-box)
export { createTargetAdapter } from './target/index.js';
export * from './target/types.js';
export { isGitRemoteUrl, cloneRepo, type CloneRepoResult } from './target/clone.js';

// Browser surface (computer-use + browser-use)
export { createBrowserSurface } from './browser/index.js';
export * from './browser/types.js';

// Test modes (pluggable engines)
export { getTestMode, availableModes } from './modes/registry.js';
export { createPlaywrightMode } from './modes/playwright/index.js';
export * from './modes/types.js';

// Orchestrator
export { createOrchestrator } from './orchestrator/index.js';
export * from './orchestrator/types.js';

// Suite export
export { exportSuite, type ExportOptions } from './export/index.js';

// Failure triage
export { createTriageEngine } from './triage/index.js';
export * from './triage/types.js';

// Env + utilities
export {
  appDataDir,
  ensureAppDataDir,
  dbPath,
  projectsDir,
  reposDir,
  deleteProjectAssets,
} from './env/app-data.js';
export { logger, setLogLevel, type LogLevel } from './logger.js';
export { runCli, which, type RunResult } from './exec/run-cli.js';
export { notImplemented } from './util/not-implemented.js';
