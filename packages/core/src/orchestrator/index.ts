import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { projectsDir } from '../env/app-data.js';
import { getStore, type HealixStore } from '../storage/store.js';
import type {
  PauseReason,
  Project,
  Run,
  RunStatus,
  SuiteMode,
  TestCase,
  TestStatus,
  Tier,
} from '../storage/types.js';
import { ProviderRouter } from '../providers/router.js';
import type { ProviderAdapter } from '../providers/types.js';
import { extractUsage } from '../providers/usage.js';
import type { UsageRecorder } from '../providers/usage.js';
import { getTestMode } from '../modes/registry.js';
import type {
  ExecOutcome,
  ExplorationMode,
  GeneratedSpec,
  SuiteBundle,
  TestMode,
  TestModeContext,
  TestPlan,
  TestPlanItem,
} from '../modes/types.js';
import { isPlanItemIncluded, tiersForScope } from '../modes/types.js';
import { createTargetAdapter } from '../target/index.js';
import { findFreePort } from '../target/launcher.js';
import { detectExternalDependencies } from '../target/dependencies.js';
import { generateMockResponses } from '../target/mock-responses.js';
import { mockDependencyUrl, startMockServer } from '../target/mock-server.js';
import type { ExternalDependency, MockResponse, MockServerHandle } from '../target/types.js';
import { runCli } from '../exec/run-cli.js';
import { createBrowserSurface } from '../browser/index.js';
import { runExplorePhase, splitStaticUnitsForExplore } from './explore.js';
import { exportSuite } from '../export/index.js';
import { createTriageEngine } from '../triage/index.js';
import type { TriageInput } from '../triage/types.js';
import {
  buildPlanPrompt,
  buildGapFillPlanPrompt,
  buildBatchPlanPrompt,
  parsePlan,
  parsePlanWithDiagnostics,
  synthesizePlan,
  type PlanRepoContext,
  type PlanParseFailureReason,
} from './plan.js';
import { estimateUnitWeight, type FunctionalityUnit } from '../target/functionality-index.js';
import { indexSource } from '../target/source-index.js';
import { persistSourceContext } from '../target/context-store.js';
import type { SourceContext } from '../target/source-context.js';
import { diffAgainstBase } from './topup.js';
import {
  computeCoverage,
  mergeExecOutcomes,
  COVERAGE_MAX_ITERATIONS,
  FRESH_COVERAGE_TARGET,
  TOPUP_COVERAGE_TARGET,
} from './coverage.js';
import {
  buildReport,
  renderReportHtml,
  type ReportCoverageSummary,
  type ReportTriageEntry,
} from './report.js';
import {
  classifyTransientFailure,
  deleteCheckpoint,
  readCheckpoint,
  writeCheckpoint,
  type ResumeCheckpoint,
} from './checkpoint.js';
import { writeRunConfigSnapshot } from './run-config.js';
import type {
  Orchestrator,
  OrchestratorEvent,
  OrchestratorHooks,
  OrchestratorOverrides,
  OrchestratorPhase,
  PlanApprovalResult,
  RunOptions,
  RunSummary,
} from './types.js';

export * from './types.js';
export type { ResumeCheckpoint } from './checkpoint.js';

/** Per-call budget for the best-effort AI triage enrichment. */
const TRIAGE_ANALYZE_TIMEOUT_MS = 20_000;
/**
 * How many failures (at most) get escalated to AI triage analysis. Raised from 3 to 8 to 20:
 * a real 21-failure run showed 8 still left 14 failures stuck at the generic low-confidence
 * baseline ('ambiguous', rationale "no more context available") — the un-escalated remainder is
 * exactly what was causing ambiguous-heavy reports. Processed in TRIAGE_AI_BATCH_SIZE-sized
 * concurrent batches (see below) rather than all at once, since each call spawns a real CLI
 * child process (providers/claude.ts's runCli) — this is a provider-call-cost/process-count
 * budget, not a wall-clock one (batching keeps wall-clock to roughly
 * ceil(TRIAGE_AI_LIMIT / TRIAGE_AI_BATCH_SIZE) * TRIAGE_ANALYZE_TIMEOUT_MS in the worst case).
 */
const TRIAGE_AI_LIMIT = 20;
/** How many AI-escalation calls (each a real CLI child process) run concurrently at once. */
const TRIAGE_AI_BATCH_SIZE = 5;
/** Consecutive best-effort store-write failures before we warn that persistence is down. */
const STORE_FAILURE_WARN_THRESHOLD = 3;
/** Small delay before a same-provider plan retry — cheap insurance against a one-off CLI hiccup/timeout. */
const PLAN_SAME_PROVIDER_RETRY_DELAY_MS = 2_000;
/**
 * Target sum of estimateUnitWeight() across a batched planning call — keeps each
 * individual completion's expected JSON response small enough to avoid
 * output-length truncation (see PlanParseFailureReason 'truncated' in plan.ts).
 * A repo whose total estimated weight exceeds this is planned across multiple
 * smaller calls instead of one monolithic request covering everything at once.
 *
 * Sizing by weight rather than raw unit count accounts for each unit's plan
 * item also carrying an uncapped scenarios array (positive/negative/edge):
 * scenario-heavy units (endpoints, spec-derived units with schemas/auth) count
 * for more than a plain route, so a batch of richly-scenario'd units shrinks
 * automatically instead of silently producing a much larger response than a
 * same-size batch of light units.
 */
const PLAN_BATCH_WEIGHT_BUDGET = 45;

/** Hard cap on units per batch regardless of weight — a structural safety net against pathological inputs. */
const PLAN_BATCH_MAX_UNITS = 20;

/** Max recursive halvings of a still-truncating batch before its units are left uncovered. */
const PLAN_MAX_SPLIT_DEPTH = 3;

/**
 * Run state machine for the Healix orchestrator. Every phase transition is
 * checkpointed to SQLite (run status + events), so an interrupted run is fully
 * inspectable after the fact. A run can also PAUSE — manually, or automatically
 * on a network/credits interruption (never for a manual pause) — which leaves a
 * `checkpoint.json` (see ./checkpoint.ts) alongside the SQLite row; `resume()`
 * uses it to continue without re-planning or redoing already-generated specs
 * or already-completed execution tiers. A run with no checkpoint (e.g. one that
 * hard-errored, or predates this feature) is not resumable — the startup
 * reconciliation in HealixStore.failOrphanedRuns() remains the fallback for
 * those.
 *
 * `overrides` is a dependency-injection seam for testability: each dependency is
 * resolved as `override ?? current-default`, so `createOrchestrator()` with no
 * arguments behaves exactly as before.
 */
export function createOrchestrator(overrides?: OrchestratorOverrides): Orchestrator {
  return {
    run(opts: RunOptions, hooks?: OrchestratorHooks): Promise<RunSummary> {
      return runPipeline(opts, hooks, overrides);
    },
    resume(runId: string, hooks?: OrchestratorHooks, signal?: AbortSignal): Promise<RunSummary> {
      return resumePipeline(runId, hooks, overrides, signal);
    },
  };
}

/**
 * Load a paused run's checkpoint and re-enter runPipeline with it. Fails with
 * status 'error' (no exception) when the run or its checkpoint can't be found —
 * same "always return a summary" contract run() upholds.
 */
async function resumePipeline(
  runId: string,
  hooks?: OrchestratorHooks,
  overrides?: OrchestratorOverrides,
  signal?: AbortSignal,
): Promise<RunSummary> {
  const store = overrides?.store ?? (await getStore());
  if (!store) {
    hooks?.onEvent?.({
      phase: 'plan',
      level: 'error',
      message: 'Storage unavailable (node:sqlite missing); cannot resume run.',
    });
    return { runId, status: 'error' };
  }
  const run = store.getRun(runId);
  if (!run) {
    hooks?.onEvent?.({ phase: 'plan', level: 'error', message: `Run not found: ${runId}` });
    return { runId, status: 'error' };
  }
  const project = store.getProject(run.projectId);
  if (!project) {
    hooks?.onEvent?.({ phase: 'plan', level: 'error', message: `Project not found: ${run.projectId}` });
    return { runId, status: 'error' };
  }
  const runDir = join(projectsDir(), project.id, 'runs', runId);
  const checkpoint = await readCheckpoint(runDir);
  if (!checkpoint) {
    hooks?.onEvent?.({
      phase: 'plan',
      level: 'error',
      message: `Run ${runId} has no checkpoint to resume from.`,
    });
    return { runId, status: 'error' };
  }
  const resumeOpts: RunOptions = {
    projectId: project.id,
    testingScope: checkpoint.runOptions.testingScope,
    suiteMode: checkpoint.runOptions.suiteMode,
    baseRunId: checkpoint.runOptions.baseRunId,
    provider: checkpoint.runOptions.provider,
    autoApprove: true,
    prd: checkpoint.runOptions.prd,
    instructions: checkpoint.runOptions.instructions,
    prdSourceKind: checkpoint.runOptions.prdSourceKind,
    prdFileName: checkpoint.runOptions.prdFileName,
    prdSelectedSheets: checkpoint.runOptions.prdSelectedSheets,
    signal,
  };
  return runPipeline(resumeOpts, hooks, overrides, { run, checkpoint });
}

async function runPipeline(
  opts: RunOptions,
  hooks?: OrchestratorHooks,
  overrides?: OrchestratorOverrides,
  resumeFrom?: { run: Run; checkpoint: ResumeCheckpoint },
): Promise<RunSummary> {
  const getMode = overrides?.getMode ?? getTestMode;
  const makeTarget = overrides?.makeTarget ?? createTargetAdapter;
  const makeBrowser = overrides?.makeBrowser ?? createBrowserSurface;
  const store = overrides?.store ?? (await getStore());
  if (!store) {
    // No persistence available — surface as an error summary the caller can act on.
    hooks?.onEvent?.({
      phase: 'plan',
      level: 'error',
      message: 'Storage unavailable (node:sqlite missing); cannot start run.',
    });
    return { runId: '', status: 'error' };
  }

  const project = store.getProject(opts.projectId);
  if (!project) {
    hooks?.onEvent?.({
      phase: 'plan',
      level: 'error',
      message: `Project not found: ${opts.projectId}`,
    });
    return { runId: '', status: 'error' };
  }

  // Top-up/reuse: resolve the base run BEFORE creating this run's own row —
  // a missing base is a precondition failure, same category as "project not
  // found" above, so it must never silently fall back to 'fresh'.
  const suiteMode: SuiteMode = opts.suiteMode ?? 'fresh';
  let baseRun: Run | null = null;
  if (suiteMode === 'topup' || suiteMode === 'reuse') {
    baseRun = opts.baseRunId ? store.getRun(opts.baseRunId) : store.getLastSuccessfulRun(project.id);
    // An explicitly-pinned baseRunId isn't status-filtered by the store lookup
    // above (unlike the auto-resolved path) — reject 'error'/'cancelled' pins
    // here too, so a caller can't top-up/reuse from a run that never produced
    // a real verdict or was aborted mid-way.
    if (baseRun && (baseRun.status === 'error' || baseRun.status === 'cancelled')) {
      baseRun = null;
    }
    if (!baseRun) {
      hooks?.onEvent?.({
        phase: 'plan',
        level: 'error',
        message: `No previous completed run to ${suiteMode} from for project "${project.name}" — run Fresh first.`,
      });
      return { runId: '', status: 'error' };
    }
  }
  // Every base-run test, carried forward regardless of status — reuse/top-up
  // must reproduce the base run's exact test count, not a subset of it.
  // Carrying a test forward needs its spec FILE, not just its own DB row: a
  // row can lack `specPath` (e.g. persistResults' fallback-insert path, hit
  // when a resumed/re-executed tier's result didn't positionally match its
  // pre-registered row) while a SIBLING row for the same reqTag still has it
  // — same underlying .spec.ts file, so the file (and this scenario inside
  // it) is already known and must not be silently dropped. Resolve a missing
  // specPath from any sibling sharing the same reqTag before filtering.
  const baseTests: TestCase[] = baseRun ? store.listTests(baseRun.id) : [];
  const specPathByReqTag = new Map<string, string>();
  for (const t of baseTests) {
    if (t.specPath && t.reqTag && !specPathByReqTag.has(t.reqTag)) specPathByReqTag.set(t.reqTag, t.specPath);
  }
  const baseTestsWithSpec: TestCase[] = baseTests
    .map((t) => (t.specPath || !t.reqTag ? t : { ...t, specPath: specPathByReqTag.get(t.reqTag) ?? null }))
    .filter((t) => t.specPath);

  let run: Run;
  let runId: string;
  if (resumeFrom) {
    // Continuing an existing paused row — never create a new one, never
    // re-fire onRunCreated (the caller already knows this runId).
    run = resumeFrom.run;
    runId = run.id;
  } else {
    run = store.createRun(project.id, {
      provider: opts.provider ?? null,
      mode: project.mode,
      suiteMode,
      baseRunId: baseRun?.id ?? null,
    });
    runId = run.id;
    // Surface the canonical runId immediately so callers (e.g. the desktop app)
    // correlate events/approval to THIS run instead of pre-creating a duplicate.
    try {
      hooks?.onRunCreated?.(runId);
    } catch {
      // a callback fault must never abort the run
    }
  }
  const runDir = join(projectsDir(), project.id, 'runs', runId);

  // Mutable status mirror so the returned summary always reflects the latest phase.
  let currentStatus: RunStatus = 'pending';

  // Persistence health tracking. Best-effort store writes still swallow their
  // errors (a DB fault must never abort the run), but we count *consecutive*
  // failures and surface at least one warn via the DB-independent onEvent path
  // when persistence appears to be down, so the fault is not lost silently.
  let consecutiveStoreFailures = 0;
  let persistenceWarned = false;
  const noteStoreOk = (): void => {
    consecutiveStoreFailures = 0;
  };
  const noteStoreFailure = (op: string, err: unknown): void => {
    consecutiveStoreFailures += 1;
    if (consecutiveStoreFailures >= STORE_FAILURE_WARN_THRESHOLD && !persistenceWarned) {
      persistenceWarned = true;
      // Route directly through the DB-independent hook (NOT emit), since emit's
      // own store write would just fail again and re-enter this path.
      try {
        hooks?.onEvent?.({
          phase: 'report',
          level: 'warn',
          message: `Persistence appears unavailable: ${consecutiveStoreFailures} consecutive store writes failed (last: ${op}).`,
          data: { op, failures: consecutiveStoreFailures, error: errMsg(err) },
        });
      } catch {
        /* never let a hook crash the run */
      }
    }
  };

  // Captures token/cost usage for every provider.complete() call this run makes
  // (plan, gap-fill plan, generate, triage — see UsageRecorder's call sites),
  // feeding the Usage tab / Reports page. Best-effort like every other store
  // write here: a bad extraction or a DB fault must never affect the run itself.
  const recordUsage: UsageRecorder = (phase, task, providerId, raw) => {
    try {
      const usage = extractUsage(raw);
      store.recordUsage({
        runId,
        phase,
        task,
        provider: providerId,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        costUsd: usage?.costUsd ?? null,
        cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? null,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
        model: usage?.model ?? null,
      });
      noteStoreOk();
    } catch (err) {
      noteStoreFailure('recordUsage', err);
    }
  };

  const setStatus = (
    status: RunStatus,
    patch: { startedAt?: string; finishedAt?: string; pauseReason?: PauseReason | null } = {},
  ): void => {
    currentStatus = status;
    try {
      store.updateRunStatus(runId, status, patch);
      noteStoreOk();
    } catch (err) {
      /* persistence best-effort; never abort the pipeline on a status write */
      noteStoreFailure('updateRunStatus', err);
    }
  };

  const emit = (
    phase: OrchestratorPhase | string,
    level: OrchestratorEvent['level'],
    message: string,
    data?: unknown,
  ): void => {
    try {
      store.appendEvent(runId, String(phase), message, { level, data });
      noteStoreOk();
    } catch (err) {
      /* best-effort */
      noteStoreFailure('appendEvent', err);
    }
    try {
      hooks?.onEvent?.({ phase, level, message, data });
    } catch {
      /* never let a hook crash the run */
    }
  };

  const ctxEmit = (phase: string, message: string, data?: unknown): void =>
    emit(phase, 'info', message, data);

  // Cooperative cancellation. checkCancelled() is polled at every phase
  // boundary; in-flight provider/suite work additionally receives the signal
  // directly (ctx.signal, CompleteOptions.signal) so long-running phases can
  // be interrupted from within. A cancelled run RESOLVES with a 'cancelled'
  // summary — cancellation is a normal outcome, never a rejection — and the
  // shared `finally` still tears down any white-box launch.
  const signal = opts.signal;
  const checkCancelled = (): boolean => signal?.aborted === true;
  const cancelRun = (phase: OrchestratorPhase | string, message = 'Run cancelled by caller.'): RunSummary => {
    emit(phase, 'info', message);
    setStatus('cancelled', { finishedAt: nowIso() });
    return { runId, status: 'cancelled' };
  };
  // A pause shares the same AbortController/signal as cancel — the caller
  // distinguishes them via controller.abort('pause') vs. plain abort() — so
  // every existing checkCancelled() boundary can also honor a pause request
  // without a second signal to plumb through ctx/provider calls.
  const isPauseRequested = (): boolean => checkCancelled() && signal?.reason === 'pause';

  try {
    await mkdir(join(runDir, 'plan'), { recursive: true });
    await mkdir(join(runDir, 'suite'), { recursive: true });
    await mkdir(join(runDir, 'artifacts'), { recursive: true });
    await mkdir(join(runDir, 'reports'), { recursive: true });
  } catch (err) {
    emit('plan', 'error', `Failed to create run directories: ${errMsg(err)}`, { stack: errStack(err) });
    setStatus('error', { finishedAt: nowIso() });
    return { runId, status: 'error' };
  }

  // Permanent record of the user-facing options this run was started with —
  // unlike checkpoint.json (deleted once the run leaves 'paused'), this never
  // gets removed, so the desktop app can show "what was this run configured
  // with" even after it finishes. Rewritten identically on resume (same opts).
  await writeRunConfigSnapshot(runDir, {
    testingScope: opts.testingScope,
    suiteMode: opts.suiteMode,
    provider: opts.provider,
    prd: opts.prd,
    instructions: opts.instructions,
    prdSourceKind: opts.prdSourceKind,
    prdFileName: opts.prdFileName,
    prdSelectedSheets: opts.prdSelectedSheets,
  });

  if (!resumeFrom) {
    setStatus('pending', { startedAt: nowIso() });
  }

  // Accumulated across phases so the report/summary survive partial failures.
  // On resume, GENERATE's output is seeded straight from the checkpoint (see
  // hydrateCheckpointedSpecs below) rather than reconstructed here, since
  // reading the spec files back requires ctx (not built yet at this point).
  let plan: TestPlan | null = resumeFrom?.checkpoint.plan ?? null;
  let specs: GeneratedSpec[] = [];
  let outcome: ExecOutcome | null = resumeFrom?.checkpoint.partialOutcome
    ? {
        passed: resumeFrom.checkpoint.partialOutcome.passed,
        failed: resumeFrom.checkpoint.partialOutcome.failed,
        blocked: resumeFrom.checkpoint.partialOutcome.blocked,
        flaky: resumeFrom.checkpoint.partialOutcome.flaky,
        results: resumeFrom.checkpoint.partialOutcome.results as ExecOutcome['results'],
      }
    : null;
  // Set during PLAN (white-box only); reused after EXECUTE by the coverage-feedback
  // loop, which needs the same functionality inventory the initial plan was grounded on.
  let repoIndex: PlanRepoContext | undefined;
  // Detected automatically during PLAN for every white-box project (no opt-in
  // needed — see the DEPENDENCIES sub-phase below); mockResponses holds the
  // resolved canned content per dependency id. mockServerHandle
  // is only non-null once LAUNCH has started the local server for env-override/both
  // dependencies, and is always stopped in the run's cleanup alongside launchHandle.
  let externalDependencies: ExternalDependency[] = [];
  let mockResponses: Map<string, MockResponse> = new Map();
  let mockServerHandle: MockServerHandle | null = null;
  // Full white-box static-analysis result (routes/endpoints + forms/auth-patterns/selector
  // hints), set alongside repoIndex during PLAN. repoIndex.functionality is a projection of
  // sourceContext.units for backward compatibility; sourceContext itself is what GENERATE and
  // TRIAGE consume for their own grounding (see modes/types.ts's TestModeContext.sourceContext).
  let sourceContext: SourceContext | undefined;
  const triageEntries: ReportTriageEntry[] = [];
  // Artifact files collected from the mode after EXECUTE (relative paths), surfaced in the report.
  let artifactFiles: string[] = [];
  // Final state of the coverage-feedback loop, surfaced in the report; stays null
  // when the loop never runs (reuse mode, or no functionality inventory detected).
  let coverageSummary: ReportCoverageSummary | null = null;
  // Stable key -> testId, so EXECUTE reuses the rows inserted in GENERATE (no duplicates).
  // Rehydrated from the checkpoint on resume so an EXECUTE-only resume updates
  // the SAME rows GENERATE already inserted, instead of inserting duplicates.
  const testIdByKey = new Map<string, string>(Object.entries(resumeFrom?.checkpoint.testIdByKey ?? {}));
  // The base URL the suite should actually target (may be overridden by a white-box launch).
  let effectiveBaseUrl: string | null = project.baseUrl;
  // White-box launch handle, stopped in the run's cleanup regardless of outcome.
  let launchHandle: { stop(): Promise<void> } | null = null;
  // Item-level generation accounting across GENERATE and every coverage-loop
  // gap-fill iteration: how many plan items asked for a spec vs. how many
  // actually got one (the rest were silently dropped after failed generation
  // attempts — see generate.ts's per-item retry-then-skip). Surfaced in the
  // report so a suite that came out smaller than planned is visible instead
  // of looking identical to a suite that genuinely only needed that many.
  const generationStats = { requestedItems: 0, acceptedItems: 0 };
  const trackGeneration = (requested: number, accepted: number): void => {
    generationStats.requestedItems += requested;
    generationStats.acceptedItems += accepted;
  };
  // Assigned once ctx exists (after APPROVE); used by buildCheckpoint to make
  // generatedSpecs' paths relative to the suite dir, matching TestCase.specPath.
  let ctx: TestModeContext | undefined;

  /**
   * Snapshot everything accumulated so far into a ResumeCheckpoint. Cheap and
   * called liberally: before/after each EXECUTE tier, and whenever GENERATE or
   * EXECUTE hits a transient failure or a live pause request. `phase` is
   * derived from progress, not from the caller: no specs yet means resume must
   * redo GENERATE from scratch (nothing was lost); specs present means resume
   * can jump straight to EXECUTE.
   */
  const buildCheckpoint = (completedTiers: Tier[]): ResumeCheckpoint => {
    const effectivePlan: TestPlan = plan ?? { summary: 'No plan yet.', items: [] };
    const suiteDir = ctx?.projectDir ?? join(runDir, 'suite');
    return {
      runId,
      projectId: project.id,
      phase: specs.length > 0 ? 'execute' : 'generate',
      runOptions: {
        testingScope: opts.testingScope,
        suiteMode: opts.suiteMode,
        baseRunId: opts.baseRunId,
        provider: opts.provider,
        autoApprove: opts.autoApprove,
        prd: opts.prd,
        instructions: opts.instructions,
        prdSourceKind: opts.prdSourceKind,
        prdFileName: opts.prdFileName,
        prdSelectedSheets: opts.prdSelectedSheets,
      },
      plan: effectivePlan,
      generatedItemIds: effectivePlan.items
        .filter((it) => specs.some((s) => (s.reqTag ?? it.id) === (it.reqTag ?? it.id)))
        .map((it) => it.id),
      generatedSpecs: specs.map((s) => ({
        path: relative(suiteDir, s.path),
        title: s.title,
        reqTag: s.reqTag,
        tier: s.tier,
      })),
      completedTiers,
      partialOutcome: outcome
        ? {
            passed: outcome.passed,
            failed: outcome.failed,
            blocked: outcome.blocked,
            flaky: outcome.flaky,
            results: outcome.results,
          }
        : undefined,
      testIdByKey: Object.fromEntries(testIdByKey),
      updatedAt: nowIso(),
    };
  };

  /** Write a checkpoint and settle the run as 'paused' — a normal resolved outcome, never a rejection. */
  const pauseRun = async (
    phase: OrchestratorPhase | string,
    reason: PauseReason,
    completedTiers: Tier[] = [],
  ): Promise<RunSummary> => {
    await writeCheckpoint(runDir, buildCheckpoint(completedTiers));
    emit(phase, 'warn', `Run paused (${reason}); checkpoint saved for resume.`, { reason });
    setStatus('paused', { finishedAt: nowIso(), pauseReason: reason });
    return { runId, status: 'paused' };
  };

  /** At a cancellation boundary: honor a live pause request as 'paused' (resumable); otherwise cancel as today. */
  const pauseOrCancel = (
    phase: OrchestratorPhase | string,
    completedTiers: Tier[] = [],
    cancelMessage?: string,
  ): Promise<RunSummary> =>
    isPauseRequested()
      ? pauseRun(phase, 'manual', completedTiers)
      : Promise.resolve(cancelMessage ? cancelRun(phase, cancelMessage) : cancelRun(phase));

  try {
    // ---- 3. PLAN ----
    // A pause requested before a plan exists has nothing worth preserving —
    // resuming would just redo everything anyway — so this one boundary
    // (unlike every other below) always cancels rather than pausing.
    if (checkCancelled()) return cancelRun('plan');
    setStatus('planning');
    let provider: ProviderAdapter | undefined;
    let planForGeneration: TestPlan;
    // The target adapter is built before planning (it is a cheap bag of
    // functions) so the plan phase can reuse its repo indexer for grounding,
    // and LAUNCH needs it regardless of whether this is a resume.
    const target = makeTarget();

    // Default (never override) testingScope to 'frontend' for a white-box
    // project statically detected as frontend-only. Without this, every
    // no-backend app still plans/generates tierC-api specs against a guessed
    // base URL and guessed endpoints — structurally unable to pass. Detection
    // is unambiguous-only: anything other than a clean 'frontend' verdict
    // (including 'unknown') leaves the 'both' default alone, since a false
    // narrow would silently drop real API coverage. An explicit user choice
    // (including one restored from a resumed run's checkpoint) always wins —
    // this only fires when opts.testingScope was never set.
    if (opts.testingScope === undefined && project.repoPath) {
      try {
        const det = await target.detect(project.repoPath);
        if (det.kind === 'frontend') {
          opts.testingScope = 'frontend';
          emit(
            'plan',
            'debug',
            'Detected a frontend-only project (no backend found); defaulting testing scope to ' +
              '"frontend" (skips tierC-api generation). Pass an explicit testingScope to include API tests.',
          );
        }
      } catch (err) {
        emit(
          'plan',
          'debug',
          `Project-kind detection failed (testing scope defaults to 'both'): ${errMsg(err)}`,
        );
      }
    }

    if (resumeFrom) {
      // Resuming: the plan was already finalized and approved before the
      // pause/interruption — replanning or re-showing the approval gate would
      // waste tokens and re-litigate an already-made decision. Only the
      // provider needs re-resolving (cheap: a health probe, no tokens spent).
      emit('plan', 'info', `Resuming run (paused at "${resumeFrom.checkpoint.phase}").`);
      provider = overrides?.provider ?? (await resolveProvider(opts.provider, emit));
      if (!provider) {
        emit('plan', 'error', 'No ready provider available to resume.');
        setStatus('error', { finishedAt: nowIso() });
        return { runId, status: 'error' };
      }
      plan = resumeFrom.checkpoint.plan;
      await writeJson(join(runDir, 'plan', 'plan.json'), plan);
      emit('plan', 'info', `Resumed plan: ${plan.items.length} item(s).`);
      // DEPENDENCIES detection also doesn't re-run on resume (it's part of the
      // same skipped PLAN pass) — reload what was already detected/resolved
      // from plan/dependencies.json so LAUNCH can still restart the mock
      // server and GENERATE/report still see the same dependencies. Best
      // effort: an unreadable/missing file (e.g. a black-box project, which
      // never had one to begin with) just means no mocking on resume, same
      // as if detection had found nothing.
      try {
        const raw = await readFile(join(runDir, 'plan', 'dependencies.json'), 'utf-8');
        const saved = JSON.parse(raw) as Array<ExternalDependency & { mockResponse: MockResponse | null }>;
        externalDependencies = saved.map(({ mockResponse: _mockResponse, ...dep }) => dep);
        mockResponses = new Map(
          saved.filter((d) => d.mockResponse !== null).map((d) => [d.id, d.mockResponse as MockResponse]),
        );
        emit(
          'plan',
          'debug',
          `Resumed ${externalDependencies.length} external dependenc${externalDependencies.length === 1 ? 'y' : 'ies'} for mocking.`,
        );
      } catch (err) {
        emit(
          'plan',
          'debug',
          `Could not reload dependencies for resume (continuing without mocks): ${errMsg(err)}`,
        );
      }
      setStatus('awaiting-approval');
      if (checkCancelled()) return await pauseOrCancel('approve');
      planForGeneration = { ...plan, items: plan.items.filter(isPlanItemIncluded) };
      emit('approve', 'info', 'Approval gate skipped — plan was already approved before pause.');
    } else {
      emit('plan', 'info', 'Selecting planning provider.');
      // An injected provider override bypasses the router entirely (used in tests).
      // Otherwise resolveProvider handles BOTH paths and guarantees a ready+authenticated
      // result: the auto path via router.select('plan'), and the explicit path by probing
      // the requested provider's health and falling back to the other ready provider when
      // it is unhealthy (emitting a warn). It returns undefined only when none are ready.
      provider = overrides?.provider ?? (await resolveProvider(opts.provider, emit));
      if (!provider) {
        emit('plan', 'error', 'No ready provider available for planning.');
        setStatus('error', { finishedAt: nowIso() });
        return { runId, status: 'error' };
      }
      emit('plan', 'info', `Planning with provider "${provider.id}".`);

      if (suiteMode === 'reuse') {
        // Reuse never plans/generates via AI — it re-executes the base run's
        // ENTIRE suite as-is (every test with a known spec file, regardless of
        // its previous status — a run that reruns only last time's winners
        // isn't actually "the suite as-is"). Still synthesize a concrete,
        // cancellable plan (zero AI cost) so the APPROVE gate shows something.
        plan = {
          summary: `Reusing ${baseTestsWithSpec.length} test(s) from run ${baseRun!.id} — no generation.`,
          items: [],
          planSource: 'reuse',
        };
        emit('plan', 'info', 'Skipping AI planning (reuse mode).');
      } else {
        // Best-effort repo grounding: a white-box plan is dramatically better when
        // the model can see the repo's real structure (routes/pages/dirs), but
        // indexing must never block or break planning — any failure simply means
        // "plan without repo context".
        if (project.repoPath) {
          try {
            const idx = await target.indexRepo(project.repoPath, { maxFiles: 200 });
            repoIndex = { summary: idx.summary, files: idx.files };
            emit('plan', 'debug', `Indexed repo for plan grounding (${idx.files.length} file(s)).`);
          } catch (err) {
            emit('plan', 'debug', `Repo indexing failed (planning without repo context): ${errMsg(err)}`);
          }
          try {
            sourceContext = await indexSource(project.repoPath);
            if (sourceContext.units.length > 0) {
              repoIndex = {
                ...(repoIndex ?? { summary: '', files: [] }),
                functionality: sourceContext.units,
              };
              emit(
                'plan',
                'debug',
                `Detected ${sourceContext.units.length} functionality unit(s) for plan grounding.`,
              );
            }
            persistSourceContext(project.repoPath, sourceContext);
          } catch (err) {
            emit(
              'plan',
              'debug',
              `Functionality indexing failed (planning without route context): ${errMsg(err)}`,
            );
          }

          // ---- 3b. DEPENDENCIES (white-box, automatic) ----
          // Detect external dependencies (backend APIs the frontend calls, third-party
          // SMS/email/OTP/payment SDKs) and resolve mock content for them BEFORE launch,
          // so LAUNCH can redirect env-override dependencies and GENERATE can scaffold
          // the route-intercept fixture with real content already in hand. Always runs
          // for a white-box project — no opt-in needed; a project with nothing to mock
          // just gets an empty list here, which is harmless downstream.
          try {
            externalDependencies = await detectExternalDependencies(project.repoPath);
            emit(
              'dependencies',
              'info',
              `Detected ${externalDependencies.length} external dependenc${externalDependencies.length === 1 ? 'y' : 'ies'}.`,
              { dependencies: externalDependencies },
            );
          } catch (err) {
            emit(
              'dependencies',
              'warn',
              `Dependency detection failed (continuing without mocks): ${errMsg(err)}`,
            );
          }
          if (externalDependencies.length > 0) {
            try {
              mockResponses = await generateMockResponses(externalDependencies, provider, {
                repoPath: project.repoPath,
                signal,
              });
            } catch (err) {
              emit(
                'dependencies',
                'debug',
                `Mock response generation failed (using static fallbacks): ${errMsg(err)}`,
              );
            }
          }
          await writeJson(
            join(runDir, 'plan', 'dependencies.json'),
            externalDependencies.map((d) => ({ ...d, mockResponse: mockResponses.get(d.id) ?? null })),
          );
        }

        plan = await runPlanPhase(provider, project, opts, emit, overrides, repoIndex, recordUsage);
        // Enforce the testing-scope boundary as a backstop: plan.ts already asks
        // the model for (and normalizes tiers to) only in-scope tiers, but this
        // is the hard guarantee — filtered here, before approval/persistence, so
        // the approval gate, plan.json, and the report all consistently reflect
        // only what will actually be generated and executed.
        const inScopeTiers = new Set<Tier>(tiersForScope(opts.testingScope ?? 'both'));
        plan = { ...plan, items: plan.items.filter((it) => inScopeTiers.has(it.tier)) };
      }
      await writeJson(join(runDir, 'plan', 'plan.json'), plan);
      emit('plan', 'info', `Plan ready: ${plan.items.length} item(s).`, { summary: plan.summary });
      setStatus('awaiting-approval');

      // ---- 4. APPROVE ----
      if (checkCancelled()) return await pauseOrCancel('approve');
      // What GENERATE actually receives: the full audited plan (all items,
      // whatever their status) filtered to non-rejected items. Identical to
      // `plan` itself when there's no approval gate (auto-approve / no hook).
      planForGeneration = plan;
      if (!opts.autoApprove && hooks?.onPlan) {
        emit('approve', 'info', 'Awaiting plan approval.');
        let result: PlanApprovalResult = { decision: 'cancel' };
        try {
          // Race the (potentially indefinite) human approval gate against abort:
          // a run cancelled while parked at the gate must resolve 'cancelled',
          // not hang forever awaiting an approval that will never come. The
          // gate's eventual result is simply discarded after an abort.
          const gate = await raceAbort(hooks.onPlan(plan), signal);
          if (gate === ABORTED) {
            return await pauseOrCancel('approve', [], 'Run cancelled while awaiting approval.');
          }
          result = gate;
        } catch (err) {
          emit('approve', 'warn', `Approval gate threw: ${errMsg(err)}`, { stack: errStack(err) });
          result = { decision: 'cancel' };
        }
        if (result.decision === 'cancel') {
          emit('approve', 'info', 'Plan rejected; cancelling run.');
          setStatus('cancelled', { finishedAt: nowIso() });
          return { runId, status: 'cancelled' };
        }
        // Finalize: per-item review is opt-in, so any item the reviewer left
        // without a final decision — undefined/'pending' (never touched), or
        // 'revised' (regenerated by AI but not explicitly re-approved) —
        // defaults to 'approved' here, at the trust boundary rather than in a
        // particular caller's UI, so every caller (desktop, CLI, tests) gets
        // the same guarantee.
        const finalizedItems = result.plan.items.map((it) =>
          it.status === undefined || it.status === 'pending' || it.status === 'revised'
            ? { ...it, status: 'approved' as const }
            : it,
        );
        plan = { ...result.plan, items: finalizedItems };
        // Overwrite the pre-approval draft with the finalized, fully-audited
        // plan (statuses + edit/revision history) — this becomes the
        // authoritative "what was actually run" version that plan.json,
        // runs:detail, and the report all read from here on.
        await writeJson(join(runDir, 'plan', 'plan.json'), plan);
        const includedItems = plan.items.filter(isPlanItemIncluded);
        if (includedItems.length === 0 && plan.planSource !== 'reuse') {
          // Every item was rejected — a deliberate empty plan, not a pipeline
          // failure, so this reads as a cancellation rather than falling into
          // the "verified nothing" error path further down. Reuse plans are
          // exempt: they never had AI-generated items to approve in the first
          // place (see suiteMode === 'reuse' above), so an empty items array
          // there is the expected shape, not a rejection.
          emit('approve', 'info', 'All plan items were rejected; cancelling run.');
          setStatus('cancelled', { finishedAt: nowIso() });
          return { runId, status: 'cancelled' };
        }
        planForGeneration = { ...plan, items: includedItems };
        emit(
          'approve',
          'info',
          `Plan approved: ${includedItems.length} of ${plan.items.length} item(s) proceeding.`,
        );
      } else {
        emit('approve', 'info', opts.autoApprove ? 'Auto-approved.' : 'No approval gate; proceeding.');
      }
    }

    // ---- 5. ctx ----
    const browser = makeBrowser();

    // ---- 5b. LAUNCH (white-box) ----
    // A white-box project (repoPath set, no baseUrl) has no live URL yet, so detect + launch
    // the app and target the resulting URL. Recovery ladder on failure:
    //   1. errors that look like missing dependencies → run the detected package
    //      manager's install in the repo and retry the launch once;
    //   2. still failing → the run STOPS as 'error'. There is no URL to fall
    //      back to for a white-box project, so "continuing best-effort" meant
    //      generating and executing an entire suite against a dead URL — every
    //      result was junk and the provider tokens were wasted.
    // The handle is always stopped in the run's cleanup.
    if (checkCancelled()) return await pauseOrCancel('launch');
    if (!project.baseUrl && project.repoPath) {
      const repoPath = project.repoPath;
      emit('launch', 'info', `[launch] Detecting app in ${repoPath}.`);
      let det: Awaited<ReturnType<typeof target.detect>> | null = null;
      try {
        det = await target.detect(repoPath);
      } catch (err) {
        emit('launch', 'error', `[launch] Detection failed: ${errMsg(err)}`, { stack: errStack(err) });
      }

      let launchError: unknown = null;
      if (det) {
        // Per-run port allocation: two concurrent runs of the same project
        // previously both launched on the framework-default port — the second
        // launch's readiness poll then hit the FIRST run's server and the two
        // runs silently tested each other. Resolve a known-free port up front
        // (preferring the detected one) and hand exactly that to launch().
        const port = await findFreePort(det.port ?? undefined);
        if (det.port !== null && port !== det.port) {
          emit(
            'launch',
            'info',
            `[launch] Detected port ${det.port} is in use; launching on free port ${port} instead.`,
            { detectedPort: det.port, port },
          );
        }
        // Mock env-override/both dependencies: start the local mock server once
        // and point each dependency's own env var at it, so the spawned app's
        // outbound calls hit the mock instead of the real (unreachable) service.
        // Best-effort — a failure here must not block the launch, it just means
        // those dependencies won't be mocked for this run.
        const mockableEnvDeps = externalDependencies.filter(
          (d) => d.envVar && (d.mockStrategy === 'env-override' || d.mockStrategy === 'both'),
        );
        let launchEnv: Record<string, string> | undefined;
        if (mockableEnvDeps.length > 0) {
          try {
            mockServerHandle = await startMockServer(externalDependencies, mockResponses);
            launchEnv = {};
            for (const dep of mockableEnvDeps) {
              if (!dep.envVar) continue;
              launchEnv[dep.envVar] = mockDependencyUrl(mockServerHandle.baseUrl, dep.id);
            }
            emit(
              'launch',
              'info',
              `[launch] Mock server started at ${mockServerHandle.baseUrl} for ${mockableEnvDeps.length} dependenc${mockableEnvDeps.length === 1 ? 'y' : 'ies'}.`,
              { env: Object.keys(launchEnv) },
            );
          } catch (err) {
            emit(
              'launch',
              'warn',
              `[launch] Failed to start mock server (continuing without it): ${errMsg(err)}`,
            );
            mockServerHandle = null;
            launchEnv = undefined;
          }
        }

        const doLaunch = async (): Promise<void> => {
          const handle = await target.launch({
            repoPath,
            startCommand: det.startCommand ?? undefined,
            // Proactive install: derived alongside startCommand (correctly
            // targeting a monorepo workspace subdir when that's what's being
            // launched), and gated on node_modules already existing — see
            // launch()'s ensureDependencies(). This runs BEFORE the reactive
            // rung 1 recovery below ever gets a chance to, so for the common
            // case (freshly cloned/never-installed repo) launch succeeds on
            // this very first attempt.
            installCommand: det.installCommand ?? undefined,
            installDir: det.installDir ?? undefined,
            // det.baseUrl embeds the DETECTED port; when the allocated port
            // differs, omit it so launch() derives the URL from `port` and the
            // readiness poll targets the server this run actually started.
            baseUrl: port === det.port ? (det.baseUrl ?? undefined) : undefined,
            port,
            readyTimeoutMs: 120000,
            ...(launchEnv ? { env: launchEnv } : {}),
          });
          launchHandle = handle;
          effectiveBaseUrl = handle.baseUrl;
          emit('launch', 'info', `[launch] App ready at ${handle.baseUrl}.`);
        };

        emit('launch', 'info', `[launch] Launching app (${det.startCommand ?? 'auto'}).`);
        try {
          await doLaunch();
        } catch (err) {
          launchError = err;
          // Recovery rung 1: missing dependencies → install once, retry once.
          // A safety net for cases the proactive install above didn't cover
          // (e.g. a stale/partial node_modules that still fails at runtime) —
          // det.packageManager is the ROOT package manager, so this always
          // installs at repoPath regardless of which subdir was launched.
          if (looksLikeMissingDeps(errMsg(err)) && det.packageManager && !checkCancelled()) {
            emit(
              'launch',
              'warn',
              `[launch] Launch failed with missing-dependency symptoms; running ${det.packageManager} install and retrying.`,
              { error: errMsg(err) },
            );
            const execCli = overrides?.execCli ?? runCli;
            const install = await execCli(det.packageManager, ['install'], {
              cwd: repoPath,
              timeoutMs: 300_000,
            });
            if (install.code === 0) {
              emit('launch', 'info', '[launch] Dependencies installed; retrying launch.');
              try {
                await doLaunch();
                launchError = null;
              } catch (retryErr) {
                launchError = retryErr;
              }
            } else {
              emit(
                'launch',
                'warn',
                `[launch] ${det.packageManager} install failed (exit ${install.code}).`,
                {
                  stderrTail: install.stderr.split(/\r?\n/).filter(Boolean).slice(-8),
                },
              );
            }
          }
        }
      }

      // Recovery exhausted: stop honestly instead of testing a dead URL.
      if (!launchHandle) {
        emit(
          'launch',
          'error',
          `[launch] Target app could not be started${launchError ? `: ${errMsg(launchError)}` : ''}. ` +
            'Fix the start command (healix scan <repo>), start the app yourself and register the project with --url, or check the error above.',
          { stack: errStack(launchError ?? undefined) },
        );
        setStatus('error', { finishedAt: nowIso() });
        const summary = await finalizeReport(
          store,
          runDir,
          run,
          project,
          currentStatus,
          plan,
          outcome,
          triageEntries,
          artifactFiles,
          externalDependencies,
          computeMockedRequestCounts(mockServerHandle),
          noteStoreOk,
          noteStoreFailure,
        );
        return { runId, status: 'error', reportPath: summary.reportPath };
      }
    }

    ctx = {
      projectDir: join(runDir, 'suite'),
      repoPath: project.repoPath,
      baseUrl: effectiveBaseUrl,
      credentials: project.credentials,
      provider,
      target,
      browser,
      explorationMode: opts.explorationMode ?? deriveExplorationMode(project),
      testingScope: opts.testingScope ?? 'both',
      sourceContext,
      emit: ctxEmit,
      onUsage: recordUsage,
      // Long mode phases (generate/execute) receive the run's abort signal so
      // in-flight provider/suite work is killed on cancellation, not just
      // skipped at the next phase boundary.
      signal,
      ...(externalDependencies.length > 0
        ? {
            mockExternalDependencies: true,
            externalDependencies,
            mockResponses: Object.fromEntries(mockResponses),
          }
        : {}),
    };
    const mode = getMode(project.mode);

    // ---- 6. EXPLORE (best-effort) ----
    // Runs in BOTH exploration modes whenever a live URL exists: the DOM
    // snapshot grounds GENERATE in real selectors either way. Codegen mode
    // used to skip this entirely, so its specs guessed routes/locators blind —
    // the dominant source of test_is_wrong failures. Frame mirroring (the live
    // browser view in the desktop app) mirrors whenever a live URL exists too,
    // not just for computer-use — a codegen project still drives a real
    // browser here and during EXECUTE, so there's a real frame to show either way.
    if (checkCancelled()) return await pauseOrCancel('explore');
    if (suiteMode === 'reuse') {
      // No new specs are ever generated in reuse mode, so there is nothing for
      // a DOM snapshot to ground — skip the live browser pass entirely.
      emit('explore', 'debug', 'Skipping exploration (reuse mode).');
    } else if (effectiveBaseUrl) {
      // Black-box projects (a user-supplied baseUrl with no locally-spawned
      // dev server) never had that URL verified reachable — white-box
      // launches already prove readiness via launch()'s own probeUrl race.
      // Without this, an unreachable black-box baseUrl fell straight into
      // browser.goto()'s own timeout, and then GENERATE/EXECUTE still ran
      // blind against a dead app.
      let reachable = true;
      if (!launchHandle) {
        const probe = await target.probeUrl(effectiveBaseUrl, 8_000);
        reachable = probe.reachable;
        if (!reachable) {
          emit('explore', 'warn', `Base URL ${effectiveBaseUrl} is not reachable; skipping exploration.`, {
            probe,
          });
        }
      }
      if (reachable) {
        setStatus('exploring');
        emit('explore', 'info', `Exploring ${effectiveBaseUrl} (${ctx.explorationMode ?? 'codegen'}).`);
        // White-box only: feed the already-computed sourceContext's static routes as extra crawl
        // seeds, so routes with no visible in-app link (admin pages, wizard steps, deep settings)
        // still get explored. Reuses the SAME PLAN-phase sourceContext (see indexSource above)
        // rather than re-indexing — this used to be an independent second indexFunctionality call.
        // Endpoint (tierC, no DOM route) units are split out for their own HTTP reachability
        // probe instead of a wasted browser navigation — see splitStaticUnitsForExplore.
        const { routePaths: staticRoutePaths, endpointPaths } = splitStaticUnitsForExplore(
          sourceContext?.units ?? [],
        );
        if (endpointPaths.length > 0) {
          const probeBaseUrl = effectiveBaseUrl;
          const probes = await Promise.all(
            endpointPaths.map(async (p) => ({
              path: p,
              ...(await target.probeUrl(new URL(p, probeBaseUrl).toString(), 3_000)),
            })),
          );
          const unreachable = probes.filter((p) => !p.reachable);
          if (unreachable.length > 0) {
            emit(
              'explore',
              'warn',
              `${unreachable.length}/${probes.length} statically-detected API endpoint(s) did not respond.`,
              { unreachable: unreachable.map((p) => p.path) },
            );
          }
        }

        try {
          // EXPLORE only needs ONE representative session to find/confirm a login
          // form — not every role. Prefer a roleless credential (the "default"
          // session Tier B also falls back to) over a role-tagged one.
          const defaultCredential = ctx.credentials?.find((c) => c.role === null) ?? ctx.credentials?.[0];
          const exploration = await runExplorePhase({
            browser,
            baseUrl: effectiveBaseUrl,
            credentials: defaultCredential
              ? { username: defaultCredential.username, password: defaultCredential.password }
              : undefined,
            staticRoutePaths,
            emit,
            onFrame: hooks?.onFrame,
          });
          ctx.exploration = exploration;

          // Auth-pattern-aware breadcrumb: a recognized auth library was detected in source but
          // the crawl found no REAL login form — only the always-present common-path fallback
          // candidates scoreLoginCandidates() adds when nothing crawled scores confidently (see
          // browser/crawler.ts), which don't indicate an actual form was found. Likely a
          // non-form/token auth mechanism (API keys, OAuth redirect, session cookie set
          // server-side) that EXPLORE's form-based login detection can't see. Never blocks;
          // surfaces the ambiguity instead of silently reporting "no login found" as if the app
          // were simply unauthenticated.
          const detectedLibraries = new Set((sourceContext?.authPatterns ?? []).flatMap((a) => a.libraries));
          const hasCrawledLoginCandidate = exploration.loginCandidates.some((c) => c.source === 'crawled');
          if (detectedLibraries.size > 0 && !hasCrawledLoginCandidate) {
            emit(
              'explore',
              'warn',
              `Detected auth librar${detectedLibraries.size === 1 ? 'y' : 'ies'} (${[...detectedLibraries].join(', ')}) in source, but no login form was found during exploration — this app may use non-form/token-based auth that EXPLORE cannot currently detect.`,
            );
          }
        } catch (err) {
          emit('explore', 'warn', `Exploration failed (continuing): ${errMsg(err)}`, {
            stack: errStack(err),
          });
        }
      }
    } else {
      emit('explore', 'debug', 'Skipping exploration.');
    }

    // ---- 7. GENERATE ----
    if (checkCancelled()) return await pauseOrCancel('generate');
    setStatus('generating');
    if (resumeFrom && resumeFrom.checkpoint.phase === 'execute') {
      // GENERATE already fully completed before the pause/interruption (the
      // checkpoint's own phase says so) — restore specs from disk instead of
      // re-invoking the AI. See the "honest scope" note on hydrateCheckpointedSpecs.
      emit(
        'generate',
        'info',
        `Resuming: ${resumeFrom.checkpoint.generatedSpecs.length} spec(s) already generated; skipping regeneration.`,
      );
      try {
        await mode.scaffold(ctx);
        specs = await hydrateCheckpointedSpecs(ctx, resumeFrom.checkpoint);
      } catch (err) {
        emit('generate', 'error', `Could not restore checkpointed specs: ${errMsg(err)}`, {
          stack: errStack(err),
        });
        setStatus('error', { finishedAt: nowIso() });
        const summary = await finalizeReport(
          store,
          runDir,
          run,
          project,
          currentStatus,
          plan,
          outcome,
          triageEntries,
          artifactFiles,
          externalDependencies,
          computeMockedRequestCounts(mockServerHandle),
          noteStoreOk,
          noteStoreFailure,
          { generationStats, coverage: coverageSummary },
        );
        return { runId, status: 'error', reportPath: summary.reportPath, outcome: outcome ?? undefined };
      }
    } else {
      emit('generate', 'info', 'Scaffolding suite.');
      try {
        await mode.scaffold(ctx);

        let newSpecs: GeneratedSpec[] = [];
        let carriedSpecs: GeneratedSpec[] = [];
        let newSpecItems: TestPlanItem[] = [];
        if (suiteMode === 'reuse') {
          emit(
            'generate',
            'info',
            `Copying ${baseTestsWithSpec.length} test(s) forward from run ${baseRun!.id} (entire suite, as-is).`,
          );
          carriedSpecs = await hydrateCarriedSpecs(ctx, project.id, baseRun!.id, baseTestsWithSpec, emit);
        } else if (suiteMode === 'topup') {
          const diff = diffAgainstBase(planForGeneration.items, baseTestsWithSpec);
          emit(
            'generate',
            'info',
            `Top-up: ${diff.toGenerate.length} new/missing spec(s), ${diff.carried.length} carried forward from run ${baseRun!.id}.`,
          );
          emit('generate', 'info', 'Generating specs.');
          newSpecs = await mode.generate(ctx, { ...planForGeneration, items: diff.toGenerate });
          newSpecItems = diff.toGenerate;
          trackGeneration(diff.toGenerate.length, newSpecs.length);
          carriedSpecs = await hydrateCarriedSpecs(ctx, project.id, baseRun!.id, diff.carried, emit);
        } else {
          emit('generate', 'info', 'Generating specs.');
          newSpecs = await mode.generate(ctx, planForGeneration);
          newSpecItems = planForGeneration.items;
          trackGeneration(planForGeneration.items.length, newSpecs.length);
        }

        // Pre-execution validation gate: generate.ts's regex/string gates
        // never parse the TypeScript, so a spec with a genuine syntax defect
        // (unclosed string, dropped brace) can still sail through — catch
        // that HERE, before any row is registered or execute() ever sees the
        // file, rather than as a raw exception mid-suite (see
        // modes/playwright/validate.ts). Modes without a validate() are
        // treated as always-valid.
        const validation = mode.validate
          ? await mode.validate(ctx, [...newSpecs, ...carriedSpecs])
          : { ok: [...newSpecs, ...carriedSpecs], repaired: [], quarantined: [], warnings: [] };
        if (validation.quarantined.length > 0) {
          const codegenDefects = validation.quarantined.filter((q) => q.category === 'codegen-defect');
          // Codegen defects (a parse failure on a spec generated FROM a real,
          // already-indexed source file — see validate.ts's SRC_CITATION_RE)
          // indicate a bug in generation itself, not an ordinary model slip —
          // surface them louder/separately so they don't get lost among
          // routine per-spec quarantine noise.
          if (codegenDefects.length > 0) {
            emit(
              'generate',
              'error',
              `${codegenDefects.length} source-grounded spec(s) failed to parse — likely a codegen defect, not a routine quality issue.`,
              { codegenDefects: codegenDefects.map((q) => ({ title: q.spec.title, reason: q.reason })) },
            );
          }
          emit(
            'generate',
            'warn',
            `${validation.quarantined.length} spec(s) quarantined after failing validation.`,
            {
              quarantined: validation.quarantined.map((q) => ({
                title: q.spec.title,
                reason: q.reason,
                category: q.category,
              })),
            },
          );
        }
        if (validation.warnings.length > 0) {
          emit(
            'generate',
            'warn',
            `${validation.warnings.length} spec(s) shipped with non-blocking quality findings.`,
            {
              warnings: validation.warnings.map((w) => ({
                title: w.spec.title,
                findings: w.findings.map((f) => f.message),
              })),
            },
          );
        }
        // Only `contents` legitimately flows out of validation (a bracket-repair
        // rewrite — see validate.ts's `{ ...spec, contents: fixed }`); title/
        // reqTag/tier must stay whatever the ORIGINAL entry carried. Keying a
        // Map by `path` alone and swapping in its whole value would collapse
        // every entry sharing that path onto a single winner's identity —
        // exactly what happens for a multi-scenario carried-forward file,
        // where one physical spec legitimately backs several distinct rows.
        const contentsByPath = new Map(
          [...validation.ok, ...validation.repaired].map((s) => [s.path, s.contents]),
        );
        newSpecs = newSpecs.flatMap((s) =>
          contentsByPath.has(s.path) ? [{ ...s, contents: contentsByPath.get(s.path)! }] : [],
        );
        carriedSpecs = carriedSpecs.flatMap((s) =>
          contentsByPath.has(s.path) ? [{ ...s, contents: contentsByPath.get(s.path)! }] : [],
        );

        specs = [...newSpecs, ...carriedSpecs];
        // Freshly generated specs register ONE test row per scenario the plan
        // requested (see registerSpecRows) so Total/Passed/Failed/etc. reflect
        // real test-case counts, matching the report — not spec-file counts.
        // Carried-forward specs (copied bytes from a prior run, already at
        // whatever granularity that run used) get a single row, as before.
        for (const spec of newSpecs)
          registerSpecRows(store, runId, ctx.projectDir, spec, newSpecItems, testIdByKey);
        for (const spec of carriedSpecs)
          registerSpecRows(store, runId, ctx.projectDir, spec, [], testIdByKey);
        emit('generate', 'info', `Generated ${specs.length} spec(s).`);
        // Checkpoint immediately: if the process dies between here and EXECUTE
        // finishing, resume skips straight to EXECUTE with zero regeneration.
        await writeCheckpoint(runDir, buildCheckpoint([]));
      } catch (err) {
        // A pause request aborts ctx.signal, which is exactly what kills an
        // in-flight provider call — so a live pause surfaces here as some
        // generic "aborted"-flavored error, not a recognizable network/credits
        // signature. Check isPauseRequested() FIRST: it's the direct cause,
        // regardless of what the resulting error message happens to say.
        if (isPauseRequested()) {
          return await pauseRun('generate', 'manual', []);
        }
        // Otherwise, a systemic provider outage (see ProviderUnavailableError/
        // generate.ts) is worth pausing+resuming rather than hard-failing —
        // anything else (a genuine bug/bad config) keeps failing as before.
        const classified = classifyTransientFailure(errMsg(err));
        if (classified) {
          return await pauseRun('generate', classified, []);
        }
        emit('generate', 'error', `Generation failed: ${errMsg(err)}`, { stack: errStack(err) });
        setStatus('error', { finishedAt: nowIso() });
        const summary = await finalizeReport(
          store,
          runDir,
          run,
          project,
          currentStatus,
          plan,
          outcome,
          triageEntries,
          artifactFiles,
          externalDependencies,
          computeMockedRequestCounts(mockServerHandle),
          noteStoreOk,
          noteStoreFailure,
          { generationStats, coverage: coverageSummary },
        );
        return { runId, status: 'error', reportPath: summary.reportPath, outcome: outcome ?? undefined };
      }
    }

    // ---- 8. EXECUTE ----
    // Split into one Playwright invocation per in-scope tier (mode.execute's
    // `onlyTier` option) rather than one call for the whole suite: Playwright's
    // JSON reporter doesn't give reliable partial results if the process dies
    // mid-suite, so a tier boundary is the finest granularity a checkpoint can
    // safely rely on. Already-completed tiers (from a resumed checkpoint) are
    // skipped entirely.
    if (checkCancelled()) return await pauseOrCancel('execute');
    setStatus('executing');
    const alreadyDoneTiers = new Set<Tier>(
      resumeFrom?.checkpoint.phase === 'execute' ? resumeFrom.checkpoint.completedTiers : [],
    );
    const tiersToRun = tiersForScope(opts.testingScope ?? 'both').filter(
      (t) => !alreadyDoneTiers.has(t) && specs.some((s) => s.tier === t),
    );
    if (!outcome) outcome = { passed: 0, failed: 0, blocked: 0, flaky: 0, results: [] };
    const completedTiers: Tier[] = [...alreadyDoneTiers];
    emit(
      'execute',
      'info',
      `Executing ${specs.length} spec(s) across ${tiersToRun.length} tier(s)` +
        (completedTiers.length > 0 ? ` (${completedTiers.length} tier(s) already done).` : '.'),
    );
    try {
      for (const tier of tiersToRun) {
        if (checkCancelled()) return await pauseOrCancel('execute', completedTiers);
        const tierSpecs = specs.filter((s) => s.tier === tier);
        emit('execute', 'info', `Executing tier ${tier} (${tierSpecs.length} spec(s)).`);
        const tierOutcome = await mode.execute(ctx, tierSpecs, { onlyTier: tier });
        persistResults(store, runId, tierSpecs, tierOutcome, testIdByKey, noteStoreOk, noteStoreFailure);
        outcome = mergeExecOutcomes(outcome, tierOutcome);
        completedTiers.push(tier);
        await writeCheckpoint(runDir, buildCheckpoint(completedTiers));
      }
      emit('execute', 'info', `Execution complete: ${outcome.passed} passed, ${outcome.failed} failed.`, {
        passed: outcome.passed,
        failed: outcome.failed,
        blocked: outcome.blocked,
        flaky: outcome.flaky,
      });
    } catch (err) {
      // Same reasoning as GENERATE's catch: a live pause aborts ctx.signal,
      // which is what actually kills an in-flight Playwright invocation — so
      // check isPauseRequested() before trying to pattern-match the error text.
      if (isPauseRequested()) {
        return await pauseRun('execute', 'manual', completedTiers);
      }
      const classified = classifyTransientFailure(errMsg(err));
      if (classified) {
        return await pauseRun('execute', classified, completedTiers);
      }
      emit('execute', 'error', `Execution failed: ${errMsg(err)}`, { stack: errStack(err) });
      setStatus('error', { finishedAt: nowIso() });
      const summary = await finalizeReport(
        store,
        runDir,
        run,
        project,
        currentStatus,
        plan,
        outcome,
        triageEntries,
        artifactFiles,
        externalDependencies,
        computeMockedRequestCounts(mockServerHandle),
        noteStoreOk,
        noteStoreFailure,
        { generationStats, coverage: coverageSummary },
      );
      return { runId, status: 'error', reportPath: summary.reportPath, outcome: outcome ?? undefined };
    }

    // ---- 8b. COLLECT ARTIFACTS (best-effort) ----
    // Gather the mode's artifact files so the report can surface them. A failure
    // here must not affect the run outcome.
    try {
      const collected = await mode.collectArtifacts(ctx);
      artifactFiles = collected.files;
      emit('execute', 'info', `Collected ${artifactFiles.length} artifact file(s).`, { dir: collected.dir });
    } catch (err) {
      emit('execute', 'warn', `Artifact collection failed (continuing): ${errMsg(err)}`, {
        stack: errStack(err),
      });
    }

    // ---- 8c. COVERAGE FEEDBACK LOOP (best-effort) ----
    // Fresh/top-up runs bound their coverage to a MEASURED target instead of
    // stopping after a single plan/generate/execute pass — the earlier "prefer
    // 3-8 scenarios" cap meant the plan itself was the bottleneck no matter how
    // much of the app's real surface area was detected. Each iteration here
    // re-plans ONLY the still-uncovered functionality units (buildGapFillPlanPrompt),
    // generates+executes just those items, and merges the results in. These
    // fill-gap iterations are auto-approved (skip the human plan-approval gate)
    // since they are strictly additive within the tiers/scope already approved
    // in the initial plan — every iteration still emits a clear message so this
    // is never silent about what it's adding or why it stopped.
    if (checkCancelled()) return await pauseOrCancel('generate', completedTiers);
    if (suiteMode === 'reuse' || !repoIndex?.functionality || repoIndex.functionality.length === 0) {
      emit('generate', 'debug', 'Skipping coverage loop (reuse mode or no functionality inventory).');
    } else {
      const coverageTarget = suiteMode === 'topup' ? TOPUP_COVERAGE_TARGET : FRESH_COVERAGE_TARGET;
      const units = repoIndex.functionality;
      let coveredPlanItems = planForGeneration.items;
      let iteration = 1;
      let coverage = computeCoverage(units, coveredPlanItems, specs, outcome);
      emit(
        'generate',
        'info',
        `Coverage: ${Math.round(coverage.ratio * 100)}% (${coverage.coveredUnitKeys.size}/${units.length} unit(s)).`,
      );

      while (
        coverage.ratio < coverageTarget &&
        coverage.uncovered.length > 0 &&
        iteration < COVERAGE_MAX_ITERATIONS &&
        !checkCancelled()
      ) {
        iteration += 1;
        emit(
          'plan',
          'info',
          `Coverage ${Math.round(coverage.ratio * 100)}% below target ${Math.round(coverageTarget * 100)}%; ` +
            `planning gap-fill iteration ${iteration}/${COVERAGE_MAX_ITERATIONS} for ${coverage.uncovered.length} uncovered unit(s).`,
        );

        const gapPrompt = buildGapFillPlanPrompt(project, opts, coverage.uncovered, repoIndex);
        let gapPlan: TestPlan | null = null;
        try {
          const completion = await provider.complete(gapPrompt, {
            mode: 'plan',
            cwd: project.repoPath ?? undefined,
            signal,
            taskType: 'plan-gapfill',
          });
          if (completion.model) {
            emit('plan', 'debug', `plan-gapfill used model=${completion.model} effort=${completion.effort}.`);
          }
          recordUsage('plan', 'gap-fill', provider.id, completion.raw);
          if (completion.ok && completion.text) {
            gapPlan = parsePlan(completion.text, opts.testingScope ?? 'both');
          } else {
            emit('plan', 'warn', `Gap-fill planning returned no usable plan; stopping coverage loop.`);
          }
        } catch (err) {
          emit('plan', 'warn', `Gap-fill planning failed (stopping coverage loop): ${errMsg(err)}`);
        }
        if (!gapPlan || gapPlan.items.length === 0) break;

        const inScopeTiers = new Set<Tier>(tiersForScope(opts.testingScope ?? 'both'));
        const gapItems = gapPlan.items.filter((it) => inScopeTiers.has(it.tier));
        if (gapItems.length === 0) {
          emit('plan', 'info', 'Gap-fill plan had no in-scope items; stopping coverage loop.');
          break;
        }
        emit('plan', 'info', `Gap-fill plan: ${gapItems.length} item(s), auto-approved.`);

        if (checkCancelled()) break;
        let gapSpecs: GeneratedSpec[] = [];
        try {
          emit('generate', 'info', `Generating ${gapItems.length} gap-fill spec(s).`);
          gapSpecs = await mode.generate(ctx, { summary: gapPlan.summary, items: gapItems });
          trackGeneration(gapItems.length, gapSpecs.length);
        } catch (err) {
          emit('generate', 'warn', `Gap-fill generation failed (stopping coverage loop): ${errMsg(err)}`);
          break;
        }
        if (gapSpecs.length === 0) {
          emit('generate', 'info', 'Gap-fill generation produced no accepted specs; stopping coverage loop.');
          break;
        }
        for (const spec of gapSpecs)
          registerSpecRows(store, runId, ctx.projectDir, spec, gapItems, testIdByKey);
        specs = [...specs, ...gapSpecs];

        if (checkCancelled()) break;
        try {
          emit('execute', 'info', `Executing ${gapSpecs.length} gap-fill spec(s).`);
          const gapOutcome = await mode.execute(ctx, gapSpecs);
          persistResults(store, runId, gapSpecs, gapOutcome, testIdByKey, noteStoreOk, noteStoreFailure);
          outcome = mergeExecOutcomes(outcome, gapOutcome);
        } catch (err) {
          emit('execute', 'warn', `Gap-fill execution failed (stopping coverage loop): ${errMsg(err)}`);
          break;
        }

        coveredPlanItems = [...coveredPlanItems, ...gapItems];
        planForGeneration = { ...planForGeneration, items: coveredPlanItems };
        plan = { ...plan, items: [...plan.items, ...gapItems] };

        const prevCovered = coverage.coveredUnitKeys.size;
        coverage = computeCoverage(units, coveredPlanItems, specs, outcome);
        emit(
          'generate',
          'info',
          `Coverage after iteration ${iteration}: ${Math.round(coverage.ratio * 100)}% (${coverage.coveredUnitKeys.size}/${units.length} unit(s)).`,
        );
        if (coverage.coveredUnitKeys.size <= prevCovered) {
          emit('generate', 'info', 'No forward progress in coverage; stopping loop.');
          break;
        }
      }

      if (coverage.ratio < coverageTarget) {
        emit(
          'generate',
          'warn',
          `Coverage loop stopped at ${Math.round(coverage.ratio * 100)}% (target ${Math.round(coverageTarget * 100)}%) ` +
            `after ${iteration} iteration(s) — see prior log lines for why it stopped short.`,
        );
      }
      await writeJson(join(runDir, 'plan', 'plan.json'), plan);
      coverageSummary = {
        ratio: coverage.ratio,
        target: coverageTarget,
        coveredCount: coverage.coveredUnitKeys.size,
        totalCount: units.length,
        uncovered: coverage.uncovered,
      };
    }

    // Drop any pre-registered scenario rows that never got a matching execution
    // result (see deleteUnexecutedTests) so the Results tab's Total agrees with
    // the Report's Total instead of counting phantom planned-but-never-ran rows.
    try {
      const removed = store.deleteUnexecutedTests(runId);
      if (removed > 0) {
        emit('execute', 'debug', `Dropped ${removed} pre-registered test row(s) that never executed.`);
      }
      noteStoreOk();
    } catch (err) {
      noteStoreFailure('deleteUnexecutedTests', err);
    }

    // ---- 9. TRIAGE (best-effort) ----
    // classify() is the deterministic baseline for EVERY failure. For the first
    // few failures we additionally try AI analyze() with a short per-call timeout
    // and merge its verdict/confidence in; analyze() already falls back to
    // classify() internally, so the baseline is never lost. Triage never aborts.
    // Blocked outcomes are triaged too: a blocked test is precisely where
    // classification is least certain (was it really a prerequisite failure,
    // or a mislabeled defect?), so skipping them hid defects from the report.
    if (checkCancelled()) return await pauseOrCancel('triage', completedTiers);
    setStatus('triaging');
    try {
      const failed = outcome.results.filter((r) => r.status === 'failed' || r.status === 'blocked');
      if (failed.length > 0) {
        emit('triage', 'info', `Triaging ${failed.length} failure(s)/blocked outcome(s).`);
        const engine = createTriageEngine();

        // classify() is synchronous/deterministic — run it for every failure up
        // front as the baseline (and the fallback if AI enrichment below fails).
        const baseline = failed.map((r) => {
          // Recover the originating spec (by normalized title) to ground the triage
          // input with its requirement tag and source.
          const spec = specs.find((s) => stableKey(undefined, s.title) === stableKey(undefined, r.title));
          // Surface a captured trace/screenshot to the AI prompt (see
          // prompt.ts's "TRACE PATH" block) — this was collected by execute.ts
          // but never threaded through before, so triage only ever "knew" a
          // trace existed by chance, never which file.
          const tracePath = (r.artifacts ?? []).find((a) => a.endsWith('.zip')) ?? r.artifacts?.[0];
          // Recover the plan item this spec was generated from, to find the source-context unit
          // (if any) it was grounded on during GENERATE — read lazily, only for AI-enriched
          // candidates below, since most failures never reach that stage.
          const planItem = planForGeneration.items.find(
            (it) => (spec?.reqTag && it.reqTag === spec.reqTag) || it.title === r.title,
          );
          const unit = planItem?.unitKey
            ? sourceContext?.units.find((u) => u.key === planItem.unitKey)
            : undefined;
          const input: TriageInput = {
            title: r.title,
            error: r.error ?? '',
            ...(spec?.reqTag ? { reqTag: spec.reqTag } : {}),
            ...(spec?.contents ? { specSource: spec.contents } : {}),
            ...(tracePath ? { tracePath } : {}),
          };
          let triage: ReportTriageEntry['triage'] | null = null;
          try {
            triage = engine.classify(input);
          } catch (err) {
            emit('triage', 'warn', `Triage classify failed for "${r.title}": ${errMsg(err)}`);
          }
          return { r, input, triage, unit };
        });

        // Best-effort AI enrichment for the N LEAST-CONFIDENT failures, run in
        // TRIAGE_AI_BATCH_SIZE-sized CONCURRENT batches (each call with its own bounded
        // AbortController) rather than one at a time OR all at once — triage was previously
        // the run's most serial phase, and later all-at-once, but each call spawns a real CLI
        // child process (providers/claude.ts's runCli), so an unbounded burst of
        // TRIAGE_AI_LIMIT simultaneous spawns is its own resource risk once the limit is large.
        // Sorted ascending by baseline confidence so the scarce AI budget is spent on the
        // failures that most need it (low-confidence/ambiguous baselines) rather than on
        // whichever failures happen to execute first — a rule-confident test_is_wrong near
        // the top of the results array was previously "spending" a slot that a genuinely
        // ambiguous failure further down needed far more.
        const aiCandidates = baseline
          .filter((b) => b.triage !== null)
          .sort((a, b) => (a.triage?.confidence ?? 1) - (b.triage?.confidence ?? 1))
          .slice(0, TRIAGE_AI_LIMIT);

        const enrichOne = async (b: (typeof aiCandidates)[number]): Promise<void> => {
          // Read the matched source-context unit's file lazily — only AI-enriched candidates
          // need it (classify()'s deterministic rules never look at source), so most failures
          // never pay this read.
          if (b.unit && project.repoPath) {
            try {
              const content = await readFile(join(project.repoPath, b.unit.file), 'utf-8');
              b.input = { ...b.input, sourceFile: b.unit.file, sourceExcerpt: content };
            } catch (err) {
              emit('triage', 'debug', `Could not read matched source file "${b.unit.file}": ${errMsg(err)}`);
            }
          }
          const controller = new AbortController();
          try {
            const enriched = await withTimeoutAbort(
              engine.analyze(
                b.input,
                provider,
                controller.signal,
                recordUsage,
                project.repoPath ?? undefined,
              ),
              TRIAGE_ANALYZE_TIMEOUT_MS,
              controller,
            );
            if (enriched) b.triage = enriched;
          } catch (err) {
            // Timeout / analyze() threw — keep the deterministic baseline.
            emit('triage', 'debug', `AI triage skipped for "${b.r.title}": ${errMsg(err)}`);
          }
        };

        for (let i = 0; i < aiCandidates.length; i += TRIAGE_AI_BATCH_SIZE) {
          const batch = aiCandidates.slice(i, i + TRIAGE_AI_BATCH_SIZE);
          await Promise.all(batch.map(enrichOne));
        }

        for (const b of baseline) {
          if (b.triage) triageEntries.push({ title: b.r.title, error: b.r.error ?? '', triage: b.triage });
        }
        emit('triage', 'info', `Triaged ${triageEntries.length} failure(s).`);
      } else {
        emit('triage', 'debug', 'No failures to triage.');
      }
    } catch (err) {
      emit('triage', 'warn', `Triage phase error (continuing): ${errMsg(err)}`, { stack: errStack(err) });
    }

    // ---- 10. REPORT ----
    if (checkCancelled()) return await pauseOrCancel('report', completedTiers);
    setStatus('reporting');
    if (generationStats.requestedItems > generationStats.acceptedItems) {
      const dropped = generationStats.requestedItems - generationStats.acceptedItems;
      emit(
        'report',
        'warn',
        `Generated ${generationStats.acceptedItems}/${generationStats.requestedItems} planned spec(s); ` +
          `${dropped} dropped after failed generation attempts (see generate-phase logs above for reasons).`,
      );
    }
    emit('report', 'info', 'Writing report.');
    const reportPath = (
      await finalizeReport(
        store,
        runDir,
        run,
        project,
        currentStatus,
        plan,
        outcome,
        triageEntries,
        artifactFiles,
        externalDependencies,
        computeMockedRequestCounts(mockServerHandle),
        noteStoreOk,
        noteStoreFailure,
        { generationStats, coverage: coverageSummary },
      )
    ).reportPath;

    // ---- 11. EXPORT (best-effort) ----
    // Prefer the mode's own export() for the suite bundle; fall back to the
    // standalone exportSuite() if it throws. Either way, never abort the run.
    if (checkCancelled()) return await pauseOrCancel('export', completedTiers);
    let suite: RunSummary['suite'];
    try {
      emit('export', 'info', 'Exporting suite bundle.');
      suite = await exportViaMode(mode, ctx, runDir, emit);
      if (suite) {
        emit('export', 'info', `Exported ${suite.files.length} file(s).`, {
          dir: suite.dir,
          zipPath: suite.zipPath,
        });
      }
    } catch (err) {
      emit('export', 'warn', `Export failed (continuing): ${errMsg(err)}`, { stack: errStack(err) });
    }

    // Honest final status:
    //  - any failure → 'failed';
    //  - no failures but ≥1 blocked test → 'blocked' (a prerequisite such as
    //    Tier-B auth was not met, so part of the plan was NOT verified —
    //    headlining it 'passed' hid real defects behind blocked entries);
    //  - all green with ≥1 pass → 'passed';
    //  - nothing ran at all → 'error' ("verified nothing").
    let finalStatus: RunStatus;
    if (outcome.failed > 0) {
      finalStatus = 'failed';
    } else if (outcome.blocked > 0) {
      finalStatus = 'blocked';
    } else if (outcome.passed > 0) {
      finalStatus = 'passed';
    } else {
      finalStatus = 'error';
    }
    setStatus(finalStatus, { finishedAt: nowIso() });
    if (finalStatus === 'error') {
      emit('done', 'error', 'Run verified nothing: no runnable specs were produced.', {
        runId,
        status: finalStatus,
        passed: outcome.passed,
        failed: outcome.failed,
        blocked: outcome.blocked,
      });
    } else if (finalStatus === 'blocked') {
      emit(
        'done',
        'warn',
        `Run blocked: ${outcome.blocked} test(s) could not be verified (prerequisite failed); ${outcome.passed} passed.`,
        { runId, status: finalStatus, passed: outcome.passed, blocked: outcome.blocked },
      );
    } else {
      emit('done', 'info', `Run ${finalStatus}.`, { runId, status: finalStatus });
    }

    return { runId, status: finalStatus, reportPath, suite, outcome };
  } catch (err) {
    // Catch-all: keep the run recoverable and always return a summary.
    emit('done', 'error', `Run failed: ${errMsg(err)}`, { stack: errStack(err) });
    let reportPath: string | undefined;
    try {
      reportPath = (
        await finalizeReport(
          store,
          runDir,
          run,
          project,
          'error',
          plan,
          outcome,
          triageEntries,
          artifactFiles,
          externalDependencies,
          computeMockedRequestCounts(mockServerHandle),
          noteStoreOk,
          noteStoreFailure,
          { generationStats, coverage: coverageSummary },
        )
      ).reportPath;
    } catch {
      /* report is best-effort on the failure path */
    }
    setStatus('error', { finishedAt: nowIso() });
    return { runId, status: 'error', reportPath, outcome: outcome ?? undefined };
  } finally {
    // Always tear down a white-box launch, regardless of how the run ended.
    if (launchHandle) {
      try {
        await launchHandle.stop();
        emit('launch', 'debug', '[launch] App stopped.');
      } catch (err) {
        emit('launch', 'warn', `[launch] Failed to stop app: ${errMsg(err)}`, { stack: errStack(err) });
      }
    }
    if (mockServerHandle) {
      try {
        await mockServerHandle.stop();
        emit('launch', 'debug', '[launch] Mock server stopped.');
      } catch (err) {
        emit('launch', 'warn', `[launch] Failed to stop mock server: ${errMsg(err)}`, {
          stack: errStack(err),
        });
      }
    }
    // A checkpoint is only meaningful while the run is 'paused' — once it
    // reaches any other terminal state, there is nothing left to resume, so
    // clean it up rather than leaving a stale file behind.
    // (Cast: TS narrows `currentStatus` to its try-entry type ('pending') for
    // any read inside `finally`, since it can't prove how far the try got
    // before throwing — the runtime value can genuinely be 'paused' here.)
    if ((currentStatus as RunStatus) !== 'paused') {
      await deleteCheckpoint(runDir);
    }
  }
}

/**
 * Resolve the planning provider with health-gated fallback.
 *
 * - Auto path (no explicit id): auto-select the best ready provider for 'plan'.
 * - Explicit path: probe the requested provider's health. If it is ready+authenticated
 *   use it; otherwise fall back to the first OTHER ready provider for 'plan' (emitting a
 *   warn). Returns undefined only when no provider is ready at all.
 */
export async function resolveProvider(
  id: RunOptions['provider'],
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void,
): Promise<ProviderAdapter | undefined> {
  const router = new ProviderRouter();
  if (!id) {
    const selected = await router.select('plan');
    return selected?.provider;
  }
  // Explicit provider requested — verify it is actually usable before committing.
  const requested = router.get(id);
  if (requested) {
    const health = await requested.health();
    if (health.status === 'ready' && health.authenticated) {
      return requested;
    }
    // Unhealthy explicit provider: try to fall back to the other ready provider.
    const fallback = await router.firstReady('plan', { exclude: id });
    if (fallback) {
      emit(
        'plan',
        'warn',
        `Provider "${id}" is not ready (${health.status}, authenticated=${health.authenticated}); falling back to "${fallback.id}".`,
        { requested: id, status: health.status, authenticated: health.authenticated, fallback: fallback.id },
      );
      return fallback;
    }
    // No fallback available — surface the unhealthy detail so the caller can act.
    emit(
      'plan',
      'warn',
      `Provider "${id}" is not ready (${health.status}, authenticated=${health.authenticated}) and no fallback is available: ${health.detail}`,
    );
    return undefined;
  }
  // Unknown explicit id — try any ready provider before giving up.
  return (await router.firstReady('plan')) ?? undefined;
}

/**
 * Attempt to get an AI-authored plan for the given (already-built) prompt:
 * one attempt with `provider`, one same-provider retry on ANY failure (cheap
 * insurance against a one-off CLI hiccup/timeout — the only retry available
 * at all when no second provider is configured), and — only for failures
 * classified retryable (a provider-level fault, or a truncated JSON response;
 * see PlanParseFailureReason) — one attempt with a different ready provider.
 *
 * Returns null (never synthesizePlan()) once every attempt is exhausted, so
 * the caller decides what "nothing came back" means for its scope: a single
 * unscoped plan falls back to the smoke plan, while one failed batch within a
 * larger plan (see runPlanPhase) just contributes zero items for that batch.
 */
/** Exported for tests — see the doc-comment above for behavior. */
export async function attemptPlanCompletion(
  provider: ProviderAdapter,
  prompt: string,
  project: Project,
  opts: RunOptions,
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void,
  overrides?: OrchestratorOverrides,
  recordUsage?: UsageRecorder,
  task: string | null = null,
): Promise<{ plan: TestPlan } | { plan: null; reason: string; failureReason?: PlanParseFailureReason }> {
  // Attempt a single completion with one provider; classifies the outcome so the
  // caller can decide whether to retry with a fallback.
  const attempt = async (
    p: ProviderAdapter,
  ): Promise<
    | { plan: TestPlan }
    | { plan: null; retryable: boolean; reason: string; failureReason?: PlanParseFailureReason }
  > => {
    try {
      const completion = await p.complete(prompt, {
        mode: 'plan',
        cwd: project.repoPath ?? undefined,
        // Cancellation kills the in-flight provider CLI instead of letting a
        // cancelled run keep burning tokens; the adapter resolves ok:false,
        // and the pipeline's next boundary check turns that into 'cancelled'.
        signal: opts.signal,
        taskType: 'plan-generate',
      });
      if (completion.model) {
        emit('plan', 'debug', `plan-generate used model=${completion.model} effort=${completion.effort}.`);
      }
      recordUsage?.('plan', task, p.id, completion.raw);
      if (completion.ok && completion.text) {
        const parsed = parsePlanWithDiagnostics(completion.text, opts.testingScope ?? 'both');
        if (parsed.plan) return { plan: parsed.plan };
        // A truncated response (output cut off before the JSON object closed —
        // the likely cause when a large functionality inventory pushes the
        // model past its response-length limit) is transient: the identical
        // request may well complete on a retry, so it's treated the same as a
        // provider-level fault. Malformed-but-complete JSON or an empty
        // response is NOT retried against a different provider — a different
        // provider is unlikely to parse any differently against the same
        // well-formed prompt.
        const retryable = parsed.failureReason === 'truncated';
        const reason = `unparseable plan response (${parsed.failureReason ?? 'unknown'})`;
        emit(
          'plan',
          'warn',
          `Could not parse plan JSON from "${p.id}" (${parsed.failureReason ?? 'unknown'}).`,
        );
        return { plan: null, retryable, reason, failureReason: parsed.failureReason };
      }
      // ok:false is a provider-level failure → eligible for one fallback retry.
      emit('plan', 'warn', `Provider "${p.id}" returned no usable plan (${completion.detail}).`);
      return { plan: null, retryable: true, reason: completion.detail || 'provider returned no usable plan' };
    } catch (err) {
      // A thrown completion is a provider-level failure → eligible for one fallback retry.
      emit('plan', 'warn', `Planning provider "${p.id}" threw: ${errMsg(err)}.`, { stack: errStack(err) });
      return { plan: null, retryable: true, reason: errMsg(err) };
    }
  };

  let last = await attempt(provider);
  if (last.plan) return last;

  // Same-provider retry: a one-off CLI hiccup/timeout/truncated response is
  // often transient, and with a single-provider setup the fallback-provider
  // step below is otherwise a no-op — cheap insurance before giving up.
  emit('plan', 'info', `Retrying plan with the same provider "${provider.id}" after: ${last.reason}`);
  // Only worth waiting out when the failure is a credits/quota exhaustion that plausibly
  // clears itself briefly — a truncated-JSON or other transient provider hiccup is not helped
  // by a fixed pause, so retry it immediately instead of paying the delay unconditionally.
  if (classifyTransientFailure(last.reason) === 'credits-exhausted') {
    await delay(PLAN_SAME_PROVIDER_RETRY_DELAY_MS);
  }
  const retried = await attempt(provider);
  if (retried.plan) return retried;
  last = retried;

  // One-time provider fallback: only when the failure was classified retryable
  // (provider-level fault, or a truncated response), a real router is in play
  // (no injected override), and a DIFFERENT ready provider exists.
  if (last.retryable && !overrides?.provider) {
    const fallback = await new ProviderRouter().firstReady('plan', { exclude: provider.id });
    if (fallback) {
      emit('plan', 'warn', `Retrying plan with fallback provider "${fallback.id}".`, {
        primary: provider.id,
        fallback: fallback.id,
      });
      const second = await attempt(fallback);
      if (second.plan) return second;
      last = second;
    }
  }

  return { plan: null, reason: last.reason, failureReason: last.failureReason };
}

/**
 * Run the model to obtain a plan, falling back to a synthesized smoke plan
 * only once every attempt (including retries — see attemptPlanCompletion) is
 * exhausted.
 *
 * A large functionality inventory is planned across multiple smaller batches,
 * sized by estimated scenario volume rather than raw unit count (see
 * PLAN_BATCH_WEIGHT_BUDGET, buildWeightedBatches) instead of one monolithic
 * request — asking the model for a single unbounded JSON response covering
 * the entire app's surface is what makes output-length truncation likely in
 * the first place. If a batch still comes back truncated after
 * attemptPlanCompletion's own retries/fallback are exhausted, it is split in
 * half by weight and each half retried recursively (see planBatch,
 * PLAN_MAX_SPLIT_DEPTH) rather than giving up on the whole batch outright.
 * A batch that ultimately fails contributes zero items (NOT its own smoke
 * fallback, which wouldn't make sense scoped to a handful of known units) —
 * its units simply stay uncovered for the coverage-feedback loop to pick up
 * afterward. Only a total wipeout (no batch produced anything at all) falls
 * back to synthesizePlan().
 */

/**
 * Greedily group units into batches whose estimateUnitWeight() sum stays within
 * `weightBudget`, also capping each batch at `maxUnits` regardless of weight, as a
 * structural safety net. A single unit whose own weight already exceeds the budget
 * still gets its own batch — a unit can't be split further.
 *
 * `weightBudget`/`maxUnits` default to the production constants; overridable so tests
 * can exercise the over-budget-single-unit edge case without needing a unit whose
 * estimateUnitWeight() genuinely exceeds the real budget.
 *
 * Exported for tests.
 */
export function buildWeightedBatches(
  units: FunctionalityUnit[],
  weightBudget = PLAN_BATCH_WEIGHT_BUDGET,
  maxUnits = PLAN_BATCH_MAX_UNITS,
): FunctionalityUnit[][] {
  const batches: FunctionalityUnit[][] = [];
  let current: FunctionalityUnit[] = [];
  let currentWeight = 0;
  for (const u of units) {
    const w = estimateUnitWeight(u);
    if (current.length > 0 && (currentWeight + w > weightBudget || current.length >= maxUnits)) {
      batches.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(u);
    currentWeight += w;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Split units into two halves with roughly equal estimateUnitWeight() sums, cutting
 * at unit boundaries only (a unit's scenarios always land in exactly one half). Used
 * to shrink a batch that truncated even after attemptPlanCompletion's own retries —
 * an index-based half split could leave one half still scenario-heavy and truncating
 * again, while a weight-based cut balances both halves' expected output volume.
 *
 * Exported for tests.
 */
export function splitUnitsByWeight(units: FunctionalityUnit[]): [FunctionalityUnit[], FunctionalityUnit[]] {
  const total = units.reduce((sum, u) => sum + estimateUnitWeight(u), 0);
  const half = total / 2;
  let running = 0;
  let cut = 1;
  for (let i = 0; i < units.length; i++) {
    running += estimateUnitWeight(units[i]!);
    if (running >= half) {
      cut = i + 1;
      break;
    }
  }
  // Guard against a degenerate cut leaving one side empty (e.g. one dominant unit).
  cut = Math.max(1, Math.min(cut, units.length - 1));
  return [units.slice(0, cut), units.slice(cut)];
}

export async function runPlanPhase(
  provider: ProviderAdapter,
  project: Project,
  opts: RunOptions,
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void,
  overrides?: OrchestratorOverrides,
  repoIndex?: PlanRepoContext,
  recordUsage?: UsageRecorder,
): Promise<TestPlan> {
  const units = repoIndex?.functionality ?? [];
  const totalWeight = units.reduce((sum, u) => sum + estimateUnitWeight(u), 0);

  if (totalWeight <= PLAN_BATCH_WEIGHT_BUDGET && units.length <= PLAN_BATCH_MAX_UNITS) {
    const prompt = buildPlanPrompt(project, opts, repoIndex);
    const result = await attemptPlanCompletion(
      provider,
      prompt,
      project,
      opts,
      emit,
      overrides,
      recordUsage,
      'initial',
    );
    if (result.plan) return { ...result.plan, planSource: 'ai' };
    emit('plan', 'warn', `Synthesizing fallback plan (reason: ${result.reason}).`);
    return {
      ...synthesizePlan(project, opts.testingScope ?? 'both'),
      planSource: 'fallback',
      fallbackReason: result.reason,
    };
  }

  const batches = buildWeightedBatches(units);
  emit(
    'plan',
    'info',
    `Planning ${units.length} unit(s) across ${batches.length} batch(es) (weight budget ${PLAN_BATCH_WEIGHT_BUDGET}, max ${PLAN_BATCH_MAX_UNITS} unit(s)/batch).`,
  );

  const items: TestPlanItem[] = [];
  const failedBatches: string[] = [];

  // Plans one batch, splitting it in half by weight and retrying each half
  // (up to PLAN_MAX_SPLIT_DEPTH times) if attemptPlanCompletion exhausts its
  // own retries and still reports a truncated response — the batch's own
  // weight estimate under-shot the model's actual output for these units.
  // `batchIndex`/`totalBatches` identify the top-level batch a call (or, after
  // splitting, a sub-batch) descends from — stable across recursion so
  // progress events and prompt text ("batch N of M") stay meaningful even
  // after a split; `label` (e.g. "2/4" then "2/4a", "2/4b") disambiguates
  // sub-batches from the same top-level slot in logs.
  const planBatch = async (
    batchUnits: FunctionalityUnit[],
    batchIndex: number,
    label: string,
    depth: number,
  ): Promise<void> => {
    const prompt = buildBatchPlanPrompt(project, opts, batchUnits, batchIndex + 1, batches.length, repoIndex);
    emit('plan', 'info', `Planning batch ${label} (${batchUnits.length} unit(s)).`);
    const result = await attemptPlanCompletion(
      provider,
      prompt,
      project,
      opts,
      emit,
      overrides,
      recordUsage,
      label,
    );
    if (result.plan) {
      items.push(...result.plan.items);
      emit('plan', 'info', `Batch ${label} generated ${result.plan.items.length} item(s).`, {
        kind: 'plan-batch',
        batchIndex,
        totalBatches: batches.length,
        label,
        items: result.plan.items,
        status: 'ok',
      });
      return;
    }

    if (result.failureReason === 'truncated' && batchUnits.length > 1 && depth < PLAN_MAX_SPLIT_DEPTH) {
      const [left, right] = splitUnitsByWeight(batchUnits);
      emit(
        'plan',
        'info',
        `Batch ${label} still truncated after retries; splitting ${batchUnits.length} unit(s) into ` +
          `${left.length} + ${right.length} by weight and retrying.`,
      );
      await planBatch(left, batchIndex, `${label}a`, depth + 1);
      await planBatch(right, batchIndex, `${label}b`, depth + 1);
      return;
    }

    failedBatches.push(`batch ${label}: ${result.reason}`);
    emit(
      'plan',
      'warn',
      `Batch ${label} produced no usable plan (${result.reason}); its units will be left for the ` +
        'coverage-feedback loop.',
      {
        kind: 'plan-batch',
        batchIndex,
        totalBatches: batches.length,
        label,
        items: [],
        status: 'failed',
        reason: result.reason,
      },
    );
  };

  for (let i = 0; i < batches.length; i++) {
    if (opts.signal?.aborted) break;
    await planBatch(batches[i]!, i, `${i + 1}/${batches.length}`, 0);
  }

  if (items.length === 0) {
    const reason = failedBatches.length > 0 ? failedBatches.join('; ') : 'no batch produced any items';
    emit('plan', 'warn', `Synthesizing fallback plan (reason: ${reason}).`);
    return {
      ...synthesizePlan(project, opts.testingScope ?? 'both'),
      planSource: 'fallback',
      fallbackReason: reason,
    };
  }

  return {
    summary: `Planned ${items.length} item(s) across ${batches.length} batch(es) covering ${units.length} detected unit(s).`,
    items,
    planSource: 'ai',
    ...(failedBatches.length > 0
      ? {
          fallbackReason: `${failedBatches.length}/${batches.length} batch(es) failed: ${failedBatches.join('; ')}`,
        }
      : {}),
  };
}

/**
 * Insert `tests` rows for a batch of GENERATE-produced specs. A freshly generated
 * spec (found in `items` by reqTag) gets ONE row per scenario the plan requested —
 * so Total/Passed/Failed/etc. reflect real test-case counts, matching what the
 * report already shows (outcome.results is scenario-level), not spec-file counts.
 * A carried-forward spec (no matching item — copied bytes from a prior run,
 * already at whatever granularity that run used) gets a single row, as before.
 *
 * Rows are keyed positionally (`${reqTag/title key}#${scenarioIndex}`) rather
 * than by the model's own scenario title text, since that text isn't known
 * until execution. persistResults matches results back to these rows by
 * encounter order within the same reqTag — safe because generate.ts requires
 * scenarios to be emitted as one test() each, in the same order they were
 * planned, so Playwright's report preserves that order too.
 */
function registerSpecRows(
  store: HealixStore,
  runId: string,
  projectDir: string,
  spec: GeneratedSpec,
  items: TestPlanItem[],
  testIdByKey: Map<string, string>,
): void {
  const reqTag = (spec.reqTag ?? '').trim();
  const item = reqTag.length > 0 ? items.find((it) => (it.reqTag ?? it.id) === reqTag) : undefined;
  const specPath = relative(projectDir, spec.path);
  const base = stableKey(spec.reqTag, spec.title);

  if (!item || item.scenarios.length === 0) {
    const test = store.insertTest({
      runId,
      title: spec.title,
      reqTag: spec.reqTag ?? null,
      tier: (spec.tier ?? null) as Tier | null,
      status: 'pending',
      specPath,
      description: null,
      details: item?.intent ?? null,
    });
    // `base` ignores title when reqTag is set (see stableKey), so repeated calls
    // for the same reqTag — as happens once per scenario when carrying a
    // multi-scenario spec forward — would otherwise collide on one bare key
    // and silently overwrite each other's row, orphaning all but the last.
    // Index each occurrence instead, mirroring the `${base}#i` scheme below,
    // so persistResults' positional matching finds every one of them.
    let i = 0;
    while (testIdByKey.has(`${base}#${i}`)) i += 1;
    testIdByKey.set(`${base}#${i}`, test.id);
    if (i === 0) testIdByKey.set(base, test.id);
    return;
  }

  item.scenarios.forEach((s, i) => {
    const test = store.insertTest({
      runId,
      title: `${spec.title} — ${s.kind}: ${s.description}`,
      reqTag: spec.reqTag ?? null,
      tier: (spec.tier ?? null) as Tier | null,
      status: 'pending',
      specPath,
      description: s.description,
      details: item.intent,
    });
    testIdByKey.set(`${base}#${i}`, test.id);
  });
}

/**
 * Persist execution results. Each spec's scenario results are matched back, IN
 * ENCOUNTER ORDER, to the positionally-keyed rows registerSpecRows inserted for
 * that reqTag — the first scenario result for a reqTag maps to `#0`, the second
 * to `#1`, and so on. A result with no matching spec, or more results than
 * scenarios were registered for (unexpected but not fatal), gets its own
 * fallback row keyed by its own title so it's still recorded exactly once.
 */
function persistResults(
  store: HealixStore,
  runId: string,
  specs: GeneratedSpec[],
  outcome: ExecOutcome,
  testIdByKey: Map<string, string>,
  noteStoreOk: () => void,
  noteStoreFailure: (op: string, err: unknown) => void,
): void {
  const scenarioIndexByReqTag = new Map<string, number>();

  for (const r of outcome.results) {
    // The generated test titles are the model's own words, but they are guaranteed
    // to carry the "[REQ:<tag>]" marker on EVERY scenario test (see generate.ts's
    // per-test tagging requirement). Recover the tag from the result title first —
    // it keys directly onto the rows inserted in GENERATE — and only fall back to
    // normalized-title matching when no tag survived.
    const tagFromTitle = extractReqTag(r.title);
    const matched = specs.find(
      (s) =>
        (tagFromTitle !== null && (s.reqTag ?? '').trim() === tagFromTitle) ||
        stableKey(undefined, s.title) === stableKey(undefined, r.title),
    );
    // registerSpecRows keyed every row purely off the plan item's own reqTag
    // (`req:<tag>#<i>` — see stableKey), so the title's own "[REQ:<tag>]" is
    // ALREADY enough to rebuild that key. Deriving `base` from `matched`
    // instead (as before) made positional matching depend on `specs.find()`
    // succeeding first — any mismatch between THIS call's `specs` and the
    // original GENERATE-time list (a narrower/stale batch, a validation
    // rewrite, ...) silently defeated matching for an otherwise-findable row,
    // forking a same-titled orphan instead of reusing the one already reserved.
    const base = tagFromTitle
      ? stableKey(tagFromTitle, r.title)
      : matched
        ? stableKey(matched.reqTag, matched.title)
        : null;

    let testId: string | undefined;
    if (base) {
      const reqTagKey = tagFromTitle ?? matched?.reqTag ?? base;
      const scenarioIndex = scenarioIndexByReqTag.get(reqTagKey) ?? 0;
      scenarioIndexByReqTag.set(reqTagKey, scenarioIndex + 1);
      testId =
        testIdByKey.get(`${base}#${scenarioIndex}`) ??
        (scenarioIndex === 0 ? testIdByKey.get(base) : undefined);
      // The exact positional slot missed (e.g. results arrived in a different
      // order than registerSpecRows assumed) — before minting a brand-new,
      // metadata-less row below, claim any row GENERATE already registered
      // for this reqTag that's still awaiting its result. This is what a
      // correctly-ordered match would have found anyway; skipping it is what
      // used to silently fork one reqTag into two rows sharing the same
      // title, one fully populated and one orphaned (null tier/description).
      if (!testId) testId = findPendingSlot(store, testIdByKey, base);
      if (testId) store.updateTestTitle(testId, r.title);
    }
    if (!testId) {
      // No matching pre-registered row (no spec matched, or more results than
      // scenarios were planned) — insert a fallback row, keyed by its own
      // title so repeated overflow results don't collide with each other.
      const fallbackKey = stableKey(tagFromTitle ?? matched?.reqTag, r.title);
      testId = testIdByKey.get(fallbackKey);
      if (!testId) {
        const fallback = store.insertTest({
          runId,
          title: r.title,
          reqTag: matched?.reqTag ?? tagFromTitle,
          tier: (matched?.tier ?? null) as Tier | null,
          status: r.status as TestStatus,
        });
        testId = fallback.id;
        testIdByKey.set(fallbackKey, testId);
      }
    }

    try {
      // Copy the parent test row's description/details onto its result — results
      // have no independent source for this content, so it just mirrors the
      // TestCase registered for it in GENERATE.
      const parentTest = store.getTest(testId);
      store.insertResult({
        testId,
        status: r.status as TestStatus,
        durationMs: r.durationMs ?? null,
        error: r.error ?? null,
        artifactsJson: r.artifacts && r.artifacts.length > 0 ? JSON.stringify(r.artifacts) : null,
        description: parentTest?.description ?? null,
        details: parentTest?.details ?? null,
        stepsJson: r.steps && r.steps.length > 0 ? JSON.stringify(r.steps) : null,
      });
      noteStoreOk();
    } catch (err) {
      /* best-effort persistence */
      noteStoreFailure('insertResult', err);
    }
    try {
      // Keep the test row's status in sync — readers of `tests` (e.g. the CLI
      // report command) would otherwise see every test as eternally 'pending'.
      // Each row now maps to exactly one scenario result (positionally or via
      // the fallback path), so a direct update is correct — no aggregation needed.
      store.updateTestStatus(testId, r.status as TestStatus);
      noteStoreOk();
    } catch (err) {
      noteStoreFailure('updateTestStatus', err);
    }
  }
}

/** Pull the "[REQ:<tag>]" marker out of an executed test's title, if present. */
/**
 * Pick the exploration mechanism from how the project is actually configured:
 * a repo path means white-box source is available, so Codegen can read and
 * generate real specs from it (repo path wins when both are set); a base-URL-
 * only project has no source to read, so Computer-use (live exploration) is
 * the only mode that makes sense. No longer a user choice (see RunOptions.
 * explorationMode, which still allows an explicit override for tests/CLI).
 */
function deriveExplorationMode(project: Project): ExplorationMode {
  if (project.repoPath) return 'codegen';
  if (project.baseUrl) return 'computer-use';
  return 'codegen';
}

function extractReqTag(title: string): string | null {
  const m = title.match(/\[REQ:([^\]]+)\]/i);
  const tag = m?.[1]?.trim();
  return tag && tag.length > 0 ? tag : null;
}

/** Stable identity for matching a result back to its spec: reqTag when present, else normalized title. */
function stableKey(reqTag: string | null | undefined, title: string): string {
  const tag = reqTag?.trim();
  if (tag && tag.length > 0) return `req:${tag}`;
  return `title:${title.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

/**
 * Last resort before persistResults would otherwise mint an orphan row: scan
 * this reqTag's registered `${base}#N` slots for one still sitting at
 * 'pending' (i.e. GENERATE reserved it but no result has claimed it yet) and
 * hand that back instead. Positional matching normally finds the right slot
 * on its own; this only fires when a result's encounter order didn't line up
 * with registration order, and it's what stops that mismatch from forking a
 * reqTag into two same-titled rows — one real, one metadata-less.
 */
function findPendingSlot(
  store: HealixStore,
  testIdByKey: Map<string, string>,
  base: string,
): string | undefined {
  const prefix = `${base}#`;
  for (const [key, id] of testIdByKey) {
    if (!key.startsWith(prefix)) continue;
    if (store.getTest(id)?.status === 'pending') return id;
  }
  return undefined;
}

/**
 * Copy each carried-forward test's spec file from the base run's own suite dir
 * into THIS run's suite dir (ctx.projectDir), and reconstruct a GeneratedSpec
 * for it so it flows through EXECUTE/persistResults exactly like a freshly
 * AI-generated one. A test with no on-disk file left (missing/moved since the
 * base run) is skipped rather than failing the whole run — it simply won't be
 * part of this run's suite, and a subsequent Fresh/Top-up run can regenerate it.
 */
async function hydrateCarriedSpecs(
  ctx: TestModeContext,
  projectId: string,
  baseRunId: string,
  tests: TestCase[],
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void,
): Promise<GeneratedSpec[]> {
  const baseSuiteDir = join(projectsDir(), projectId, 'runs', baseRunId, 'suite');
  const specs: GeneratedSpec[] = [];
  for (const t of tests) {
    if (!t.specPath) continue;
    const srcAbs = join(baseSuiteDir, t.specPath);
    const destAbs = join(ctx.projectDir, t.specPath);
    try {
      await mkdir(dirname(destAbs), { recursive: true });
      await copyFile(srcAbs, destAbs);
      const contents = await readFile(destAbs, 'utf-8');
      specs.push({
        path: destAbs,
        title: t.title,
        reqTag: t.reqTag ?? undefined,
        tier: (t.tier ?? 'tierA-public') as Tier,
        contents,
      });
    } catch (err) {
      emit(
        'generate',
        'warn',
        `Could not carry forward "${t.title}" (spec file unavailable): ${errMsg(err)}`,
        {
          specPath: t.specPath,
        },
      );
    }
  }
  return specs;
}

/**
 * Reconstruct GeneratedSpec[] for a resumed run's already-generated specs by
 * reading each file back from disk. Unlike hydrateCarriedSpecs (which copies
 * bytes from a DIFFERENT run's suite dir for top-up/reuse), this is the SAME
 * run directory the original attempt wrote into — nothing to copy, only to
 * read back. Throws if a file has gone missing since the checkpoint was
 * written (e.g. manually deleted) — resume treats that as a hard error rather
 * than silently continuing with a smaller suite than the checkpoint promised.
 */
async function hydrateCheckpointedSpecs(
  ctx: TestModeContext,
  checkpoint: ResumeCheckpoint,
): Promise<GeneratedSpec[]> {
  const specs: GeneratedSpec[] = [];
  for (const s of checkpoint.generatedSpecs) {
    const abs = join(ctx.projectDir, s.path);
    const contents = await readFile(abs, 'utf-8');
    specs.push({ path: abs, title: s.title, reqTag: s.reqTag, tier: s.tier, contents });
  }
  return specs;
}

/** Build + write report.json and report.html. Returns the report path (best-effort). */
async function finalizeReport(
  store: HealixStore,
  runDir: string,
  run: Run,
  project: Project,
  status: RunStatus,
  plan: TestPlan | null,
  outcome: ExecOutcome | null,
  triage: ReportTriageEntry[],
  artifacts: string[],
  dependencies: ExternalDependency[],
  mockedRequestCounts: Record<string, number>,
  noteStoreOk: () => void,
  noteStoreFailure: (op: string, err: unknown) => void,
  degradation?: {
    generationStats?: { requestedItems: number; acceptedItems: number };
    coverage?: ReportCoverageSummary | null;
  },
): Promise<{ reportPath: string | undefined }> {
  const effectivePlan: TestPlan = plan ?? { summary: 'No plan generated.', items: [] };
  const report = buildReport({
    run: { ...run, status },
    project,
    plan: effectivePlan,
    outcome,
    triage,
    tests: store.listTests(run.id),
    artifacts,
    dependencies,
    mockedRequestCounts,
    generation: degradation?.generationStats,
    coverage: degradation?.coverage ?? null,
  });
  const reportsDir = join(runDir, 'reports');
  const reportPath = join(reportsDir, 'report.json');
  try {
    await writeJson(reportPath, report);
    await writeFile(
      join(reportsDir, 'report.html'),
      renderReportHtml(report, { reportDir: reportsDir }),
      'utf8',
    );
    noteStoreOk();
    return { reportPath };
  } catch (err) {
    noteStoreFailure('finalizeReport', err);
    return { reportPath: undefined };
  }
}

/**
 * Produce the suite bundle. Prefers the mode's own export() (when implemented),
 * falling back to the standalone exportSuite() if it throws. The mode's export()
 * may legitimately be a no-op default, so an empty/failed result still falls back.
 */
async function exportViaMode(
  mode: TestMode,
  ctx: TestModeContext,
  runDir: string,
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void,
): Promise<SuiteBundle> {
  try {
    return await mode.export(ctx);
  } catch (err) {
    emit('export', 'debug', `mode.export() failed; falling back to exportSuite(): ${errMsg(err)}`);
    return exportSuite({ suiteDir: ctx.projectDir, outDir: join(runDir, 'export') });
  }
}

/** Sentinel resolved by raceAbort() when the signal wins the race. */
const ABORTED = Symbol('healix.run.aborted');

/**
 * Race a promise against an AbortSignal. Resolves with the promise's value, or
 * with the ABORTED sentinel the moment the signal fires — the underlying
 * promise is left to settle in the background and its result is discarded.
 * A sentinel (rather than a rejection) keeps cancellation on the normal
 * control-flow path: run() must resolve 'cancelled', never reject.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Reject after `ms` if `p` has not settled, AND abort `controller` — so the
 * underlying CLI child process is actually killed instead of left running,
 * untracked, in the background after this call is abandoned (a single slow
 * provider call must not stall triage, but it also must not outlive it).
 * Exported for tests.
 */
export function withTimeoutAbort<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Launch stderr that suggests the repo's dependencies were never installed —
 * the one launch failure Healix can recover from by itself (install + retry).
 */
export function looksLikeMissingDeps(message: string): boolean {
  return /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|command not found|not recognized as an internal|ENOENT|node_modules/i.test(
    message,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tally the mock server's request log by dependency id, for the report. */
function computeMockedRequestCounts(handle: MockServerHandle | null): Record<string, number> {
  if (!handle) return {};
  const counts: Record<string, number> = {};
  for (const r of handle.requestLog) counts[r.dependencyId] = (counts[r.dependencyId] ?? 0) + 1;
  return counts;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}
