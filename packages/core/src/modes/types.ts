import type { ProviderAdapter } from '../providers/types.js';
import type { TargetAdapter } from '../target/types.js';
import type { BrowserSurface, DomSnapshot } from '../browser/types.js';
import type { ModeId, Tier, TestStatus } from '../storage/types.js';

export type ExplorationMode = 'computer-use' | 'codegen';

export interface TestPlanItem {
  id: string;
  title: string;
  reqTag?: string;
  tier: Tier;
  intent: string;
}

export interface TestPlan {
  summary: string;
  items: TestPlanItem[];
  raw?: unknown;
}

export interface GeneratedSpec {
  path: string;
  title: string;
  reqTag?: string;
  tier: Tier;
  contents: string;
}

export interface ExecResultItem {
  title: string;
  status: TestStatus;
  durationMs?: number;
  error?: string;
  artifacts?: string[];
}

export interface ExecOutcome {
  passed: number;
  failed: number;
  blocked: number;
  flaky: number;
  results: ExecResultItem[];
  raw?: unknown;
}

export interface SuiteBundle {
  dir: string;
  zipPath?: string;
  files: string[];
}

export interface TestModeContext {
  /** Working directory where the runnable suite is scaffolded/generated. */
  projectDir: string;
  repoPath?: string | null;
  baseUrl?: string | null;
  provider: ProviderAdapter;
  target: TargetAdapter;
  browser: BrowserSurface;
  explorationMode?: ExplorationMode;
  /** DOM snapshot captured during computer-use exploration; grounds generation. */
  snapshot?: DomSnapshot;
  emit?: (phase: string, message: string, data?: unknown) => void;
  /** Cooperative cancellation for long mode phases (generate/execute). */
  signal?: AbortSignal;
}

/** Pluggable test engine. PlaywrightMode ships first; Selenium/XYZ follow. */
export interface TestMode {
  readonly id: ModeId;
  scaffold(ctx: TestModeContext): Promise<void>;
  generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]>;
  execute(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome>;
  collectArtifacts(ctx: TestModeContext): Promise<{ dir: string; files: string[] }>;
  export(ctx: TestModeContext): Promise<SuiteBundle>;
}
