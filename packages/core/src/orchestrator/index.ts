import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectsDir } from '../env/app-data.js';
import { getStore, type HealixStore } from '../storage/store.js';
import type { Project, Run, RunStatus, TestStatus, Tier } from '../storage/types.js';
import { ProviderRouter } from '../providers/router.js';
import type { ProviderAdapter } from '../providers/types.js';
import { getTestMode } from '../modes/registry.js';
import type {
  ExecOutcome,
  GeneratedSpec,
  SuiteBundle,
  TestMode,
  TestModeContext,
  TestPlan,
} from '../modes/types.js';
import { createTargetAdapter } from '../target/index.js';
import { findFreePort } from '../target/launcher.js';
import { runCli } from '../exec/run-cli.js';
import { createBrowserSurface } from '../browser/index.js';
import { exportSuite } from '../export/index.js';
import { createTriageEngine } from '../triage/index.js';
import type { TriageInput } from '../triage/types.js';
import { buildPlanPrompt, parsePlan, synthesizePlan, type PlanRepoContext } from './plan.js';
import { buildReport, renderReportHtml, type ReportTriageEntry } from './report.js';
import type {
  Orchestrator,
  OrchestratorEvent,
  OrchestratorHooks,
  OrchestratorOverrides,
  OrchestratorPhase,
  RunOptions,
  RunSummary,
} from './types.js';

export * from './types.js';

/** Per-call budget for the best-effort AI triage enrichment. */
const TRIAGE_ANALYZE_TIMEOUT_MS = 20_000;
/** How many failures (at most) get escalated to AI triage analysis. */
const TRIAGE_AI_LIMIT = 3;
/** Consecutive best-effort store-write failures before we warn that persistence is down. */
const STORE_FAILURE_WARN_THRESHOLD = 3;

/**
 * Run state machine for the Healix orchestrator. Every phase transition is
 * checkpointed to SQLite (run status + events), so an interrupted run is fully
 * inspectable after the fact — but runs are NOT resumable: an interrupted run
 * stays in its last recorded state and a new run must be started. (Startup
 * reconciliation of orphaned rows lives in HealixStore.failOrphanedRuns().)
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
  };
}

async function runPipeline(
  opts: RunOptions,
  hooks?: OrchestratorHooks,
  overrides?: OrchestratorOverrides,
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

  const run = store.createRun(project.id, { provider: opts.provider ?? null, mode: project.mode });
  const runId = run.id;
  // Surface the canonical runId immediately so callers (e.g. the desktop app)
  // correlate events/approval to THIS run instead of pre-creating a duplicate.
  try {
    hooks?.onRunCreated?.(runId);
  } catch {
    // a callback fault must never abort the run
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

  const setStatus = (status: RunStatus, patch: { startedAt?: string; finishedAt?: string } = {}): void => {
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

  setStatus('pending', { startedAt: nowIso() });

  // Accumulated across phases so the report/summary survive partial failures.
  let plan: TestPlan | null = null;
  let specs: GeneratedSpec[] = [];
  let outcome: ExecOutcome | null = null;
  const triageEntries: ReportTriageEntry[] = [];
  // Artifact files collected from the mode after EXECUTE (relative paths), surfaced in the report.
  let artifactFiles: string[] = [];
  // Stable key -> testId, so EXECUTE reuses the rows inserted in GENERATE (no duplicates).
  const testIdByKey = new Map<string, string>();
  // The base URL the suite should actually target (may be overridden by a white-box launch).
  let effectiveBaseUrl: string | null = project.baseUrl;
  // White-box launch handle, stopped in the run's cleanup regardless of outcome.
  let launchHandle: { stop(): Promise<void> } | null = null;

  try {
    // ---- 3. PLAN ----
    if (checkCancelled()) return cancelRun('plan');
    setStatus('planning');
    emit('plan', 'info', 'Selecting planning provider.');
    // An injected provider override bypasses the router entirely (used in tests).
    // Otherwise resolveProvider handles BOTH paths and guarantees a ready+authenticated
    // result: the auto path via router.select('plan'), and the explicit path by probing
    // the requested provider's health and falling back to the other ready provider when
    // it is unhealthy (emitting a warn). It returns undefined only when none are ready.
    const provider = overrides?.provider ?? (await resolveProvider(opts.provider, emit));
    if (!provider) {
      emit('plan', 'error', 'No ready provider available for planning.');
      setStatus('error', { finishedAt: nowIso() });
      return { runId, status: 'error' };
    }
    emit('plan', 'info', `Planning with provider "${provider.id}".`);

    // The target adapter is built before planning (it is a cheap bag of
    // functions) so the plan phase can reuse its repo indexer for grounding.
    const target = makeTarget();

    // Best-effort repo grounding: a white-box plan is dramatically better when
    // the model can see the repo's real structure (routes/pages/dirs), but
    // indexing must never block or break planning — any failure simply means
    // "plan without repo context".
    let repoIndex: PlanRepoContext | undefined;
    if (project.repoPath) {
      try {
        const idx = await target.indexRepo(project.repoPath, { maxFiles: 200 });
        repoIndex = { summary: idx.summary, files: idx.files };
        emit('plan', 'debug', `Indexed repo for plan grounding (${idx.files.length} file(s)).`);
      } catch (err) {
        emit('plan', 'debug', `Repo indexing failed (planning without repo context): ${errMsg(err)}`);
      }
    }

    plan = await runPlanPhase(provider, project, opts, emit, overrides, repoIndex);
    await writeJson(join(runDir, 'plan', 'plan.json'), plan);
    emit('plan', 'info', `Plan ready: ${plan.items.length} item(s).`, { summary: plan.summary });
    setStatus('awaiting-approval');

    // ---- 4. APPROVE ----
    if (checkCancelled()) return cancelRun('approve');
    if (!opts.autoApprove && hooks?.onPlan) {
      emit('approve', 'info', 'Awaiting plan approval.');
      let approved = false;
      try {
        // Race the (potentially indefinite) human approval gate against abort:
        // a run cancelled while parked at the gate must resolve 'cancelled',
        // not hang forever awaiting an approval that will never come. The
        // gate's eventual result is simply discarded after an abort.
        const gate = await raceAbort(hooks.onPlan(plan), signal);
        if (gate === ABORTED) {
          return cancelRun('approve', 'Run cancelled while awaiting approval.');
        }
        approved = gate;
      } catch (err) {
        emit('approve', 'warn', `Approval gate threw: ${errMsg(err)}`, { stack: errStack(err) });
        approved = false;
      }
      if (!approved) {
        emit('approve', 'info', 'Plan rejected; cancelling run.');
        setStatus('cancelled', { finishedAt: nowIso() });
        return { runId, status: 'cancelled' };
      }
      emit('approve', 'info', 'Plan approved.');
    } else {
      emit('approve', 'info', opts.autoApprove ? 'Auto-approved.' : 'No approval gate; proceeding.');
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
    if (checkCancelled()) return cancelRun('launch');
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
        const doLaunch = async (): Promise<void> => {
          const handle = await target.launch({
            repoPath,
            startCommand: det.startCommand ?? undefined,
            // det.baseUrl embeds the DETECTED port; when the allocated port
            // differs, omit it so launch() derives the URL from `port` and the
            // readiness poll targets the server this run actually started.
            baseUrl: port === det.port ? (det.baseUrl ?? undefined) : undefined,
            port,
            readyTimeoutMs: 120000,
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
          runDir,
          run,
          project,
          currentStatus,
          plan,
          outcome,
          triageEntries,
          artifactFiles,
          noteStoreOk,
          noteStoreFailure,
        );
        return { runId, status: 'error', reportPath: summary.reportPath };
      }
    }

    const ctx: TestModeContext = {
      projectDir: join(runDir, 'suite'),
      repoPath: project.repoPath,
      baseUrl: effectiveBaseUrl,
      provider,
      target,
      browser,
      explorationMode: opts.explorationMode ?? 'codegen',
      emit: ctxEmit,
      // Long mode phases (generate/execute) receive the run's abort signal so
      // in-flight provider/suite work is killed on cancellation, not just
      // skipped at the next phase boundary.
      signal,
    };
    const mode = getMode(project.mode);

    // ---- 6. EXPLORE (best-effort) ----
    // Runs in BOTH exploration modes whenever a live URL exists: the DOM
    // snapshot grounds GENERATE in real selectors either way. Codegen mode
    // used to skip this entirely, so its specs guessed routes/locators blind —
    // the dominant source of test_is_wrong failures. Frame mirroring (the live
    // browser view in the desktop app) stays a computer-use-only feature.
    if (checkCancelled()) return cancelRun('explore');
    if (effectiveBaseUrl) {
      setStatus('exploring');
      emit('explore', 'info', `Exploring ${effectiveBaseUrl} (${ctx.explorationMode ?? 'codegen'}).`);
      // Live frame mirroring is best-effort and must never abort the run; the
      // subscription + browser teardown both happen in this phase's finally.
      let unsubFrames: (() => void) | null = null;
      try {
        await browser.start({ headless: true, baseUrl: effectiveBaseUrl });
        await browser.goto(effectiveBaseUrl);
        // Subscribe AFTER start/goto so the UI only mirrors the live page.
        if (hooks?.onFrame && ctx.explorationMode === 'computer-use') {
          try {
            unsubFrames = browser.onFrame(hooks.onFrame);
          } catch (err) {
            emit('explore', 'debug', `Frame subscription failed (continuing): ${errMsg(err)}`);
          }
        }
        const snap = await browser.snapshot();
        // Ground GENERATE in what we actually observed: the interactive-element
        // inventory is fed into the generation prompt so specs target real
        // selectors instead of guessing (was captured, then dropped).
        ctx.snapshot = snap;
        emit('explore', 'info', `Explored "${snap.title}".`, {
          url: snap.url,
          interactiveElements: snap.interactiveElements.length,
        });
      } catch (err) {
        emit('explore', 'warn', `Exploration failed (continuing): ${errMsg(err)}`, { stack: errStack(err) });
      } finally {
        // Always unsubscribe before stopping the browser, both best-effort.
        if (unsubFrames) {
          try {
            unsubFrames();
          } catch {
            /* never let unsubscribe crash the run */
          }
        }
        await browser.stop().catch(() => undefined);
      }
    } else {
      emit('explore', 'debug', 'Skipping exploration.');
    }

    // ---- 7. GENERATE ----
    if (checkCancelled()) return cancelRun('generate');
    setStatus('generating');
    emit('generate', 'info', 'Scaffolding suite.');
    try {
      await mode.scaffold(ctx);
      emit('generate', 'info', 'Generating specs.');
      specs = await mode.generate(ctx, plan);
      for (const spec of specs) {
        const test = store.insertTest({
          runId,
          title: spec.title,
          reqTag: spec.reqTag ?? null,
          tier: (spec.tier ?? null) as Tier | null,
          status: 'pending',
        });
        testIdByKey.set(stableKey(spec.reqTag, spec.title), test.id);
      }
      emit('generate', 'info', `Generated ${specs.length} spec(s).`);
    } catch (err) {
      emit('generate', 'error', `Generation failed: ${errMsg(err)}`, { stack: errStack(err) });
      setStatus('error', { finishedAt: nowIso() });
      const summary = await finalizeReport(
        runDir,
        run,
        project,
        currentStatus,
        plan,
        outcome,
        triageEntries,
        artifactFiles,
        noteStoreOk,
        noteStoreFailure,
      );
      return { runId, status: 'error', reportPath: summary.reportPath, outcome: outcome ?? undefined };
    }

    // ---- 8. EXECUTE ----
    if (checkCancelled()) return cancelRun('execute');
    setStatus('executing');
    emit('execute', 'info', `Executing ${specs.length} spec(s).`);
    try {
      outcome = await mode.execute(ctx, specs);
      persistResults(store, runId, specs, outcome, testIdByKey, noteStoreOk, noteStoreFailure);
      emit('execute', 'info', `Execution complete: ${outcome.passed} passed, ${outcome.failed} failed.`, {
        passed: outcome.passed,
        failed: outcome.failed,
        blocked: outcome.blocked,
        flaky: outcome.flaky,
      });
    } catch (err) {
      emit('execute', 'error', `Execution failed: ${errMsg(err)}`, { stack: errStack(err) });
      setStatus('error', { finishedAt: nowIso() });
      const summary = await finalizeReport(
        runDir,
        run,
        project,
        currentStatus,
        plan,
        outcome,
        triageEntries,
        artifactFiles,
        noteStoreOk,
        noteStoreFailure,
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

    // ---- 9. TRIAGE (best-effort) ----
    // classify() is the deterministic baseline for EVERY failure. For the first
    // few failures we additionally try AI analyze() with a short per-call timeout
    // and merge its verdict/confidence in; analyze() already falls back to
    // classify() internally, so the baseline is never lost. Triage never aborts.
    // Blocked outcomes are triaged too: a blocked test is precisely where
    // classification is least certain (was it really a prerequisite failure,
    // or a mislabeled defect?), so skipping them hid defects from the report.
    if (checkCancelled()) return cancelRun('triage');
    setStatus('triaging');
    try {
      const failed = outcome.results.filter((r) => r.status === 'failed' || r.status === 'blocked');
      if (failed.length > 0) {
        emit('triage', 'info', `Triaging ${failed.length} failure(s)/blocked outcome(s).`);
        const engine = createTriageEngine();
        let aiBudget = TRIAGE_AI_LIMIT;
        for (const r of failed) {
          // Recover the originating spec (by normalized title) to ground the triage
          // input with its requirement tag and source.
          const spec = specs.find((s) => stableKey(undefined, s.title) === stableKey(undefined, r.title));
          const input: TriageInput = {
            title: r.title,
            error: r.error ?? '',
            ...(spec?.reqTag ? { reqTag: spec.reqTag } : {}),
            ...(spec?.contents ? { specSource: spec.contents } : {}),
          };
          // Deterministic baseline always wins as the starting point and the fallback.
          let triage: ReportTriageEntry['triage'];
          try {
            triage = engine.classify(input);
          } catch (err) {
            emit('triage', 'warn', `Triage classify failed for "${r.title}": ${errMsg(err)}`);
            continue;
          }
          // Best-effort AI enrichment for the first N failures, bounded per call.
          if (aiBudget > 0) {
            aiBudget -= 1;
            const controller = new AbortController();
            try {
              const enriched = await withTimeoutAbort(
                engine.analyze(input, provider, controller.signal),
                TRIAGE_ANALYZE_TIMEOUT_MS,
                controller,
              );
              if (enriched) triage = enriched;
            } catch (err) {
              // Timeout / analyze() threw — keep the deterministic baseline.
              emit('triage', 'debug', `AI triage skipped for "${r.title}": ${errMsg(err)}`);
            }
          }
          triageEntries.push({ title: r.title, error: r.error ?? '', triage });
        }
        emit('triage', 'info', `Triaged ${triageEntries.length} failure(s).`);
      } else {
        emit('triage', 'debug', 'No failures to triage.');
      }
    } catch (err) {
      emit('triage', 'warn', `Triage phase error (continuing): ${errMsg(err)}`, { stack: errStack(err) });
    }

    // ---- 10. REPORT ----
    if (checkCancelled()) return cancelRun('report');
    setStatus('reporting');
    emit('report', 'info', 'Writing report.');
    const reportPath = (
      await finalizeReport(
        runDir,
        run,
        project,
        currentStatus,
        plan,
        outcome,
        triageEntries,
        artifactFiles,
        noteStoreOk,
        noteStoreFailure,
      )
    ).reportPath;

    // ---- 11. EXPORT (best-effort) ----
    // Prefer the mode's own export() for the suite bundle; fall back to the
    // standalone exportSuite() if it throws. Either way, never abort the run.
    if (checkCancelled()) return cancelRun('export');
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
          runDir,
          run,
          project,
          'error',
          plan,
          outcome,
          triageEntries,
          artifactFiles,
          noteStoreOk,
          noteStoreFailure,
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
async function resolveProvider(
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
 * Run the model to obtain a plan, falling back to a synthesized plan on any failure.
 *
 * Provider-level fallback: if the primary provider's complete() throws or returns
 * ok:false AND a different ready provider exists, we retry the completion ONCE with
 * that fallback provider before giving up to the synthesized plan. The fallback is
 * skipped when a provider was injected via overrides (it is trusted as-is and there is
 * no router to consult).
 */
async function runPlanPhase(
  provider: ProviderAdapter,
  project: Project,
  opts: RunOptions,
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void,
  overrides?: OrchestratorOverrides,
  repoIndex?: PlanRepoContext,
): Promise<TestPlan> {
  const prompt = buildPlanPrompt(project, opts, repoIndex);
  // Attempt a single completion with one provider; classifies the outcome so the
  // caller can decide whether to retry with a fallback.
  const attempt = async (
    p: ProviderAdapter,
  ): Promise<{ plan: TestPlan } | { plan: null; retryable: boolean }> => {
    try {
      const completion = await p.complete(prompt, {
        mode: 'plan',
        cwd: project.repoPath ?? undefined,
        // Cancellation kills the in-flight provider CLI instead of letting a
        // cancelled run keep burning tokens; the adapter resolves ok:false,
        // and the pipeline's next boundary check turns that into 'cancelled'.
        signal: opts.signal,
      });
      if (completion.ok && completion.text) {
        const parsed = parsePlan(completion.text);
        if (parsed) return { plan: parsed };
        // ok but unparseable — not a provider fault, so don't retry on a different provider.
        emit('plan', 'warn', 'Could not parse plan JSON; synthesizing fallback.');
        return { plan: null, retryable: false };
      }
      // ok:false is a provider-level failure → eligible for one fallback retry.
      emit('plan', 'warn', `Provider "${p.id}" returned no usable plan (${completion.detail}).`);
      return { plan: null, retryable: true };
    } catch (err) {
      // A thrown completion is a provider-level failure → eligible for one fallback retry.
      emit('plan', 'warn', `Planning provider "${p.id}" threw: ${errMsg(err)}.`, { stack: errStack(err) });
      return { plan: null, retryable: true };
    }
  };

  const first = await attempt(provider);
  if (first.plan) return first.plan;

  // One-time provider fallback: only when the failure was provider-level (retryable),
  // a real router is in play (no injected override), and a DIFFERENT ready provider exists.
  if (first.retryable && !overrides?.provider) {
    const fallback = await new ProviderRouter().firstReady('plan', { exclude: provider.id });
    if (fallback) {
      emit('plan', 'warn', `Retrying plan with fallback provider "${fallback.id}".`, {
        primary: provider.id,
        fallback: fallback.id,
      });
      const second = await attempt(fallback);
      if (second.plan) return second.plan;
    }
  }

  emit('plan', 'warn', 'Synthesizing fallback plan.');
  return synthesizePlan(project);
}

/**
 * Persist execution results. The test rows were already inserted in GENERATE, so each
 * result is matched back to its spec by a stable key (reqTag preferred, else normalized
 * title) and we insert ONLY the result row. A result with no matching spec gets a single
 * fallback test row so it is still recorded exactly once.
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
  for (const r of outcome.results) {
    // The generated test titles are the model's own words, but they are guaranteed
    // to carry the "[REQ:<tag>]" marker (ensureReqTag). Recover the tag from the
    // result title first — it keys directly onto the row inserted in GENERATE —
    // and only fall back to normalized-title matching when no tag survived.
    const tagFromTitle = extractReqTag(r.title);
    const matched = specs.find(
      (s) =>
        (tagFromTitle !== null && (s.reqTag ?? '').trim() === tagFromTitle) ||
        stableKey(undefined, s.title) === stableKey(undefined, r.title),
    );
    const key = stableKey(tagFromTitle ?? matched?.reqTag, matched?.title ?? r.title);
    let testId = testIdByKey.get(key);
    if (!testId) {
      // No spec matched this result — insert a single fallback test row to anchor it.
      const fallback = store.insertTest({
        runId,
        title: r.title,
        reqTag: matched?.reqTag ?? tagFromTitle,
        tier: (matched?.tier ?? null) as Tier | null,
        status: r.status as TestStatus,
      });
      testId = fallback.id;
      testIdByKey.set(key, testId);
    }
    try {
      store.insertResult({
        testId,
        status: r.status as TestStatus,
        durationMs: r.durationMs ?? null,
        error: r.error ?? null,
        artifactsJson: r.artifacts && r.artifacts.length > 0 ? JSON.stringify(r.artifacts) : null,
      });
      // Keep the test row's status in sync — readers of `tests` (e.g. the CLI
      // report command) would otherwise see every test as eternally 'pending'.
      store.updateTestStatus(testId, r.status as TestStatus);
      noteStoreOk();
    } catch (err) {
      /* best-effort persistence */
      noteStoreFailure('insertResult', err);
    }
  }
}

/** Pull the "[REQ:<tag>]" marker out of an executed test's title, if present. */
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

/** Build + write report.json and report.html. Returns the report path (best-effort). */
async function finalizeReport(
  runDir: string,
  run: Run,
  project: Project,
  status: RunStatus,
  plan: TestPlan | null,
  outcome: ExecOutcome | null,
  triage: ReportTriageEntry[],
  artifacts: string[],
  noteStoreOk: () => void,
  noteStoreFailure: (op: string, err: unknown) => void,
): Promise<{ reportPath: string | undefined }> {
  const effectivePlan: TestPlan = plan ?? { summary: 'No plan generated.', items: [] };
  const report = buildReport({
    run: { ...run, status },
    project,
    plan: effectivePlan,
    outcome,
    triage,
    artifacts,
  });
  const reportPath = join(runDir, 'reports', 'report.json');
  try {
    await writeJson(reportPath, report);
    await writeFile(join(runDir, 'reports', 'report.html'), renderReportHtml(report), 'utf8');
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}
