import type { ProviderAdapter } from '../providers/types.js';
import type { TargetAdapter } from '../target/types.js';
import type { BrowserSurface, DomSnapshot } from '../browser/types.js';
import type { ModeId, Tier, TestStatus } from '../storage/types.js';

export type ExplorationMode = 'computer-use' | 'codegen';

/**
 * User-facing testing scope: what to test, as opposed to ExplorationMode
 * (how to explore it), which is now derived internally from the project's
 * config rather than chosen directly. Controls which tiers get planned,
 * generated, and executed.
 */
export type TestingScope = 'frontend' | 'backend' | 'both';

/** Tiers in scope for a given TestingScope selection. */
export function tiersForScope(scope: TestingScope): Tier[] {
  switch (scope) {
    case 'frontend':
      return ['tierA-public', 'tierB-auth'];
    case 'backend':
      return ['tierC-api'];
    case 'both':
      return ['tierA-public', 'tierB-auth', 'tierC-api'];
  }
}

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
  /** Login identifier (username or email) for authenticated (tierB) flows. */
  testUsername?: string | null;
  testPassword?: string | null;
  provider: ProviderAdapter;
  target: TargetAdapter;
  browser: BrowserSurface;
  explorationMode?: ExplorationMode;
  /** Which tiers this run is in scope for; drives generation and execution. */
  testingScope?: TestingScope;
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
