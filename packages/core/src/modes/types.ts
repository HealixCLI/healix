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
  /** Already-covered REQ tags the plan says are affected by recent code changes (stale candidates). */
  impactedReqTags?: string[];
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
  /**
   * Extra HEALIX_* env vars for suite subprocesses (e.g. Tier-B credentials
   * resolved from .healix/config.json). Non-HEALIX_ keys are ignored by the
   * execute-phase allowlist.
   */
  extraEnv?: Record<string, string>;
}

/** Options for a (re-)execution pass. */
export interface ExecuteOptions {
  /** Restrict the run to these spec paths (relative to projectDir). Empty/undefined = full suite. */
  only?: string[];
  /** Restrict the run to these Playwright projects (their dependencies still run). */
  projects?: string[];
}

/** Pluggable test engine. PlaywrightMode ships first; Selenium/XYZ follow. */
export interface TestMode {
  readonly id: ModeId;
  scaffold(ctx: TestModeContext): Promise<void>;
  generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]>;
  execute(ctx: TestModeContext, specs: GeneratedSpec[], opts?: ExecuteOptions): Promise<ExecOutcome>;
  collectArtifacts(ctx: TestModeContext): Promise<{ dir: string; files: string[] }>;
  export(ctx: TestModeContext): Promise<SuiteBundle>;
  /**
   * Optional self-heal: rewrite ONE defective generated spec given its runtime
   * error (validated through the same gates as generation). Returns the
   * repaired spec, or null when no safe repair was produced. Only invoked for
   * failures triaged as test defects — never to mask an app defect.
   */
  repair?(ctx: TestModeContext, spec: GeneratedSpec, error: string): Promise<GeneratedSpec | null>;
  /**
   * Optional auth-setup self-heal: the login step failed (credentials ARE
   * configured), dooming every dependent authenticated test. Regenerate the
   * login flow from a fresh look at the live login page and rewrite the setup
   * file. Returns true when a repaired setup was written (caller re-runs the
   * authenticated project), false when no safe repair was produced.
   */
  repairAuthSetup?(ctx: TestModeContext, error: string): Promise<boolean>;
}
