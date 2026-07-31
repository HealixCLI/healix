import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { projectsDir } from '../env/app-data.js';
import { getStore, type HealixStore } from '../storage/store.js';
import type {
  PauseReason,
  Project,
  ProjectCredential,
  Run,
  RunStatus,
  SuiteMode,
  TestCase,
  TestStatus,
  Tier,
  TriageResultRow,
} from '../storage/types.js';
import { ProviderRouter } from '../providers/router.js';
import { ABSOLUTE_BACKSTOP_MS } from '../providers/types.js';
import type { ProviderAdapter } from '../providers/types.js';
import { extractUsage } from '../providers/usage.js';
import type { UsageRecorder } from '../providers/usage.js';
import { getTestMode } from '../modes/registry.js';
import type {
  ExecOutcome,
  ExplorationArtifact,
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
import { runExplorePhase, splitStaticUnitsForExplore, assessExplorationUsefulness } from './explore.js';
import { deriveRegionCodesFromText } from '../browser/seed-discovery.js';
import { identifyExplorationGaps, runGapFillingPass } from './gap-fill.js';
import { mergeCrawlResults } from '../browser/crawler.js';
import { loadExplorationCache, persistExplorationCache } from './exploration-cache.js';
import { exportSuite } from '../export/index.js';
import { createTriageEngine } from '../triage/index.js';
import type { TriageBatchItem, TriageInput, TriageResult } from '../triage/types.js';
import { summarizeTriageGroups } from '../triage/grouping.js';
import type { GroupingSummaryUnavailableReason } from '../triage/grouping.js';
import { correlateBySignature } from '../triage/correlate.js';
import {
  buildPlanPrompt,
  buildBatchPlanPrompt,
  parsePlanWithDiagnostics,
  synthesizePlan,
  type PlanRepoContext,
  type PlanParseFailureReason,
} from './plan.js';
import { estimateUnitWeight, type FunctionalityUnit } from '../target/functionality-index.js';
import { computeRepoSourceHash, indexSource } from '../target/source-index.js';
import { loadSourceContext, persistSourceContext } from '../target/context-store.js';
import { enrichSourceContextForPlan } from '../target/deep-dive.js';
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
import { readRunConfigSnapshot, writeRunConfigSnapshot } from './run-config.js';
import { computeKbBackfillRows } from './kb-backfill.js';
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

/**
 * Outer safety net for the best-effort AI triage enrichment — wraps the
 * WHOLE engine.analyzeBatch()/summarizeTriageGroups() promise via
 * withTimeoutAbort, independent of whatever timeout the provider call inside
 * it uses. Must stay greater than triage/index.ts's own ANALYZE_TIMEOUT_MS
 * (now ABSOLUTE_BACKSTOP_MS — the hard cap triage passes to
 * provider.complete()), or this outer timer fires first and kills every
 * triage call before its own budget is ever reached — exactly the bug that
 * made triage time out even on the cheap/default model tier. Kept slightly
 * larger, purely as a margin for the fixed cost of prompt-building/
 * reconciliation around the provider call — the real day-to-day enforcement
 * is the provider's own sliding-window idle timeout, so this should rarely
 * ever be the thing that actually fires.
 */
const TRIAGE_ANALYZE_TIMEOUT_MS = ABSOLUTE_BACKSTOP_MS + 60_000;
/**
 * Historical note: this used to cap how many failures (at most) got escalated
 * to AI triage analysis (raised over time from 3 to 8 to 20). That cap is
 * gone — EVERY failure with a rule baseline is now escalated to AI, so a run
 * with more failures than any prior fixed limit no longer leaves the
 * remainder stuck on the generic low-confidence baseline just because they
 * didn't make the cut. If the AI call itself errors, times out, or returns an
 * unparseable reply for a given item, that item simply keeps its
 * classifyByRules() baseline — surfaced to the user via
 * TriageResult.verdictSource ('rule_fallback' vs 'ai_reviewed') rather than
 * silently looking identical to a reviewed-and-agreed verdict. Grouped into
 * TRIAGE_AI_BATCH_SIZE-sized batches, each triaged with ONE provider call
 * covering every item in the group (see TriageEngine.analyzeBatch) instead of
 * one call per item — every item still gets its own full evidence block,
 * only the fixed hypothesis/instructions preamble is paid once per batch
 * instead of once per item.
 */
/** How many failures share a single batched AI-triage call. */
const TRIAGE_AI_BATCH_SIZE = 5;
/**
 * On a batch that fails to parse AT ALL (every item still unenriched), halve it
 * and retry each half — same shape as the plan-batch split-and-retry (see
 * PLAN_MAX_SPLIT_DEPTH/splitUnitsByWeight above). A batch that parses but is
 * just missing/malformed for ONE item never triggers this — that item simply
 * keeps its already-computed rule baseline, since triage (unlike Generate)
 * always has one to fall back to.
 */
const TRIAGE_MAX_SPLIT_DEPTH = 3;
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
const PLAN_BATCH_MAX_UNITS = 10;

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
    retryPass(runId: string, hooks?: OrchestratorHooks, signal?: AbortSignal): Promise<RunSummary> {
      return retryPassPipeline(runId, hooks, overrides, signal);
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
    coverageLoopEnabled: checkpoint.runOptions.coverageLoopEnabled,
    coverageTarget: checkpoint.runOptions.coverageTarget,
    retryItemIds: checkpoint.runOptions.retryItemIds,
    maxCostUsd: checkpoint.runOptions.maxCostUsd,
    maxTokens: checkpoint.runOptions.maxTokens,
    signal,
  };
  return runPipeline(resumeOpts, hooks, overrides, { run, checkpoint });
}

/**
 * Regenerate whatever the Knowledge Base flags as 'dropped' for this run,
 * then execute every scenario still 'pending' (freshly regenerated ones and
 * any pre-existing crash-mid-execute survivors) — the single primitive both
 * retryPassPipeline and the in-process coverage-feedback-loop call. Takes
 * `ctx` as a required parameter rather than resolving one itself: the
 * coverage loop already has a live one in scope; retryPassPipeline builds its
 * own before calling this. See docs/design/retry-pass-coverage-kb-redesign.md §3c.
 */
async function regenerateDroppedAndExecutePending(params: {
  ctx: TestModeContext;
  mode: TestMode;
  runId: string;
  store: HealixStore;
  plan: TestPlan;
  emit: (
    phase: OrchestratorPhase | string,
    level: OrchestratorEvent['level'],
    message: string,
    data?: unknown,
  ) => void;
  testIdByKey: Map<string, string>;
  noteStoreOk: () => void;
  noteStoreFailure: (op: string, err: unknown) => void;
}): Promise<{
  specs: GeneratedSpec[];
  outcome: ExecOutcome;
  regeneratedCount: number;
  executedPendingCount: number;
}> {
  const { ctx, mode, runId, store, plan, emit, testIdByKey, noteStoreOk, noteStoreFailure } = params;

  const droppedKb = store.listDroppedPlanKbItems(runId);
  const droppedItems = droppedKb
    .map((kb) => plan.items.find((it) => it.id === kb.planItemId))
    .filter((it): it is TestPlanItem => it !== undefined);

  // Snapshot "pending BEFORE this call touches anything" — must happen
  // BEFORE mode.generate() below, not after: a freshly-regenerated item's
  // scenarios are cascaded to 'pending' by ctx.onKbItemOutcome as part of
  // the SAME generate() call (see updatePlanKbItemStatus's generated ->
  // pending cascade), so querying "pending" afterward would incorrectly
  // catch the item this call JUST regenerated too, executing it twice.
  const kbItems = store.listPlanKbItems(runId);
  const kbItemById = new Map(kbItems.map((k) => [k.id, k]));
  const itemByPlanItemId = new Map(plan.items.map((it) => [it.id, it]));
  const droppedItemIds = new Set(droppedItems.map((it) => it.id));
  const pendingScenariosBefore = store.listPendingPlanKbScenarios(runId).filter((scenario) => {
    const kbItem = kbItemById.get(scenario.kbItemId);
    return !kbItem || !droppedItemIds.has(kbItem.planItemId);
  });

  let newSpecs: GeneratedSpec[] = [];
  if (droppedItems.length > 0) {
    emit('generate', 'info', `Retry: regenerating ${droppedItems.length} dropped item(s).`);
    newSpecs = await mode.generate(ctx, {
      summary: 'Regenerating previously dropped item(s).',
      items: droppedItems,
    });
    for (const spec of newSpecs)
      registerSpecRows(store, runId, ctx.projectDir, spec, droppedItems, testIdByKey, noteStoreFailure);
  }

  // Reconstruct still-pending (generated but never executed) specs from
  // their already-persisted tests rows — no need to regenerate them. One
  // GeneratedSpec per unique spec file (several scenarios can share one).
  // `base` here MUST match the key registerSpecRows originally used
  // (`stableKey(item.reqTag ?? item.id, ...)` — stableKey ignores title
  // entirely once a tag is present, see stableKey below), pre-seeded into
  // testIdByKey using the KB's own durably-stored scenario_index, so
  // persistResults' positional matching finds these EXISTING rows instead of
  // minting new orphans when the reconstructed specs are re-executed.
  const pendingSpecsByPath = new Map<string, GeneratedSpec>();
  for (const scenario of pendingScenariosBefore) {
    if (!scenario.testId) continue;
    const test = store.getTest(scenario.testId);
    if (!test || !test.specPath || !test.specCode) continue;
    const kbItem = kbItemById.get(scenario.kbItemId);
    const planItem = kbItem ? itemByPlanItemId.get(kbItem.planItemId) : undefined;
    const reqTag = planItem ? (planItem.reqTag ?? planItem.id) : (test.reqTag ?? undefined);
    const base = stableKey(reqTag, test.title);
    testIdByKey.set(`${base}#${scenario.scenarioIndex}`, test.id);
    if (!pendingSpecsByPath.has(test.specPath)) {
      pendingSpecsByPath.set(test.specPath, {
        path: join(ctx.projectDir, test.specPath),
        title: planItem?.title ?? test.title,
        reqTag,
        tier: (test.tier ?? 'tierA-public') as Tier,
        contents: test.specCode,
      });
    }
  }
  const pendingSpecs = [...pendingSpecsByPath.values()];

  const toExecute = [...newSpecs, ...pendingSpecs];
  let outcome: ExecOutcome = { passed: 0, failed: 0, blocked: 0, flaky: 0, skipped: 0, results: [] };
  if (toExecute.length > 0) {
    emit(
      'execute',
      'info',
      `Executing ${toExecute.length} spec(s) (${newSpecs.length} regenerated, ${pendingSpecs.length} previously pending).`,
    );
    outcome = await mode.execute(ctx, toExecute);
    persistResults(store, runId, toExecute, outcome, testIdByKey, noteStoreOk, noteStoreFailure);
  }

  return {
    specs: toExecute,
    outcome,
    regeneratedCount: newSpecs.length,
    executedPendingCount: pendingSpecs.length,
  };
}

/**
 * Reconstruct a full ExecOutcome + GeneratedSpec[] picture for a run purely
 * from durable storage — no in-memory state survives between the original
 * runPipeline() call finishing and a later retryPassPipeline() call, so
 * everything needed for coverage/report recomputation has to come from the
 * DB. Recomputes pass/fail/etc. counts from `results` directly (never trusts
 * a stored total), matching mergeExecOutcomes' own convention.
 */
function reconstructRunStateFromDb(
  store: HealixStore,
  runId: string,
  projectDir: string,
): { specs: GeneratedSpec[]; outcome: ExecOutcome } {
  const tests = store.listTests(runId);
  const results = store.listResults(runId);
  const testById = new Map(tests.map((t) => [t.id, t]));

  const items: ExecOutcome['results'] = [];
  for (const r of results) {
    const test = testById.get(r.testId);
    if (!test) continue;
    let artifacts: string[] | undefined;
    if (r.artifactsJson) {
      try {
        artifacts = JSON.parse(r.artifactsJson) as string[];
      } catch {
        artifacts = undefined;
      }
    }
    items.push({
      title: test.title,
      status: r.status,
      durationMs: r.durationMs ?? undefined,
      error: r.error ?? undefined,
      artifacts,
      specFile: test.specPath ?? undefined,
      skipReason: r.skipReason ?? undefined,
    });
  }

  const specsByPath = new Map<string, GeneratedSpec>();
  for (const t of tests) {
    if (!t.specPath || !t.specCode || specsByPath.has(t.specPath)) continue;
    specsByPath.set(t.specPath, {
      path: join(projectDir, t.specPath),
      title: t.title,
      reqTag: t.reqTag ?? undefined,
      tier: (t.tier ?? 'tierA-public') as Tier,
      contents: t.specCode,
    });
  }

  const outcome: ExecOutcome = {
    passed: items.filter((i) => i.status === 'passed').length,
    failed: items.filter((i) => i.status === 'failed').length,
    blocked: items.filter((i) => i.status === 'blocked').length,
    flaky: items.filter((i) => i.status === 'flaky').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    results: items,
  };
  return { specs: [...specsByPath.values()], outcome };
}

/**
 * Simplified white-box relaunch for retry-pass's cold start: detect + launch
 * to get a live baseUrl again, WITHOUT runPipeline's full install-and-retry
 * recovery ladder or mock-server/env-override wiring — a deliberate scope
 * cut given this is a bounded, on-demand recovery pass, not the primary run
 * path. If the original run had env-override-mocked external dependencies,
 * retry-pass does not restart the mock server for them. Black-box projects
 * (baseUrl already set) and pure-reuse-suite runs with no repoPath are
 * no-ops.
 */
async function launchProjectForRetryPass(
  project: Project,
  target: ReturnType<typeof createTargetAdapter>,
  emit: (
    phase: OrchestratorPhase | string,
    level: OrchestratorEvent['level'],
    message: string,
    data?: unknown,
  ) => void,
): Promise<{ baseUrl: string | null | undefined; stop: (() => Promise<void>) | null }> {
  if (project.baseUrl || !project.repoPath) return { baseUrl: project.baseUrl, stop: null };
  emit('launch', 'info', `[launch] (retry-pass) Detecting app in ${project.repoPath}.`);
  const det = await target.detect(project.repoPath);
  const port = await findFreePort(det.port ?? undefined);
  const handle = await target.launch({
    repoPath: project.repoPath,
    startCommand: det.startCommand ?? undefined,
    installCommand: det.installCommand ?? undefined,
    installDir: det.installDir ?? undefined,
    port,
    readyTimeoutMs: 120_000,
  });
  emit('launch', 'info', `[launch] (retry-pass) App relaunched at ${handle.baseUrl}.`);
  return { baseUrl: handle.baseUrl, stop: () => handle.stop() };
}

/**
 * On-demand, same-run recovery: regenerate whatever the Knowledge Base flags
 * as 'dropped' for this run, execute everything still 'pending', and refresh
 * the run's report/coverage in place — no new run row, no base_run_id. The
 * run's original testingScope/provider/PRD/coverage settings are reloaded
 * from run-config.json rather than defaulted. Never rides resumeRun's
 * checkpoint (a completed run has none — see deleteCheckpoint above) and
 * cannot reuse the coverage loop's in-process shape (that only exists while
 * runPipeline() is still on the stack) — this is its own entry point. See
 * docs/design/retry-pass-coverage-kb-redesign.md §3.
 */
async function retryPassPipeline(
  runId: string,
  hooks?: OrchestratorHooks,
  overrides?: OrchestratorOverrides,
  signal?: AbortSignal,
): Promise<RunSummary> {
  const getMode = overrides?.getMode ?? getTestMode;
  const makeTarget = overrides?.makeTarget ?? createTargetAdapter;
  const makeBrowser = overrides?.makeBrowser ?? createBrowserSurface;
  const store = overrides?.store ?? (await getStore());

  const emit = (
    phase: OrchestratorPhase | string,
    level: OrchestratorEvent['level'],
    message: string,
    data?: unknown,
  ): void => {
    try {
      store?.appendEvent(runId, String(phase), message, { level, data });
    } catch {
      /* best-effort */
    }
    try {
      hooks?.onEvent?.({ phase, level, message, data });
    } catch {
      /* never let a hook crash the run */
    }
  };
  const noteStoreOk = (): void => {};
  const noteStoreFailure = (op: string, err: unknown): void => {
    emit('report', 'warn', `Store write failed during retry-pass (${op}): ${errMsg(err)}`);
  };

  if (!store) {
    emit('plan', 'error', 'Storage unavailable (node:sqlite missing); cannot retry-pass.');
    return { runId, status: 'error' };
  }
  const run = store.getRun(runId);
  if (!run) {
    emit('plan', 'error', `Run not found: ${runId}`);
    return { runId, status: 'error' };
  }
  const project = store.getProject(run.projectId);
  if (!project) {
    emit('plan', 'error', `Project not found: ${run.projectId}`);
    return { runId, status: 'error' };
  }
  const runDir = join(projectsDir(), project.id, 'runs', runId);

  // Step 0: reuse the ORIGINAL run's configuration — never default it. See
  // docs/design/retry-pass-coverage-kb-redesign.md §3 step 0.
  const snapshot = await readRunConfigSnapshot(runDir);
  const testingScope = snapshot?.testingScope ?? 'both';

  const provider = overrides?.provider ?? (await resolveProvider(snapshot?.provider, emit));
  if (!provider) {
    emit('plan', 'error', 'No ready provider available for retry-pass.');
    return { runId, status: 'error' };
  }

  let plan: TestPlan;
  try {
    const raw = await readFile(join(runDir, 'plan', 'plan.json'), 'utf-8');
    plan = JSON.parse(raw) as TestPlan;
  } catch (err) {
    emit('plan', 'error', `Could not load this run's plan: ${errMsg(err)}`);
    return { runId, status: 'error' };
  }

  // Lazy backfill for a run that predates the Knowledge Base.
  if (!store.hasPlanKbItems(runId)) {
    emit('plan', 'info', 'No Knowledge Base rows for this run yet; backfilling from plan.json/tests.');
    const tests = store.listTests(runId);
    const results = store.listResults(runId);
    for (const row of computeKbBackfillRows(plan, tests, results)) {
      try {
        store.seedPlanKbItem({
          runId,
          planItemId: row.planItemId,
          title: row.title,
          reqTag: row.reqTag,
          tier: row.tier,
          status: row.status,
          scenarios: row.scenarios,
        });
        noteStoreOk();
      } catch (err) {
        noteStoreFailure('seedPlanKbItem (backfill)', err);
      }
    }
  }

  const droppedCount = store.listDroppedPlanKbItems(runId).length;
  const pendingCount = store.listPendingPlanKbScenarios(runId).length;
  if (droppedCount === 0 && pendingCount === 0) {
    emit('done', 'info', 'Nothing to retry — every planned item already has a generated, executed test.');
    return { runId, status: run.status, retryPassResult: 'nothing-to-retry' };
  }
  emit('plan', 'info', `Retry-pass: ${droppedCount} dropped item(s), ${pendingCount} pending scenario(s).`);

  const target = makeTarget();
  const browser = makeBrowser();
  const launched = await launchProjectForRetryPass(project, target, emit);

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

  const ctx: TestModeContext = {
    projectDir: join(runDir, 'suite'),
    repoPath: project.repoPath,
    baseUrl: launched.baseUrl,
    credentials: project.credentials,
    provider,
    target,
    browser,
    testingScope,
    emit: (phase, message, data) => emit(phase, 'info', message, data),
    onUsage: recordUsage,
    onKbItemOutcome: (planItemId, status) => {
      try {
        store.updatePlanKbItemStatus(runId, planItemId, status);
        noteStoreOk();
      } catch (err) {
        noteStoreFailure('updatePlanKbItemStatus', err);
      }
    },
    signal,
  };
  const mode = getMode(project.mode);

  try {
    store.updateRunStatus(runId, droppedCount > 0 ? 'generating' : 'executing');
  } catch (err) {
    noteStoreFailure('updateRunStatus', err);
  }

  let finalStatus: RunStatus;
  try {
    const testIdByKey = new Map<string, string>();
    await regenerateDroppedAndExecutePending({
      ctx,
      mode,
      runId,
      store,
      plan,
      emit,
      testIdByKey,
      noteStoreOk,
      noteStoreFailure,
    });

    try {
      const removed = store.deleteUnexecutedTests(runId);
      if (removed > 0)
        emit('execute', 'debug', `Dropped ${removed} pre-registered test row(s) that never executed.`);
    } catch (err) {
      noteStoreFailure('deleteUnexecutedTests', err);
    }

    // Full report refresh — merge this pass's work with everything already
    // durably persisted, recompute coverage, rewrite report.json/report.html
    // in place. See docs/design/retry-pass-coverage-kb-redesign.md §3 step 7.
    const { specs: allSpecs, outcome: mergedOutcome } = reconstructRunStateFromDb(
      store,
      runId,
      ctx.projectDir,
    );

    let coverageSummary: ReportCoverageSummary | null = null;
    if (project.repoPath) {
      const cached = loadSourceContext(project.repoPath);
      if (cached && cached.context.units.length > 0) {
        const coverageTarget =
          snapshot?.coverageTarget ??
          (run.suiteMode === 'topup' ? TOPUP_COVERAGE_TARGET : FRESH_COVERAGE_TARGET);
        const coverage = computeCoverage(cached.context.units, plan.items, allSpecs, mergedOutcome);
        coverageSummary = {
          ratio: coverage.ratio,
          target: coverageTarget,
          coveredCount: coverage.coveredUnitKeys.size,
          totalCount: cached.context.units.length,
          uncovered: coverage.uncovered,
          loopEnabled: snapshot?.coverageLoopEnabled ?? false,
        };
      }
    }

    if (mergedOutcome.failed > 0) finalStatus = 'failed';
    else if (mergedOutcome.blocked > 0) finalStatus = 'blocked';
    else if (mergedOutcome.passed > 0) finalStatus = 'passed';
    else finalStatus = 'error';

    let artifactFiles: string[] = [];
    try {
      const collected = await mode.collectArtifacts(ctx);
      artifactFiles = collected.files;
    } catch (err) {
      emit('execute', 'warn', `Artifact collection failed (continuing): ${errMsg(err)}`);
    }

    let dependencies: ExternalDependency[] = [];
    try {
      const rawDeps = await readFile(join(runDir, 'plan', 'dependencies.json'), 'utf-8');
      const saved = JSON.parse(rawDeps) as Array<ExternalDependency & { mockResponse: MockResponse | null }>;
      dependencies = saved.map(({ mockResponse: _mockResponse, ...dep }) => dep);
    } catch {
      /* best-effort; no dependencies to report */
    }

    const testsAll = store.listTests(runId);
    const testByIdForTriage = new Map(testsAll.map((t) => [t.id, t]));
    const testIdByTitleForTriage = new Map(testsAll.map((t) => [t.title, t.id]));
    const resultByTestIdForTriage = new Map(store.listResults(runId).map((r) => [r.testId, r]));
    const alreadyTriagedIds = new Set(store.listTriageResults(runId).map((row) => row.testId));

    // Best-effort triage for whatever THIS retry-pass newly failed/blocked —
    // old verdicts are preserved below regardless, but without this step a
    // freshly-regenerated item that still fails would show up untriaged
    // until the next full run. Deliberately simpler than runPipeline's own
    // TRIAGE phase (no batching/AI-limit/confidence-ranked selection — see
    // that section's own comments) since retry-pass only ever deals with the
    // small subset of results it just touched, not a whole run's worth of
    // failures; each item still gets the same classify-then-AI-enrich
    // behavior via TriageEngine.analyze(), just called one at a time.
    const newlyFailed = mergedOutcome.results.filter(
      (r) =>
        (r.status === 'failed' || r.status === 'blocked') &&
        !alreadyTriagedIds.has(testIdByTitleForTriage.get(r.title) ?? ''),
    );
    if (newlyFailed.length > 0) {
      emit('triage', 'info', `Triaging ${newlyFailed.length} new failure(s)/blocked outcome(s).`);
      const engine = createTriageEngine();
      for (const r of newlyFailed) {
        const spec = allSpecs.find((s) => stableKey(undefined, s.title) === stableKey(undefined, r.title));
        const tracePath = (r.artifacts ?? []).find((a) => a.endsWith('.zip')) ?? r.artifacts?.[0];
        const input: TriageInput = {
          title: r.title,
          error: r.error ?? '',
          ...(spec?.reqTag ? { reqTag: spec.reqTag } : {}),
          ...(spec?.contents ? { specSource: spec.contents } : {}),
          ...(tracePath ? { tracePath } : {}),
        };
        const controller = new AbortController();
        let result: TriageResult;
        try {
          result = await withTimeoutAbort(
            engine.analyze(input, provider, controller.signal, recordUsage, project.repoPath ?? undefined),
            TRIAGE_ANALYZE_TIMEOUT_MS,
            controller,
          );
        } catch (err) {
          emit('triage', 'debug', `Triage failed for "${r.title}" (keeping no verdict): ${errMsg(err)}`);
          continue;
        }
        const testId = testIdByTitleForTriage.get(r.title);
        if (testId) {
          try {
            store.recordTriageResult({
              testId,
              verdict: result.verdict,
              confidence: result.confidence,
              rationale: result.rationale,
              suggestedPatch: result.suggestedPatch ?? null,
            });
            noteStoreOk();
          } catch (err) {
            noteStoreFailure('recordTriageResult', err);
          }
        }
      }
      emit('triage', 'info', `Triaged ${newlyFailed.length} new failure(s).`);
    }

    const triageEntries: ReportTriageEntry[] = store.listTriageResults(runId).map((row) => {
      const test = testByIdForTriage.get(row.testId);
      const result = resultByTestIdForTriage.get(row.testId);
      return {
        title: test?.title ?? row.testId,
        error: result?.error ?? '',
        triage: {
          verdict: row.verdict,
          confidence: row.confidence,
          rationale: row.rationale,
          ...(row.suggestedPatch ? { suggestedPatch: row.suggestedPatch } : {}),
          verdictSource: row.verdictSource === 'ai_reviewed' ? 'ai_reviewed' : 'rule_fallback',
        },
      };
    });

    try {
      store.updateRunStatus(runId, finalStatus, { finishedAt: nowIso() });
      noteStoreOk();
    } catch (err) {
      noteStoreFailure('updateRunStatus', err);
    }

    const { reportPath } = await finalizeReport(
      store,
      runDir,
      run,
      project,
      finalStatus,
      plan,
      mergedOutcome,
      triageEntries,
      artifactFiles,
      dependencies,
      {},
      noteStoreOk,
      noteStoreFailure,
      { coverage: coverageSummary },
    );

    emit('done', 'info', `Retry-pass complete. Run ${finalStatus}.`, { runId, status: finalStatus });
    return { runId, status: finalStatus, reportPath, outcome: mergedOutcome };
  } catch (err) {
    emit('generate', 'error', `Retry-pass failed: ${errMsg(err)}`, { stack: errStack(err) });
    try {
      store.updateRunStatus(runId, 'error', { finishedAt: nowIso() });
    } catch {
      /* best-effort */
    }
    return { runId, status: 'error' };
  } finally {
    if (launched.stop) {
      try {
        await launched.stop();
      } catch (err) {
        emit('launch', 'warn', `[launch] (retry-pass) Failed to stop app: ${errMsg(err)}`);
      }
    }
  }
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

  // Proactive credit-budget ceiling (opts.maxCostUsd/opts.maxTokens): an
  // internal AbortController combined with the caller's own signal via
  // AbortSignal.any(), tripped once this run's running spend crosses either
  // configured ceiling. opts.signal is reassigned to the combined signal
  // (rather than threading a second signal parameter everywhere) so every
  // existing signal-checked boundary below — PLAN's batch loop, TRIAGE's AI
  // batch loop, GENERATE's dispatch queue, every phase-boundary
  // checkCancelled() — treats a budget breach exactly like a pause request,
  // stopping the run before its NEXT AI dispatch rather than letting cost
  // run unbounded. No separate plumbing needed anywhere else.
  const budgetController = new AbortController();
  // Only wrap opts.signal when a ceiling is actually configured — otherwise
  // opts.signal stays the EXACT reference the caller passed in, unchanged
  // from before this feature existed (no combined-signal indirection for
  // the common case where no ceiling is set).
  if (opts.maxCostUsd !== undefined || opts.maxTokens !== undefined) {
    opts = {
      ...opts,
      signal: AbortSignal.any(
        opts.signal ? [opts.signal, budgetController.signal] : [budgetController.signal],
      ),
    };
  }

  // Running totals for THIS run, seeded from any usage already recorded
  // before an earlier crash/pause — so a resume doesn't reset the ceiling
  // back to zero and let a run blow straight past it a second time — then
  // incremented as recordUsage persists each new row.
  let totalCostUsd = 0;
  let totalTokens = 0;
  if (resumeFrom) {
    try {
      for (const u of store.listUsageForRun(runId)) {
        totalCostUsd += u.costUsd ?? 0;
        totalTokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      }
    } catch {
      /* best-effort seeding; worst case the ceiling under-counts prior spend by one resume */
    }
  }

  /** Trips budgetController the first time a configured ceiling is crossed — a no-op every call after. */
  const checkBudget = (phase: OrchestratorPhase | string): void => {
    if (budgetController.signal.aborted) return;
    const overCost = opts.maxCostUsd !== undefined && totalCostUsd >= opts.maxCostUsd;
    const overTokens = opts.maxTokens !== undefined && totalTokens >= opts.maxTokens;
    if (!overCost && !overTokens) return;
    emit(
      phase,
      'warn',
      `Spend ceiling reached (cost $${totalCostUsd.toFixed(4)}` +
        `${opts.maxCostUsd !== undefined ? ` / limit $${opts.maxCostUsd}` : ''}, tokens ${totalTokens}` +
        `${opts.maxTokens !== undefined ? ` / limit ${opts.maxTokens}` : ''}); pausing run for review.`,
    );
    budgetController.abort('budget');
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
      totalCostUsd += usage?.costUsd ?? 0;
      totalTokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
      noteStoreOk();
    } catch (err) {
      noteStoreFailure('recordUsage', err);
    }
    checkBudget(phase);
  };

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
  // without a second signal to plumb through ctx/provider calls. A budget
  // breach (budgetController.abort('budget')) is recognized the same way.
  const isPauseRequested = (): boolean =>
    checkCancelled() && (signal?.reason === 'pause' || signal?.reason === 'budget');

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
    coverageLoopEnabled: opts.coverageLoopEnabled,
    coverageTarget: opts.coverageTarget,
    retryItemIds: opts.retryItemIds,
    maxCostUsd: opts.maxCostUsd,
    maxTokens: opts.maxTokens,
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
  // End-of-run AI synthesis across every triaged failure (see triage/grouping.ts);
  // stays null when there were fewer than 2 failures to compare, or the summary
  // call failed/was skipped — best-effort, never blocks report-writing.
  let groupingSummary: string | null = null;
  // F-23: WHY groupingSummary is null, so the report can say so explicitly
  // instead of silently omitting the paragraph. Stays null when a summary
  // WAS produced (nothing to explain) or when this step never even ran
  // (fewer than 2 triaged failures — see below, that path leaves BOTH
  // groupingSummary and this null, matching pre-F-23 behavior exactly).
  let groupingSummaryUnavailableReason: GroupingSummaryUnavailableReason | null = null;
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
  const buildCheckpoint = (executeComplete: boolean): ResumeCheckpoint => {
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
        coverageLoopEnabled: opts.coverageLoopEnabled,
        coverageTarget: opts.coverageTarget,
        retryItemIds: opts.retryItemIds,
        maxCostUsd: opts.maxCostUsd,
        maxTokens: opts.maxTokens,
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
      executeComplete,
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
    executeComplete = false,
  ): Promise<RunSummary> => {
    await writeCheckpoint(runDir, buildCheckpoint(executeComplete));
    emit(phase, 'warn', `Run paused (${reason}); checkpoint saved for resume.`, { reason });
    setStatus('paused', { finishedAt: nowIso(), pauseReason: reason });
    return { runId, status: 'paused' };
  };

  /** At a cancellation boundary: honor a live pause/budget request as 'paused' (resumable); otherwise cancel as today. */
  const pauseOrCancel = (
    phase: OrchestratorPhase | string,
    executeComplete = false,
    cancelMessage?: string,
  ): Promise<RunSummary> =>
    isPauseRequested()
      ? pauseRun(phase, signal?.reason === 'budget' ? 'budget-exceeded' : 'manual', executeComplete)
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

    // A checkpoint whose phase is still 'plan' means PLAN itself was
    // interrupted mid-batch-loop (see runPlanPhase's resumeState/
    // onBatchProgress) — there is no finalized/approved plan to skip ahead
    // to yet, so this takes the SAME path a fresh run does (repo indexing,
    // dependency detection, etc. all still need to happen), just seeded with
    // whichever batches already succeeded rather than starting from zero.
    const resumingPastPlan = resumeFrom !== undefined && resumeFrom.checkpoint.phase !== 'plan';
    if (resumingPastPlan) {
      // Resuming: the plan was already finalized and approved before the
      // pause/interruption — replanning or re-showing the approval gate would
      // waste tokens and re-litigate an already-made decision. Only the
      // provider needs re-resolving (cheap: a health probe, no tokens spent).
      emit('plan', 'info', `Resuming run (paused at "${resumeFrom!.checkpoint.phase}").`);
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
      // sourceContext (white-box grounding for TRIAGE/GENERATE) is otherwise never recomputed on
      // resume — formatSourceGrounding would silently return '' for every item without this.
      // Best-effort, no hash check: even a slightly stale cached context is strictly better than
      // none, and PLAN (where a fresher one would be computed) is being skipped entirely here.
      if (project.repoPath) {
        const cached = loadSourceContext(project.repoPath);
        if (cached) {
          sourceContext = cached.context;
          emit(
            'plan',
            'debug',
            `Resumed cached source context: ${sourceContext.units.length} functionality unit(s).`,
          );
        }
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
            // Skip indexSource()'s full-repo AST walk when the repo's file list/size/mtime
            // fingerprint hasn't changed since the last time it was persisted — a full walk is
            // one of the more expensive PLAN-phase steps on a large repo, and re-running it
            // every single run when nothing changed on disk is pure waste.
            const currentHash = computeRepoSourceHash(project.repoPath);
            const cached = loadSourceContext(project.repoPath);
            if (cached && cached.hash === currentHash) {
              sourceContext = cached.context;
              emit(
                'plan',
                'debug',
                `Reused cached source context (unchanged repo fingerprint): ${sourceContext.units.length} functionality unit(s).`,
              );
            } else {
              sourceContext = await indexSource(project.repoPath);
              persistSourceContext(project.repoPath, currentHash, sourceContext);
            }
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

        // Retry-pass/Repair (results-page actions): reuse ONLY the requested
        // item ids from the base run's own plan instead of a full AI re-plan.
        // Generation's existing base-run diff (topup.ts's diffAgainstBase)
        // then regenerates just those items and carries everything else
        // forward untouched.
        let retryPassPlan: TestPlan | null = null;
        if (opts.retryItemIds && opts.retryItemIds.length > 0 && suiteMode === 'topup' && baseRun) {
          try {
            const baseRunDir = join(projectsDir(), project.id, 'runs', baseRun.id);
            const raw = await readFile(join(baseRunDir, 'plan', 'plan.json'), 'utf-8');
            const basePlan = JSON.parse(raw) as TestPlan;
            const ids = new Set(opts.retryItemIds);
            const matched = basePlan.items.filter((it) => ids.has(it.id));
            if (matched.length > 0) {
              retryPassPlan = {
                summary: `Retry-pass: regenerating ${matched.length} item(s) from run ${baseRun.id}.`,
                items: matched,
                planSource: 'ai',
              };
              emit(
                'plan',
                'info',
                `Retry-pass: reusing ${matched.length} plan item(s) from run ${baseRun.id}; skipping AI planning.`,
              );
            } else {
              emit(
                'plan',
                'warn',
                "Retry-pass requested but none of the given item ids matched the base run's plan; falling back to a full re-plan.",
              );
            }
          } catch (err) {
            emit(
              'plan',
              'warn',
              `Could not reload base plan for retry-pass (falling back to full re-plan): ${errMsg(err)}`,
            );
          }
        }
        // A plan-phase resume seeds runPlanPhase with whichever batches
        // already succeeded (or permanently failed) before the interruption;
        // a fresh run just starts from an empty position. Either way,
        // progress is checkpointed again as each further batch resolves, so
        // a SECOND interruption doesn't lose ground either.
        const planResumeState =
          resumeFrom && resumeFrom.checkpoint.phase === 'plan'
            ? {
                completedBatchIndices: new Set(
                  resumeFrom.checkpoint.planProgress?.completedBatchIndices ?? [],
                ),
                items: resumeFrom.checkpoint.plan.items,
                failedBatches: resumeFrom.checkpoint.planProgress?.failedBatches ?? [],
              }
            : undefined;
        const onPlanBatchProgress = async (progress: PlanBatchProgress): Promise<void> => {
          await writeCheckpoint(runDir, {
            runId,
            projectId: project.id,
            phase: 'plan',
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
              coverageLoopEnabled: opts.coverageLoopEnabled,
              coverageTarget: opts.coverageTarget,
              retryItemIds: opts.retryItemIds,
              maxCostUsd: opts.maxCostUsd,
              maxTokens: opts.maxTokens,
            },
            plan: {
              summary: `Planning in progress: ${progress.items.length} item(s) so far.`,
              items: progress.items,
              planSource: 'ai',
            },
            planProgress: {
              completedBatchIndices: progress.completedBatchIndices,
              failedBatches: progress.failedBatches,
            },
            generatedItemIds: [],
            generatedSpecs: [],
            executeComplete: false,
            updatedAt: nowIso(),
          });
        };
        plan =
          retryPassPlan ??
          (await runPlanPhase(
            provider,
            project,
            opts,
            emit,
            overrides,
            repoIndex,
            recordUsage,
            planResumeState,
            onPlanBatchProgress,
          ));
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
            return await pauseOrCancel('approve', false, 'Run cancelled while awaiting approval.');
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

    // ---- 4b. KB SEED (Retry-pass / coverage-feedback-loop Knowledge Base) ----
    // Seed durable per-item/per-scenario tracking rows now that the approved
    // plan is finalized, on whichever branch above got here (fresh plan or
    // resumed-past-plan). Idempotent (INSERT OR IGNORE — see
    // seedPlanKbItem), so re-running this on a resumed run is harmless.
    // Skipped for suiteMode 'reuse': that mode carries no new plan to track
    // (planForGeneration is empty there — see suiteMode === 'reuse' above).
    if (suiteMode !== 'reuse') {
      try {
        for (const item of planForGeneration.items) {
          store.seedPlanKbItem({
            runId,
            planItemId: item.id,
            title: item.title,
            reqTag: item.reqTag ?? null,
            tier: item.tier,
            scenarios: item.scenarios.map((s, i) => ({ index: i, kind: s.kind, description: s.description })),
          });
        }
        noteStoreOk();
      } catch (err) {
        noteStoreFailure('seedPlanKbItem', err);
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
          mergeMockedRequestCounts(
            computeMockedRequestCounts(mockServerHandle),
            outcome?.mockedRequestCounts,
          ),
          noteStoreOk,
          noteStoreFailure,
        );
        return { runId, status: 'error', reportPath: summary.reportPath };
      }
    }

    // Directed post-approve deep-dive: indexSource()'s own PLAN-phase walk is shallow (path +
    // method only, no status codes, no handler-body tracing) and covers the WHOLE repo — this
    // narrower pass, scoped only to the files backing the now-approved plan's unitKey-resolved
    // units, extracts those deeper signals for exactly what this run is about to generate/triage
    // against, rather than paying that cost repo-wide. Best-effort: a failure here just means
    // GENERATE/TRIAGE proceed without the extra signal, same as any other optional grounding step.
    if (project.repoPath && sourceContext && planForGeneration.items.length > 0) {
      try {
        sourceContext = await enrichSourceContextForPlan(
          project.repoPath,
          sourceContext,
          planForGeneration.items,
        );
      } catch (err) {
        emit(
          'plan',
          'debug',
          `Deep-dive handler-signal enrichment failed (continuing without it): ${errMsg(err)}`,
        );
      }
    }

    // F-17 (Set 2 — fixtures/mock/auth execution): a project's baseUrl can
    // itself already be a working url-token deep link (`?token=...&mobile=...`,
    // including the hash-routed equivalent) even though no credential was
    // ever configured. authSetupContents()'s loginUrlToken() fully supports
    // this scheme, but with an empty project.credentials it never gets a
    // chance to run — auth setup takes the form-only hard-failure branch
    // instead and blocks every Tier B test. Auto-derive a usable url-token
    // credential straight from the URL's own token/params when that's the
    // only thing missing, so this is a provisioning gap fixed automatically
    // rather than a capability gap the user has to work around by hand.
    const effectiveCredentials: ProjectCredential[] =
      project.credentials.length === 0
        ? (() => {
            const derived = deriveUrlTokenCredentialFromBaseUrl(effectiveBaseUrl);
            if (derived) {
              emit(
                'plan',
                'info',
                'No credentials configured, but the base URL looks like a url-token deep link — ' +
                  'auto-derived a url-token credential from it for Tier B auth.',
              );
              return [derived];
            }
            return project.credentials;
          })()
        : project.credentials;

    ctx = {
      projectDir: join(runDir, 'suite'),
      repoPath: project.repoPath,
      baseUrl: effectiveBaseUrl,
      credentials: effectiveCredentials,
      provider,
      target,
      browser,
      explorationMode: opts.explorationMode ?? deriveExplorationMode(project),
      // 'reuse'/'topup' carry the ENTIRE base run's suite forward regardless
      // of tier (see baseTestsWithSpec above and diffAgainstBase's carried
      // set) — execute()'s playwrightProjectArgs restricts which Playwright
      // --project tiers actually run based on THIS field, entirely
      // independent of which specs got carried. A caller-supplied
      // testingScope narrower than the carried suite's own tiers (e.g. the
      // desktop compose form's scope selector, which defaults to 'frontend'
      // and isn't synced to whatever scope the base run was originally
      // planned with) would silently execute zero of a backend-only carried
      // suite — the exact "Run verified nothing: no runnable specs were
      // produced" failure. Force 'both' for these two modes so every carried
      // tier actually runs; opts.testingScope only meaningfully scopes a
      // 'fresh' run's own planning/generation.
      testingScope: suiteMode === 'reuse' || suiteMode === 'topup' ? 'both' : (opts.testingScope ?? 'both'),
      sourceContext,
      emit: ctxEmit,
      onUsage: recordUsage,
      onKbItemOutcome: (planItemId, status) => {
        try {
          store.updatePlanKbItemStatus(runId, planItemId, status);
          noteStoreOk();
        } catch (err) {
          noteStoreFailure('updatePlanKbItemStatus', err);
        }
      },
      // Long mode phases (generate/execute) receive the run's abort signal so
      // in-flight provider/suite work is killed on cancellation, not just
      // skipped at the next phase boundary.
      signal,
      // See F-18: lets scaffold() skip registering the auth-setup Playwright
      // project entirely when the plan has no auth surface, instead of
      // running it unconditionally and misreporting its "no credentials
      // configured" throw as an ordinary test failure. suiteMode 'reuse'
      // carries no new plan at all (planForGeneration is empty there) — this
      // deliberately stays undefined (today's always-scaffold behavior) in
      // that case, since scaffold() is a no-op re-run over an already-working
      // carried-forward suite, not a fresh decision about auth surface.
      ...(suiteMode !== 'reuse'
        ? {
            hasTierBAuthPlanItems: planForGeneration.items.some(
              (item) => item.tier === 'tierB-auth' && isPlanItemIncluded(item),
            ),
          }
        : {}),
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
        // Directed exploration: the approved plan's unitKeys are already known here, so route/
        // endpoint units the plan actually needs are prioritized ahead of everything else BEFORE
        // any truncation, instead of exploring in arbitrary first-N discovery order.
        const priorityUnitKeys = new Set(
          planForGeneration.items.map((it) => it.unitKey).filter((k): k is string => Boolean(k)),
        );
        const { routePaths: staticRoutePaths, endpointPaths } = splitStaticUnitsForExplore(
          sourceContext?.units ?? [],
          priorityUnitKeys,
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
          // Exploration caching: rebuilding the whole crawl from scratch on every single run is
          // pure waste when the target app hasn't changed since the last one. Keyed by baseUrl
          // with an explicit staleness window (unlike the source-context cache, a live app drifts
          // independently of anything Healix can fingerprint, so this is never trusted
          // indefinitely) — see exploration-cache.ts. "Force a fresh crawl" is simply deleting
          // the cache file; no dedicated option is needed here.
          const cachedExploration = loadExplorationCache(project.id, effectiveBaseUrl);
          // A cache hit is only trusted when the crawl it came from was actually good — a
          // budget-exhausted or thin/collapsed crawl (assessExplorationUsefulness's `useful:
          // false`) gets replayed to every run for the whole staleness window otherwise, and
          // crucially skips this run's static-route-seeding follow-up entirely (that only runs
          // inside runExplorePhase, below), even though the approved plan's unitKeys — and
          // whatever seeding paths they resolve to — differ run to run.
          const cachedExplorationIsTrustworthy =
            cachedExploration !== null &&
            cachedExploration.useful &&
            !cachedExploration.crawl.budgetExhausted;
          let exploration: ExplorationArtifact;
          // Captured only on a fresh (non-cache-hit) crawl, in memory only — see
          // ExploreInput.onBeforeStop's doc comment for why this never touches the persisted
          // exploration cache. Lets the gap-fill pass below (which necessarily starts a NEW
          // browser, since this phase's own `finally` already tore the session down) resume
          // whatever authenticated session crawlWithAuth established, instead of running
          // anonymous-only.
          let explorationSessionStorageState: unknown;
          if (cachedExploration && cachedExplorationIsTrustworthy) {
            exploration = cachedExploration;
            emit(
              'explore',
              'info',
              'Reusing cached exploration artifact (within staleness window) — skipping live crawl.',
            );
          } else {
            if (cachedExploration && !cachedExplorationIsTrustworthy) {
              emit(
                'explore',
                'debug',
                'Cached exploration artifact was thin/budget-exhausted — re-crawling instead of reusing it.',
                {
                  uselessReason: cachedExploration.uselessReason,
                  budgetExhausted: cachedExploration.crawl.budgetExhausted,
                },
              );
            }
            // EXPLORE only needs ONE representative session to find/confirm a login
            // form — not every role. Prefer a roleless credential (the "default"
            // session Tier B also falls back to) over a role-tagged one.
            const defaultCredential = ctx.credentials?.find((c) => c.role === null) ?? ctx.credentials?.[0];
            // No structured project-config field for supported regions/locales exists yet (see
            // the enrichment plan's "region-code sourcing is a design TBD"). Union two sources:
            // sourceContext.regionCodes (static analysis of the target's own i18n/regions config,
            // see target/region-index.ts — catches real sibling regions a PRD never mentions by
            // name) and the plan-text heuristic below (catches the opposite case: a real
            // project-config field or recognizable i18n file doesn't exist, but the plan text
            // itself names a region). Neither alone was sufficient — confirmed live that a PRD
            // scoped to one region ("SK") never surfaces its app's other real regions via text
            // alone (docs/c-and-a-exploration-gap-analysis.md §6.3).
            const knownRegionCodes = [
              ...new Set([
                ...(sourceContext?.regionCodes ?? []),
                ...deriveRegionCodesFromText(
                  planForGeneration.items.flatMap((it) => [it.title, it.intent, it.reqTag ?? '']),
                ),
              ]),
            ];
            exploration = await runExplorePhase({
              browser,
              baseUrl: effectiveBaseUrl,
              credentials: defaultCredential
                ? { username: defaultCredential.username, password: defaultCredential.password }
                : undefined,
              crawlOptions: opts.crawlBudget,
              staticRoutePaths,
              knownRegionCodes,
              browserFactory: makeBrowser,
              onBeforeStop: async (b) => {
                explorationSessionStorageState = await b.exportStorageState().catch(() => undefined);
              },
              emit,
              onFrame: hooks?.onFrame,
            });
            persistExplorationCache(project.id, effectiveBaseUrl, exploration);
          }
          ctx.exploration = exploration;

          // Gap-fill runs HERE, unconditionally — not inside runExplorePhase — because a cache
          // hit skips the crawl entirely (see the trust-gate comment above), but the approved
          // plan's required routes differ run to run regardless of whether the crawl itself is
          // fresh or reused. Gap-fill is inherently plan-shaped, not crawl-shaped, so it must
          // re-run against the CURRENT plan even on a cache hit.
          try {
            let explorationArtifact = ctx.exploration;
            const gaps = identifyExplorationGaps({
              crawlResult: explorationArtifact.crawl,
              routing: explorationArtifact.routing,
              baseUrl: effectiveBaseUrl,
              planItems: planForGeneration.items.map((it) => ({
                id: it.id,
                title: it.title,
                unitKey: it.unitKey,
                intent: it.intent,
                reqTag: it.reqTag,
                scenarios: it.scenarios,
                tier: it.tier,
              })),
              observedEndpoints: explorationArtifact.observedEndpoints,
            });
            if (gaps.length > 0) {
              emit(
                'explore',
                'info',
                `Gap-fill: attempting to close ${gaps.length} identified exploration gap(s).`,
              );
              await browser.start({
                headless: true,
                baseUrl: effectiveBaseUrl,
                storageState: explorationSessionStorageState,
              });
              try {
                const gapFill = await runGapFillingPass({
                  browser,
                  baseUrl: effectiveBaseUrl,
                  gaps,
                  emit,
                  gapFillProvider: provider ? { provider, onUsage: recordUsage } : undefined,
                });
                if (gapFill.newRoutes.length > 0) {
                  const mergedCrawl = {
                    ...mergeCrawlResults(explorationArtifact.crawl, {
                      routes: gapFill.newRoutes,
                      visitedCount: gapFill.newRoutes.length,
                      budgetExhausted: false,
                      unvisitedQueuedCount: 0,
                      redirectLoopsDetected: [],
                      shellCollapsed: false,
                      degenerateRedirectsSkipped: [],
                    }),
                    authAttempted: explorationArtifact.crawl.authAttempted,
                    authVerified: explorationArtifact.crawl.authVerified,
                    authReason: explorationArtifact.crawl.authReason,
                    verifiedLogin: explorationArtifact.crawl.verifiedLogin,
                  };
                  const quality = assessExplorationUsefulness(mergedCrawl);
                  explorationArtifact = {
                    ...explorationArtifact,
                    crawl: mergedCrawl,
                    useful: quality.useful,
                    uselessReason: quality.reason,
                    thinRouteRatio: quality.thinRouteRatio,
                  };
                }
                explorationArtifact = { ...explorationArtifact, gapFillAttempts: gapFill.attempts };
                ctx.exploration = explorationArtifact;
                const closedCount = gapFill.attempts.filter((a) => a.outcome === 'closed').length;
                emit(
                  'explore',
                  'info',
                  `Gap-fill: closed ${closedCount}/${gaps.length} gap(s), capturing ${gapFill.newRoutes.length} new route(s).`,
                );
                persistExplorationCache(project.id, effectiveBaseUrl, explorationArtifact);
              } finally {
                await browser.stop().catch(() => undefined);
              }
            }
          } catch (err) {
            emit('explore', 'debug', `Gap-fill pass failed (continuing): ${errMsg(err)}`);
          }

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
          mergeMockedRequestCounts(
            computeMockedRequestCounts(mockServerHandle),
            outcome?.mockedRequestCounts,
          ),
          noteStoreOk,
          noteStoreFailure,
          { generationStats, coverage: coverageSummary, groupingSummary, groupingSummaryUnavailableReason },
        );
        return { runId, status: 'error', reportPath: summary.reportPath, outcome: outcome ?? undefined };
      }
    } else {
      // Write a checkpoint marking phase='generate' BEFORE the (possibly
      // long-running, AI-driven) generate() call itself — without this, an
      // uncooperative crash mid-GENERATE (no exception, no catch block runs)
      // would leave no checkpoint.json on disk at all for resume to find,
      // regardless of how much per-item progress generate.ts's own
      // write-through checkpoint (see modes/playwright/generate.ts) preserved
      // on the filesystem. `specs` is still empty here, so buildCheckpoint's
      // phase resolves to 'generate' exactly as intended.
      await writeCheckpoint(runDir, buildCheckpoint(false));
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
          // Retry-pass/Repair (results-page actions): a retryItemIds-targeted item
          // must be regenerated even when it already has a covering test — that's
          // the whole precondition for Repair (a test_is_wrong verdict can only
          // exist on an already-executed test) — so force it into toGenerate
          // rather than letting diffAgainstBase's ordinary "existing test = already
          // covered" rule silently carry the old (possibly wrong) spec forward.
          const forceRegenerate =
            opts.retryItemIds && opts.retryItemIds.length > 0 ? new Set(opts.retryItemIds) : undefined;
          const diff = diffAgainstBase(planForGeneration.items, baseTestsWithSpec, forceRegenerate);
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

        // A live pause/budget-ceiling abort can stop mode.generate() from
        // dispatching further batches WITHOUT throwing (see generate.ts's
        // runWithConcurrency shouldStop) — unlike an abort that kills an
        // in-flight call (caught below), this returns normally with a
        // PARTIAL newSpecs list. Catch it here, before `specs` (outer) is
        // ever assigned: buildCheckpoint's phase resolves to 'execute' the
        // moment specs.length > 0, and resume treats phase:'execute' as
        // "GENERATE fully done, never call mode.generate() again" — locking
        // in a partial specs list forever would silently ship an incomplete
        // suite. Pausing here instead leaves `specs` empty, so the
        // checkpoint stays phase:'generate' and resume re-invokes
        // mode.generate(), which skips already-done items via its own
        // write-through checkpoint and finishes the remainder. A plain
        // cancel (not a pause/budget request) still cancels, same as every
        // other checkCancelled() boundary — pauseOrCancel already makes
        // that distinction.
        if (checkCancelled()) {
          return await pauseOrCancel('generate', false);
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
          // A spec that passed generate.ts's own per-item checks already recorded
          // the item as 'generated' via ctx.onKbItemOutcome (see generate.ts's
          // recordGenOutcome) — but THIS later, stricter validation pass (a real
          // parse check the regex/string gates can't do) can still reject it.
          // Without correcting the KB here, it's stuck believing the item is
          // 'generated'/'pending' forever: retry-pass won't regenerate it (not
          // marked 'dropped') and can't execute it either (registerSpecRows is
          // never called for a quarantined spec below, so its scenarios' test_id
          // never gets linked) — a permanent, silent dead end. Flip it back to
          // 'dropped' so a later retry-pass can actually recover it. A
          // carried-forward spec has no planItemId (nothing to correct — it
          // isn't new generation for this run's own KB tracking, same as
          // registerSpecRows' own carried-forward handling).
          for (const q of validation.quarantined) {
            if (q.spec.planItemId) ctx.onKbItemOutcome?.(q.spec.planItemId, 'dropped');
          }
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
          registerSpecRows(store, runId, ctx.projectDir, spec, newSpecItems, testIdByKey, noteStoreFailure);
        for (const spec of carriedSpecs)
          registerSpecRows(store, runId, ctx.projectDir, spec, [], testIdByKey, noteStoreFailure);
        emit('generate', 'info', `Generated ${specs.length} spec(s).`);
        // Checkpoint immediately: if the process dies between here and EXECUTE
        // finishing, resume skips straight to EXECUTE with zero regeneration.
        await writeCheckpoint(runDir, buildCheckpoint(false));
      } catch (err) {
        // A pause request aborts ctx.signal, which is exactly what kills an
        // in-flight provider call — so a live pause surfaces here as some
        // generic "aborted"-flavored error, not a recognizable network/credits
        // signature. Check isPauseRequested() FIRST: it's the direct cause,
        // regardless of what the resulting error message happens to say.
        if (isPauseRequested()) {
          return await pauseRun(
            'generate',
            signal?.reason === 'budget' ? 'budget-exceeded' : 'manual',
            false,
          );
        }
        // Otherwise, a systemic provider outage (see ProviderUnavailableError/
        // generate.ts) is worth pausing+resuming rather than hard-failing —
        // anything else (a genuine bug/bad config) keeps failing as before.
        const classified = classifyTransientFailure(errMsg(err));
        if (classified) {
          return await pauseRun('generate', classified, false);
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
          mergeMockedRequestCounts(
            computeMockedRequestCounts(mockServerHandle),
            outcome?.mockedRequestCounts,
          ),
          noteStoreOk,
          noteStoreFailure,
          { generationStats, coverage: coverageSummary, groupingSummary, groupingSummaryUnavailableReason },
        );
        return { runId, status: 'error', reportPath: summary.reportPath, outcome: outcome ?? undefined };
      }
    }

    // ---- 8. EXECUTE ----
    // All in-scope tiers run in a SINGLE Playwright invocation instead of one
    // process per tier — Playwright's own scheduler runs independent tiers
    // concurrently and sequences tierB-auth after auth-setup via each
    // project's own `dependencies` (see playwrightConfigContents in
    // templates.ts), so there's no correctness reason to force them apart at
    // the orchestrator level. Resume no longer needs tier-level bookkeeping
    // here either: mode.execute() carries its own write-through, test-level
    // checkpoint (see modes/playwright/execute.ts and templates.ts's
    // checkpointReporterContents()) and transparently skips whatever already
    // finished in an earlier, interrupted attempt — this only needs to know
    // whether the WHOLE execute step is done yet.
    if (checkCancelled()) return await pauseOrCancel('execute');
    setStatus('executing');
    if (!outcome) outcome = { passed: 0, failed: 0, blocked: 0, flaky: 0, skipped: 0, results: [] };
    let executeComplete =
      resumeFrom?.checkpoint.phase === 'execute' ? resumeFrom.checkpoint.executeComplete : false;
    if (executeComplete) {
      emit('execute', 'info', 'Execute phase already complete (resumed); skipping re-execution.');
    } else {
      emit('execute', 'info', `Executing ${specs.length} spec(s).`);
      try {
        const freshOutcome = await mode.execute(ctx, specs);
        // A live pause/cancel aborts ctx.signal, which is what makes an
        // in-flight Playwright invocation return early — as a normal
        // (non-throwing) zeroed/aborted outcome, not an exception (see
        // modes/playwright/execute.ts's abortedOutcome()). checkCancelled()
        // reads the orchestrator's OWN signal directly, independent of
        // whatever the mode happened to return, so this catches that case
        // correctly instead of misreading an aborted call as a genuinely
        // completed (zero passed, zero failed) execute phase.
        if (checkCancelled()) return await pauseOrCancel('execute', executeComplete);
        outcome = freshOutcome;
        persistResults(store, runId, specs, outcome, testIdByKey, noteStoreOk, noteStoreFailure);
        executeComplete = true;
        await writeCheckpoint(runDir, buildCheckpoint(executeComplete));
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
          return await pauseRun(
            'execute',
            signal?.reason === 'budget' ? 'budget-exceeded' : 'manual',
            executeComplete,
          );
        }
        const classified = classifyTransientFailure(errMsg(err));
        if (classified) {
          return await pauseRun('execute', classified, executeComplete);
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
          mergeMockedRequestCounts(
            computeMockedRequestCounts(mockServerHandle),
            outcome?.mockedRequestCounts,
          ),
          noteStoreOk,
          noteStoreFailure,
          { generationStats, coverage: coverageSummary, groupingSummary, groupingSummaryUnavailableReason },
        );
        return { runId, status: 'error', reportPath: summary.reportPath, outcome: outcome ?? undefined };
      }
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
    // stopping after a single plan/generate/execute pass. Each iteration
    // regenerates whatever the Knowledge Base flags as 'dropped' and
    // executes everything still 'pending' — the SAME primitive Retry-pass
    // uses on demand (regenerateDroppedAndExecutePending) — rather than
    // re-planning via the AI: this loop can only recover items the initial
    // plan already included but generation/execution failed to finish, it
    // can no longer discover coverage gaps the plan never mentioned in the
    // first place. See docs/design/retry-pass-coverage-kb-redesign.md §4 for
    // why this is a deliberate behavior narrowing, not just a refactor.
    if (checkCancelled()) return await pauseOrCancel('generate', executeComplete);
    if (suiteMode === 'reuse' || !repoIndex?.functionality || repoIndex.functionality.length === 0) {
      emit('generate', 'debug', 'Skipping coverage loop (reuse mode or no functionality inventory).');
    } else {
      const coverageTarget =
        opts.coverageTarget ?? (suiteMode === 'topup' ? TOPUP_COVERAGE_TARGET : FRESH_COVERAGE_TARGET);
      const coverageLoopEnabled = opts.coverageLoopEnabled ?? false;
      const units = repoIndex.functionality;
      const coveredPlanItems = planForGeneration.items;
      let iteration = 1;
      // Measured unconditionally — the report always needs a real coverage
      // number regardless of whether the loop below is allowed to retry.
      let coverage = computeCoverage(units, coveredPlanItems, specs, outcome);
      emit(
        'generate',
        'info',
        `Coverage: ${Math.round(coverage.ratio * 100)}% (${coverage.coveredUnitKeys.size}/${units.length} unit(s)).` +
          (coverageLoopEnabled ? '' : ' Coverage loop is off (coverageLoopEnabled not set) — not retrying.'),
      );

      const hasOutstandingKbWork = (): boolean =>
        store.listDroppedPlanKbItems(runId).length > 0 || store.listPendingPlanKbScenarios(runId).length > 0;

      while (
        coverageLoopEnabled &&
        coverage.ratio < coverageTarget &&
        iteration < COVERAGE_MAX_ITERATIONS &&
        !checkCancelled() &&
        hasOutstandingKbWork()
      ) {
        iteration += 1;
        emit(
          'generate',
          'info',
          `Coverage ${Math.round(coverage.ratio * 100)}% below target ${Math.round(coverageTarget * 100)}%; ` +
            `recovering dropped/pending item(s), iteration ${iteration}/${COVERAGE_MAX_ITERATIONS}.`,
        );

        let regen: Awaited<ReturnType<typeof regenerateDroppedAndExecutePending>>;
        try {
          regen = await regenerateDroppedAndExecutePending({
            ctx,
            mode,
            runId,
            store,
            plan: planForGeneration,
            emit,
            testIdByKey,
            noteStoreOk,
            noteStoreFailure,
          });
        } catch (err) {
          emit('generate', 'warn', `Coverage-loop recovery pass failed (stopping): ${errMsg(err)}`);
          break;
        }
        if (regen.regeneratedCount === 0 && regen.executedPendingCount === 0) {
          emit('generate', 'info', 'Nothing left to recover; stopping coverage loop.');
          break;
        }
        specs = [...specs, ...regen.specs];
        outcome = mergeExecOutcomes(outcome, regen.outcome);
        // coveredPlanItems already includes every planned item (dropped items
        // were part of the initial plan, just never generated) — nothing new
        // to fold in beyond what regen just contributed to specs/outcome.

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

      // Only warn about stopping "short" when the loop was actually allowed to
      // retry — with it off, the info message above already explained why
      // coverage isn't being chased, and "stopped after 1 iteration(s)" would
      // misleadingly imply an attempt that never happened.
      if (coverageLoopEnabled && coverage.ratio < coverageTarget) {
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
        // F-25: report.ts's degradationNotes() needs this to distinguish "the
        // loop ran and stopped short" from "the loop was never enabled" —
        // target/ratio alone can't tell those apart, and previously the
        // report-facing banner always implied the former even when
        // coverageLoopEnabled was false and no iterative attempt ever ran.
        loopEnabled: coverageLoopEnabled,
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
    if (checkCancelled()) return await pauseOrCancel('triage', executeComplete);
    setStatus('triaging');
    try {
      // Stable non-null reference: `outcome` is a mutable `let`, so its
      // non-null narrowing here doesn't survive into the .map() closure below
      // (TS conservatively assumes a closure could run after a reassignment).
      // Captured once so the closure can read outcome.apiEvidence directly.
      const execOutcome = outcome;
      const failed = execOutcome.results.filter((r) => r.status === 'failed' || r.status === 'blocked');
      if (failed.length > 0) {
        const engine = createTriageEngine();

        // Built up front — used both to persist incrementally below (matched
        // by title, exact at this point in the pipeline since titles are
        // already finalized by EXECUTE) and to detect, on resume, which
        // failures a prior crashed TRIAGE pass already recorded a verdict
        // for (per-batch persistence, see recordTriageResult below).
        let testIdByTitle: Map<string, string> | null = null;
        try {
          testIdByTitle = new Map(store.listTests(runId).map((t) => [t.title, t.id]));
          noteStoreOk();
        } catch (err) {
          noteStoreFailure('recordTriageResult', err);
        }

        // Resume support: skip re-triaging (and re-spending AI budget on) a
        // failure whose test already has a persisted verdict — mirrors
        // Generate/Execute's item-level resume skip. recordTriageResult
        // upserts by testId, so this is purely an efficiency/AI-spend
        // optimization, not a correctness requirement — but without it a
        // resumed mid-TRIAGE crash would needlessly re-run classify()/AI
        // enrichment for every already-done failure.
        const alreadyTriaged = new Map<string, TriageResultRow>();
        if (testIdByTitle) {
          try {
            const rowsByTestId = new Map(store.listTriageResults(runId).map((row) => [row.testId, row]));
            for (const [title, testId] of testIdByTitle) {
              const row = rowsByTestId.get(testId);
              if (row) alreadyTriaged.set(title, row);
            }
            noteStoreOk();
          } catch (err) {
            noteStoreFailure('recordTriageResult', err);
          }
        }
        for (const r of failed) {
          const row = alreadyTriaged.get(r.title);
          if (!row) continue;
          triageEntries.push({
            title: r.title,
            error: r.error ?? '',
            triage: {
              verdict: row.verdict,
              confidence: row.confidence,
              rationale: row.rationale,
              ...(row.suggestedPatch ? { suggestedPatch: row.suggestedPatch } : {}),
              // Legacy rows persisted before the verdict_source column existed
              // have no way to know their real provenance — default to the
              // conservative label rather than falsely claiming AI review.
              verdictSource: row.verdictSource === 'ai_reviewed' ? 'ai_reviewed' : 'rule_fallback',
            },
          });
        }
        if (alreadyTriaged.size > 0) {
          emit(
            'triage',
            'info',
            `Resuming: ${alreadyTriaged.size} failure(s) already triaged; skipping them this run.`,
          );
        }
        const toTriage =
          alreadyTriaged.size > 0 ? failed.filter((r) => !alreadyTriaged.has(r.title)) : failed;

        if (toTriage.length > 0) {
          emit('triage', 'info', `Triaging ${toTriage.length} failure(s)/blocked outcome(s).`);

          // classify() is synchronous/deterministic — run it for every failure up
          // front as the baseline (and the fallback if AI enrichment below fails).
          const baseline = toTriage.map((r) => {
            // Recover the originating spec (by normalized title) to ground the triage
            // input with its requirement tag and source.
            const spec = specs.find((s) => stableKey(undefined, s.title) === stableKey(undefined, r.title));
            // Surface a captured trace/screenshot to the AI prompt (see
            // prompt.ts's "TRACE PATH" block) — this was collected by execute.ts
            // but never threaded through before, so triage only ever "knew" a
            // trace existed by chance, never which file.
            const tracePath = (r.artifacts ?? []).find((a) => a.endsWith('.zip')) ?? r.artifacts?.[0];
            // Same identity execute.ts's own dedup keyOf()/readApiEvidence() use
            // (`${specFile}#${title}`) — lets triage see the ACTUAL response this
            // test's own API call(s) received, not just the one field its failing
            // assertion happened to print.
            const apiEvidenceKey = r.specFile ? `${r.specFile}#${r.title}` : r.title;
            const apiEvidence = execOutcome.apiEvidence?.[apiEvidenceKey];
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
              ...(apiEvidence ? { apiEvidence } : {}),
              ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
            };
            let triage: ReportTriageEntry['triage'] | null = null;
            try {
              triage = engine.classify(input);
            } catch (err) {
              emit('triage', 'warn', `Triage classify failed for "${r.title}": ${errMsg(err)}`);
            }
            return { r, input, triage, unit };
          });

          // AI enrichment for EVERY failure with a rule baseline — no cap. Run in
          // TRIAGE_AI_BATCH_SIZE-sized batches (each call with its own bounded
          // AbortController) rather than one at a time OR all at once — each call spawns a
          // real CLI child process (providers/claude.ts's runCli), so an unbounded burst of
          // simultaneous spawns is its own resource risk on a large run.
          // Sorted ascending by baseline confidence so that if the run is cancelled or a
          // budget ceiling hits mid-triage (see checkCancelled() in the batch loop below),
          // whatever DID get reviewed was the failures that most needed it — not an
          // ordering that limits which failures are eligible at all.
          const aiCandidates = baseline
            .filter((b) => b.triage !== null)
            .sort((a, b) => (a.triage?.confidence ?? 1) - (b.triage?.confidence ?? 1));
          const aiCandidateSet = new Set(aiCandidates);

          /**
           * Best-effort FK-keyed persistence alongside report.json's title-joined
           * triageEntries built below. Never blocks report-writing: a bad testId
           * or store fault here is no worse than report.json simply being the
           * only surviving record, same as before.
           */
          const persistTriageResult = (b: (typeof baseline)[number]): void => {
            if (!b.triage || !testIdByTitle) return;
            const testId = testIdByTitle.get(b.r.title);
            if (!testId) return;
            try {
              store.recordTriageResult({
                testId,
                verdict: b.triage.verdict,
                confidence: b.triage.confidence,
                rationale: b.triage.rationale,
                suggestedPatch: b.triage.suggestedPatch ?? null,
                verdictSource: b.triage.verdictSource,
              });
              noteStoreOk();
            } catch (err) {
              noteStoreFailure('recordTriageResult', err);
            }
          };

          // Every failure NOT selected for AI enrichment already has its FINAL
          // verdict (classify() is synchronous and nothing below ever touches
          // it) — persist these right away rather than holding them until the
          // whole TRIAGE phase finishes just to batch up a single write pass.
          for (const b of baseline) {
            if (!aiCandidateSet.has(b)) persistTriageResult(b);
          }

          /**
           * Triage one group with a SINGLE batched provider call (see
           * TriageEngine.analyzeBatch). Only a genuinely TRUNCATED reply (cut off
           * mid-array — the same signature attemptPlanCompletion's batch-split
           * reacts to) triggers a halve-and-retry; a reply that simply came back
           * garbled/unusable (no array structure at all) is NOT retried, since a
           * smaller batch has no reason to fix that — it would only multiply
           * calls for no benefit. A partial result (some ids present, others
           * not) is likewise never retried: every missing id simply keeps its
           * already-computed rule-baseline verdict, since triage (unlike
           * Generate) always has one.
           */
          const enrichBatch = async (batchCandidates: typeof aiCandidates, depth: number): Promise<void> => {
            // Read each candidate's matched source-context unit lazily — only
            // AI-enriched candidates need it (classify()'s deterministic rules
            // never look at source), so most failures never pay this read.
            for (const b of batchCandidates) {
              if (b.unit && project.repoPath) {
                try {
                  const content = await readFile(join(project.repoPath, b.unit.file), 'utf-8');
                  b.input = { ...b.input, sourceFile: b.unit.file, sourceExcerpt: content };
                } catch (err) {
                  emit(
                    'triage',
                    'debug',
                    `Could not read matched source file "${b.unit.file}": ${errMsg(err)}`,
                  );
                }
              }
            }

            // Ids are positional and scoped to THIS call only — stable enough to
            // join the reply back to its candidate, never persisted or compared
            // across calls (each recursive split builds its own fresh set).
            const items: TriageBatchItem[] = batchCandidates.map((b, i) => ({
              id: String(i),
              input: b.input,
            }));
            const controller = new AbortController();
            let outcome: { results: Map<string, TriageResult>; truncated: boolean };
            try {
              outcome = await withTimeoutAbort(
                engine.analyzeBatch(
                  items,
                  provider,
                  controller.signal,
                  recordUsage,
                  project.repoPath ?? undefined,
                ),
                TRIAGE_ANALYZE_TIMEOUT_MS,
                controller,
              );
            } catch (err) {
              emit('triage', 'debug', `Batched AI triage failed: ${errMsg(err)}`);
              outcome = { results: new Map(), truncated: false };
            }

            if (outcome.truncated && batchCandidates.length > 1 && depth < TRIAGE_MAX_SPLIT_DEPTH) {
              const mid = Math.ceil(batchCandidates.length / 2);
              emit(
                'triage',
                'debug',
                `Batched triage of ${batchCandidates.length} failure(s) came back truncated; ` +
                  `splitting and retrying.`,
              );
              await enrichBatch(batchCandidates.slice(0, mid), depth + 1);
              await enrichBatch(batchCandidates.slice(mid), depth + 1);
              return;
            }

            batchCandidates.forEach((b, i) => {
              const enriched = outcome.results.get(String(i));
              if (enriched) b.triage = enriched;
              // else: keep the already-computed rule-baseline verdict (b.triage is already set).
            });
          };

          for (let i = 0; i < aiCandidates.length; i += TRIAGE_AI_BATCH_SIZE) {
            // Mirrors PLAN's own batch loop: a live pause/budget-ceiling abort
            // stops further AI batches from dispatching, rather than only
            // taking effect at the next phase boundary (before REPORT) — the
            // remaining candidates simply keep their rule-baseline verdict.
            if (checkCancelled()) break;
            const batch = aiCandidates.slice(i, i + TRIAGE_AI_BATCH_SIZE);
            await enrichBatch(batch, 0);
            // Persist this batch's candidates now, with whatever verdict
            // enrichBatch settled on (AI-enriched, or the rule baseline if
            // enrichment didn't pan out) — a crash before the NEXT batch starts
            // still leaves this one's rows durably recorded, instead of the
            // whole phase being all-or-nothing.
            for (const b of batch) persistTriageResult(b);
          }

          // Deterministic corroboration pass: two failures missing the exact
          // same element can otherwise land on different verdicts purely
          // because of which AI batch (or whether any) reviewed them — see
          // correlateBySignature's own doc comment. Runs once, after all AI
          // enrichment above has settled, so it sees every failure's FINAL
          // per-item verdict. Only entries whose verdict actually changed are
          // re-persisted; everything else keeps the row persistTriageResult
          // already wrote above.
          const correlated = correlateBySignature(
            baseline.map((b) => ({ error: b.r.error ?? '', triage: b.triage })),
          );
          baseline.forEach((b, i) => {
            const next = correlated[i]!.triage;
            if (next && next !== b.triage) {
              b.triage = next;
              persistTriageResult(b);
            }
          });

          for (const b of baseline) {
            if (b.triage) triageEntries.push({ title: b.r.title, error: b.r.error ?? '', triage: b.triage });
          }
        }
        emit('triage', 'info', `Triaged ${triageEntries.length} failure(s).`);
      } else {
        emit('triage', 'debug', 'No failures to triage.');
      }
    } catch (err) {
      emit('triage', 'warn', `Triage phase error (continuing): ${errMsg(err)}`, { stack: errStack(err) });
    }

    // ---- 9b. TRIAGE GROUPING SUMMARY (best-effort) ----
    // One extra cheap AI call over the triage entries just assembled above,
    // synthesizing cross-failure patterns a single failure's own triage never
    // sees (e.g. "3 of these 5 share the same broken endpoint"). Never blocks
    // report-writing — a failed/timed-out/skipped call just leaves the report
    // without this prose, exactly like a skipped AI-triage enrichment leaves a
    // failure on its rule baseline.
    if (!checkCancelled() && triageEntries.length >= 2) {
      const controller = new AbortController();
      try {
        const result = await withTimeoutAbort(
          summarizeTriageGroups(triageEntries, provider, {
            signal: controller.signal,
            onUsage: recordUsage,
            cwd: project.repoPath ?? undefined,
          }),
          TRIAGE_ANALYZE_TIMEOUT_MS,
          controller,
        );
        groupingSummary = result.summary;
        groupingSummaryUnavailableReason = result.reason;
        if (groupingSummary) emit('triage', 'info', 'Grouping summary generated.');
      } catch (err) {
        // withTimeoutAbort itself rejected — the timer won the race against
        // summarizeTriageGroups' own settling, so THIS is the one path that
        // is genuinely a timeout rather than something summarizeTriageGroups
        // already classified as 'provider-error' internally.
        groupingSummaryUnavailableReason = 'timeout';
        emit('triage', 'debug', `Grouping summary skipped: ${errMsg(err)}`);
      }
    }

    // ---- 10. REPORT ----
    if (checkCancelled()) return await pauseOrCancel('report', executeComplete);
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
        mergeMockedRequestCounts(computeMockedRequestCounts(mockServerHandle), outcome?.mockedRequestCounts),
        noteStoreOk,
        noteStoreFailure,
        { generationStats, coverage: coverageSummary, groupingSummary, groupingSummaryUnavailableReason },
      )
    ).reportPath;

    // ---- 11. EXPORT (best-effort) ----
    // Prefer the mode's own export() for the suite bundle; fall back to the
    // standalone exportSuite() if it throws. Either way, never abort the run.
    if (checkCancelled()) return await pauseOrCancel('export', executeComplete);
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
          mergeMockedRequestCounts(
            computeMockedRequestCounts(mockServerHandle),
            outcome?.mockedRequestCounts,
          ),
          noteStoreOk,
          noteStoreFailure,
          { generationStats, coverage: coverageSummary, groupingSummary, groupingSummaryUnavailableReason },
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

/** Snapshot of PLAN's batch-loop progress — see runPlanPhase's resumeState/onBatchProgress params. */
export interface PlanBatchProgress {
  completedBatchIndices: number[];
  items: TestPlanItem[];
  failedBatches: string[];
}

export async function runPlanPhase(
  provider: ProviderAdapter,
  project: Project,
  opts: RunOptions,
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void,
  overrides?: OrchestratorOverrides,
  repoIndex?: PlanRepoContext,
  recordUsage?: UsageRecorder,
  /** Resume a previously interrupted batch loop: skip these batch indices, and start from these already-accumulated items/failures instead of empty. */
  resumeState?: { completedBatchIndices: Set<number>; items: TestPlanItem[]; failedBatches: string[] },
  /** Fires after each top-level batch resolves (succeeded OR permanently failed) — lets the caller checkpoint progress so a crash mid-loop doesn't redo already-paid-for batches. */
  onBatchProgress?: (progress: PlanBatchProgress) => void | Promise<void>,
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

  const items: TestPlanItem[] = resumeState ? [...resumeState.items] : [];
  const failedBatches: string[] = resumeState ? [...resumeState.failedBatches] : [];
  const completedBatchIndices = new Set<number>(resumeState?.completedBatchIndices ?? []);
  if (resumeState && completedBatchIndices.size > 0) {
    emit(
      'plan',
      'info',
      `Resuming PLAN: ${completedBatchIndices.size}/${batches.length} batch(es) already completed; continuing with the remainder.`,
    );
  }

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
    if (completedBatchIndices.has(i)) continue;
    await planBatch(batches[i]!, i, `${i + 1}/${batches.length}`, 0);
    completedBatchIndices.add(i);
    if (onBatchProgress) {
      await onBatchProgress({
        completedBatchIndices: [...completedBatchIndices],
        items: [...items],
        failedBatches: [...failedBatches],
      });
    }
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
 * spec (found in `items` by planItemId, see below) gets ONE row per scenario the
 * plan requested — so Total/Passed/Failed/etc. reflect real test-case counts,
 * matching what the report already shows (outcome.results is scenario-level),
 * not spec-file counts. A carried-forward spec (no matching item — copied bytes
 * from a prior run, already at whatever granularity that run used) gets a
 * single row, as before.
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
  noteStoreFailure: (op: string, err: unknown) => void,
): void {
  // A carried-forward, reqTag-less spec has spec.reqTag === undefined (the DB
  // deliberately never persists the per-run synthetic tag — see persistedReqTag
  // below), but the spec file's own text still carries the original run's
  // `[REQ:<tag>]` markers on every one of its scenarios. Recovering that tag from
  // spec.contents (rather than treating this spec as tag-less) is what lets `base`
  // land on the same key persistResults will later re-derive from the executed
  // test's title via the same extractReqTag() — without it, registration keys by
  // title while matching keys by tag, and every carried scenario after the first
  // collides on persistResults' fallback path (see that function's comments).
  const reqTag = (spec.reqTag ?? extractReqTag(spec.contents) ?? '').trim();
  // planItemId (set by generate.ts at the moment it produced this spec) is the
  // PRIMARY lookup because reqTag is not guaranteed unique across items — a
  // plan may deliberately pair two items (e.g. a UI-tier flow and its
  // tierC-api contract test) under the same functional reqTag. Falling back to
  // reqTag-only matching in that case would let `.find` silently resolve to
  // whichever of the two items happens to come first in `items`, misattributing
  // the other's scenarios/title and — critically — calling
  // linkPlanKbScenarioTest against the wrong KB item, leaving the real one's
  // scenarios permanently unlinked (stuck 'pending' forever; see
  // docs/design/retry-pass-coverage-kb-redesign.md). A carried-forward spec has
  // no planItemId at all, so it falls through to the reqTag path unchanged.
  const item =
    (spec.planItemId ? items.find((it) => it.id === spec.planItemId) : undefined) ??
    (reqTag.length > 0 ? items.find((it) => (it.reqTag ?? it.id) === reqTag) : undefined);
  const specPath = relative(projectDir, spec.path);
  const base = stableKey(reqTag, spec.title);
  // A SECOND, additional key scoped to the resolved item's own id (never
  // shared across two DIFFERENT items, unlike reqTag/title — see the `item`
  // lookup comment above). Written ALONGSIDE `base`, not instead of it: any
  // caller whose corresponding persistResults-time spec doesn't carry
  // planItemId (a carried-forward spec, or an older/fake TestMode) still
  // finds its row via the original reqTag-based key, unchanged; only when
  // persistResults CAN resolve planItemId does it prefer this collision-free
  // key instead, which is what actually fixes two same-reqTag items from
  // silently overwriting each other's `${base}#i` slots.
  const itemBase = item ? `item:${item.id}` : null;
  // The PERSISTED reqTag is the plan item's true reqTag (or null when it
  // never had one) — NOT spec.reqTag, which generate.ts fills in with the
  // item's own id when a real reqTag is absent (`item.reqTag ?? item.id`),
  // purely so THIS run's own spec-to-item bookkeeping above (the `item`
  // lookup, and `base`'s positional key) has something stable to match on.
  // Persisting that id instead of null broke cross-run identity matching
  // (topup.ts's computeIdentityKey/diffAgainstBase) for any reqTag-less
  // project: every item's stored reqTag was a per-run-only id that could
  // never match a later run's own (still reqTag-less) plan items, so
  // Top-up/Retry-pass/Repair saw every item as "not yet covered" even when
  // it plainly was. computeIdentityKey's title fallback now strips this
  // function's own `[REQ:...]`/scenario-suffix decoration back off before
  // comparing, so a null-reqTag row still matches correctly by title.
  const persistedReqTag = item ? (item.reqTag ?? null) : (spec.reqTag ?? null);

  if (!item || item.scenarios.length === 0) {
    const test = store.insertTest({
      runId,
      title: spec.title,
      reqTag: persistedReqTag,
      tier: (spec.tier ?? null) as Tier | null,
      status: 'pending',
      specPath,
      description: null,
      details: item?.intent ?? null,
      specCode: spec.contents,
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
      reqTag: persistedReqTag,
      tier: (spec.tier ?? null) as Tier | null,
      status: 'pending',
      specPath,
      description: s.description,
      details: item.intent,
      specCode: spec.contents,
    });
    testIdByKey.set(`${base}#${i}`, test.id);
    if (itemBase) testIdByKey.set(`${itemBase}#${i}`, test.id);
    // Best-effort KB link — never blocks spec registration. A carried-forward
    // spec (items=[], item undefined) never reaches this branch, so it's
    // simply never linked, which is correct: it isn't new generation for
    // THIS run's own KB tracking.
    try {
      store.linkPlanKbScenarioTest(runId, item.id, i, test.id);
    } catch (err) {
      noteStoreFailure('linkPlanKbScenarioTest', err);
    }
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
  const scenarioIndexByKey = new Map<string, number>();

  for (const r of outcome.results) {
    // The generated test titles are the model's own words, but they are guaranteed
    // to carry the "[REQ:<tag>]" marker on EVERY scenario test (see generate.ts's
    // per-test tagging requirement). Recover the tag from the result title first —
    // it keys directly onto the rows inserted in GENERATE — and only fall back to
    // normalized-title matching when no tag survived.
    const tagFromTitle = extractReqTag(r.title);
    // Prefer the longest spec title that PREFIXES this result's title (every
    // scenario row's title is `${spec.title} — ${kind}: ${description}`, see
    // registerSpecRows) over a bare reqTag/title match — reqTag alone is
    // ambiguous whenever two items share one (see registerSpecRows' item-
    // lookup comment); a spec's own title embeds its originating item's
    // title text, which is effectively unique per item. Longest-prefix
    // (not first-found) avoids one item's title being a textual prefix of
    // another's. Falls back to reqTag/title-only matching for a result with
    // no real spec behind it (synthetic/fallback rows).
    const titlePrefixMatches = specs.filter((s) => r.title.startsWith(s.title));
    const matched =
      titlePrefixMatches.reduce<GeneratedSpec | undefined>(
        (best, s) => (!best || s.title.length > best.title.length ? s : best),
        undefined,
      ) ??
      specs.find(
        (s) =>
          (tagFromTitle !== null && (s.reqTag ?? '').trim() === tagFromTitle) ||
          stableKey(undefined, s.title) === stableKey(undefined, r.title),
      );
    // Mirrors registerSpecRows' `item:<id>` key when the matched spec carries
    // one — reqTag-only keying would let two same-reqTag items share this
    // positional keyspace and silently route one's results onto the other's
    // rows. Falling back to reqTag/title matching (as before) covers a
    // carried-forward spec or a result with no matched spec at all.
    const itemKey = matched?.planItemId ? `item:${matched.planItemId}` : null;
    const base =
      itemKey ??
      (tagFromTitle
        ? stableKey(tagFromTitle, r.title)
        : matched
          ? stableKey(matched.reqTag, matched.title)
          : null);

    let testId: string | undefined;
    if (base) {
      const counterKey = itemKey ?? tagFromTitle ?? matched?.reqTag ?? base;
      const scenarioIndex = scenarioIndexByKey.get(counterKey) ?? 0;
      scenarioIndexByKey.set(counterKey, scenarioIndex + 1);
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
          specCode: matched?.contents ?? null,
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
        skipReason: r.skipReason ?? null,
        videoUnavailableReason: r.videoUnavailableReason ?? null,
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
    try {
      // Mirror onto whichever KB scenario row is linked to this test (by the
      // testId just resolved above, not by re-deriving position) — a no-op
      // for a test with no KB link (predates the KB, or a carried-forward/
      // fallback row that was never seeded). See
      // docs/design/retry-pass-coverage-kb-redesign.md.
      store.updatePlanKbScenarioStatusByTestId(testId, r.status as TestStatus);
      noteStoreOk();
    } catch (err) {
      noteStoreFailure('updatePlanKbScenarioStatusByTestId', err);
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
    groupingSummary?: string | null;
    groupingSummaryUnavailableReason?: GroupingSummaryUnavailableReason | null;
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
    groupingSummary: degradation?.groupingSummary ?? null,
    groupingSummaryUnavailableReason: degradation?.groupingSummaryUnavailableReason ?? null,
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

/** A `token=...` param, in the ordinary query string, a hash-routed fragment (`#/...?token=...`), or a bare `#/token=...` segment. */
const TOKEN_PARAM_RE = /(?:^|[?&#/])token=([^&]+)/i;
/** Any `key=value` pair in the path/query/hash portion of a URL, for pulling out extra substitutable params. */
const ANY_PARAM_RE = /(?:^|[?&#/])([a-zA-Z0-9_]+)=([^&]+)/g;

/**
 * See F-17 (Set 2 — fixtures/mock/auth execution): detects a token-like deep
 * link already sitting in a project's own baseUrl (`?token=...&mobile=...`,
 * or the same shape after a hash route) and synthesizes a usable url-token
 * ProjectCredential from it — `urlTemplate`/`extraParams` substituted back to
 * placeholders exactly as authSetupContents()'s loginUrlToken() expects, so
 * the run's baseUrl (origin only) plus this template reproduces the original,
 * already-working URL. Returns null when no token-like param is present —
 * that case is not this function's job to diagnose further; the caller's
 * ordinary "no credentials configured" hard-fail is still correct there.
 */
export function deriveUrlTokenCredentialFromBaseUrl(
  baseUrl: string | null | undefined,
): ProjectCredential | null {
  if (!baseUrl) return null;
  const tokenMatch = TOKEN_PARAM_RE.exec(baseUrl);
  if (!tokenMatch) return null;
  const rawToken = tokenMatch[1];

  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return null;
  }
  const rest = baseUrl.slice(origin.length);
  if (!rest) return null;

  const extraParams: Record<string, string> = {};
  ANY_PARAM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANY_PARAM_RE.exec(rest))) {
    const [, key, rawValue] = m;
    if (key.toLowerCase() === 'token') continue;
    extraParams[key] = decodeURIComponent(rawValue);
  }

  let urlTemplate = rest.split(rawToken).join('{token}');
  for (const [key, rawValue] of Object.entries(extraParams)) {
    urlTemplate = urlTemplate.split(encodeURIComponent(rawValue)).join(`{${key}}`);
    urlTemplate = urlTemplate.split(rawValue).join(`{${key}}`);
  }

  return {
    id: 'auto-derived-url-token',
    authType: 'url-token',
    role: null,
    username: '',
    password: '',
    token: decodeURIComponent(rawToken),
    urlTemplate,
    extraParams: Object.keys(extraParams).length > 0 ? extraParams : null,
    authCheckText: null,
  };
}

/** Tally the mock server's request log by dependency id, for the report. */
function computeMockedRequestCounts(handle: MockServerHandle | null): Record<string, number> {
  if (!handle) return {};
  const counts: Record<string, number> = {};
  for (const r of handle.requestLog) counts[r.dependencyId] = (counts[r.dependencyId] ?? 0) + 1;
  return counts;
}

/**
 * See F-15: the launch-time mock HTTP server's own counts (above) and the
 * mode's browser-level fixture mocking (execute.ts's ExecOutcome.
 * mockedRequestCounts — page.route()/`request`-fixture hits) are two
 * completely independent mocking mechanisms with no shared bookkeeping.
 * mockedRequestCounts used to only ever reflect the former, reading `{}` for
 * any run whose mocking happened entirely at the fixture level. Sums both
 * into one true total for the report.
 */
export function mergeMockedRequestCounts(
  a: Record<string, number>,
  b: Record<string, number> | undefined,
): Record<string, number> {
  if (!b || Object.keys(b).length === 0) return a;
  const merged: Record<string, number> = { ...a };
  for (const [id, count] of Object.entries(b)) merged[id] = (merged[id] ?? 0) + count;
  return merged;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}
