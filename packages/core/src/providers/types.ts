export type ProviderId = 'claude' | 'openai';

export type ProviderStatus = 'ready' | 'cli-missing' | 'not-authenticated' | 'error';

export type Capability = 'computer-use' | 'codegen' | 'plan' | 'triage';

export interface DetectResult {
  installed: boolean;
  binPath: string | null;
  version: string | null;
}

export interface HealthResult {
  provider: ProviderId;
  status: ProviderStatus;
  installed: boolean;
  binPath: string | null;
  version: string | null;
  authenticated: boolean;
  model: string | null;
  latencyMs: number | null;
  detail: string;
}

export interface PlanResult {
  provider: ProviderId;
  ok: boolean;
  plan: string;
  raw: unknown;
  detail: string;
}

export interface CompletionResult {
  provider: ProviderId;
  ok: boolean;
  text: string;
  raw: unknown;
  detail: string;
}

export interface CompleteOptions {
  /** 'plan' runs the provider in plan/approval mode; 'default' executes normally. */
  mode?: 'default' | 'plan';
  timeoutMs?: number;
  /** Working directory to run the provider in (e.g. the target repo for white-box context). */
  cwd?: string;
  /**
   * When true the provider MUST NOT modify the filesystem while completing.
   * Adapters map this to their strongest no-write mode (Claude: --permission-mode
   * plan; Codex: its read-only sandbox). Distinct from mode:'plan' — readOnly
   * requests a normal completion, just guaranteed side-effect free, which is
   * what triage/analysis over a user's working tree needs.
   */
  readOnly?: boolean;
  /**
   * Cooperative cancellation. Aborting kills the underlying CLI process tree;
   * the adapter still RESOLVES (never rejects) with ok:false and an
   * abort-flavoured detail, matching the resolve-only runCli contract.
   */
  signal?: AbortSignal;
}

export interface HealthOptions {
  /** Perform a live round-trip to verify auth (default true). */
  probe?: boolean;
  timeoutMs?: number;
  /** Cooperative cancellation for the underlying CLI probe (see CompleteOptions.signal). */
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: Capability[];
  detect(): Promise<DetectResult>;
  health(opts?: HealthOptions): Promise<HealthResult>;
  plan(task: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlanResult>;
  /** General-purpose prompt → text completion (used by test modes, orchestrator, triage). */
  complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult>;
}
