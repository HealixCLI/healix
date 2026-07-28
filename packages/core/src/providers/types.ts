/**
 * Shared absolute ceiling for a single provider call, used as the hard-cap
 * `timeoutMs` by every call site that doesn't need a tighter one of its own.
 * This is deliberately generous: the day-to-day enforcement is each adapter's
 * own sliding-window idle timeout (killed only after a stretch with NO output
 * activity — see claude.ts), which lets a slow-but-actively-streaming call run
 * as long as it needs to. This backstop exists only to bound a genuinely
 * pathological call that never goes idle but also never finishes (e.g. an
 * infinite tool-use loop) — a case the idle timer alone can't detect since
 * such a call still "looks" alive. It should rarely, if ever, be the thing
 * that actually fires.
 */
export const ABSOLUTE_BACKSTOP_MS = 25 * 60_000;

export type ProviderId = 'claude' | 'openai';

export type ProviderStatus = 'ready' | 'cli-missing' | 'not-authenticated' | 'error';

export type Capability = 'computer-use' | 'codegen' | 'plan' | 'triage';

/**
 * Identifies which of Healix's fixed set of AI call sites a request is for,
 * so an adapter can resolve a per-task-type model/effort (see
 * providers/model-config.ts) instead of always using one CLI default.
 */
export type TaskType =
  | 'plan-generate'
  | 'plan-gapfill'
  | 'plan-revise-item'
  | 'codegen'
  | 'mock-response'
  | 'triage'
  | 'triage-summary'
  | 'health-probe';

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
  /** Resolved model/effort actually used, when the adapter supports task-type routing (Claude only, for now). */
  model?: string;
  effort?: string;
}

export interface CompletionResult {
  provider: ProviderId;
  ok: boolean;
  text: string;
  raw: unknown;
  detail: string;
  /** Resolved model/effort actually used, when the adapter supports task-type routing (Claude only, for now). */
  model?: string;
  effort?: string;
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
  /** Which fixed AI call site this is, for per-task-type model/effort resolution. */
  taskType?: TaskType;
}

export interface PlanOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Which fixed AI call site this is, for per-task-type model/effort resolution. */
  taskType?: TaskType;
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
  plan(task: string, opts?: PlanOptions): Promise<PlanResult>;
  /** General-purpose prompt → text completion (used by test modes, orchestrator, triage). */
  complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult>;
}
