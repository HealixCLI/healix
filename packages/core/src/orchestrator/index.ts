import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectsDir } from '../env/app-data.js';
import { getStore } from '../storage/store.js';
import type { Project, Run, RunStatus, TestStatus, Tier } from '../storage/types.js';
import { ProviderRouter } from '../providers/router.js';
import type { ProviderAdapter } from '../providers/types.js';
import { getTestMode } from '../modes/registry.js';
import type {
  ExecOutcome,
  GeneratedSpec,
  TestModeContext,
  TestPlan,
} from '../modes/types.js';
import { createTargetAdapter } from '../target/index.js';
import { createBrowserSurface } from '../browser/index.js';
import { exportSuite } from '../export/index.js';
import { createTriageEngine } from '../triage/index.js';
import { buildPlanPrompt, parsePlan, synthesizePlan } from './plan.js';
import { buildReport, renderReportHtml, type ReportTriageEntry } from './report.js';
import type {
  Orchestrator,
  OrchestratorEvent,
  OrchestratorHooks,
  OrchestratorPhase,
  RunOptions,
  RunSummary,
} from './types.js';

export * from './types.js';

/** Real resumable run state machine for the Healix orchestrator. */
export function createOrchestrator(): Orchestrator {
  return {
    run(opts: RunOptions, hooks?: OrchestratorHooks): Promise<RunSummary> {
      return runPipeline(opts, hooks);
    },
  };
}

async function runPipeline(opts: RunOptions, hooks?: OrchestratorHooks): Promise<RunSummary> {
  const store = await getStore();
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
  const runDir = join(projectsDir(), project.id, 'runs', runId);

  // Mutable status mirror so the returned summary always reflects the latest phase.
  let currentStatus: RunStatus = 'pending';
  const setStatus = (status: RunStatus, patch: { startedAt?: string; finishedAt?: string } = {}): void => {
    currentStatus = status;
    try {
      store.updateRunStatus(runId, status, patch);
    } catch {
      /* persistence best-effort; never abort the pipeline on a status write */
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
    } catch {
      /* best-effort */
    }
    try {
      hooks?.onEvent?.({ phase, level, message, data });
    } catch {
      /* never let a hook crash the run */
    }
  };

  const ctxEmit = (phase: string, message: string, data?: unknown): void => emit(phase, 'info', message, data);

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
  // Stable key -> testId, so EXECUTE reuses the rows inserted in GENERATE (no duplicates).
  const testIdByKey = new Map<string, string>();
  // The base URL the suite should actually target (may be overridden by a white-box launch).
  let effectiveBaseUrl: string | null = project.baseUrl;
  // White-box launch handle, stopped in the run's cleanup regardless of outcome.
  let launchHandle: { stop(): Promise<void> } | null = null;

  try {
    // ---- 3. PLAN ----
    setStatus('planning');
    emit('plan', 'info', 'Selecting planning provider.');
    const provider = await resolveProvider(opts.provider);
    if (!provider) {
      emit('plan', 'error', 'No ready provider available for planning.');
      setStatus('error', { finishedAt: nowIso() });
      return { runId, status: 'error' };
    }
    // The auto-select path already guarantees a ready+authenticated provider (router.select).
    // The explicit-provider path (router.get) does not, so verify it here to match that guarantee.
    if (opts.provider) {
      const health = await provider.health();
      if (health.status !== 'ready' || !health.authenticated) {
        emit(
          'plan',
          'error',
          `Provider "${provider.id}" is not ready (${health.status}, authenticated=${health.authenticated}): ${health.detail}`,
        );
        setStatus('error', { finishedAt: nowIso() });
        return { runId, status: 'error' };
      }
    }
    emit('plan', 'info', `Planning with provider "${provider.id}".`);

    plan = await runPlanPhase(provider, project, opts, emit);
    await writeJson(join(runDir, 'plan', 'plan.json'), plan);
    emit('plan', 'info', `Plan ready: ${plan.items.length} item(s).`, { summary: plan.summary });
    setStatus('awaiting-approval');

    // ---- 4. APPROVE ----
    if (!opts.autoApprove && hooks?.onPlan) {
      emit('approve', 'info', 'Awaiting plan approval.');
      let approved = false;
      try {
        approved = await hooks.onPlan(plan);
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
    const target = createTargetAdapter();
    const browser = createBrowserSurface();

    // ---- 5b. LAUNCH (white-box) ----
    // A white-box project (repoPath set, no baseUrl) has no live URL yet, so detect + launch
    // the app and target the resulting URL. Best-effort: on failure, fall back to the detected
    // baseUrl rather than aborting. The handle is always stopped in the run's cleanup.
    if (!project.baseUrl && project.repoPath) {
      const repoPath = project.repoPath;
      try {
        emit('launch', 'info', `[launch] Detecting app in ${repoPath}.`);
        const det = await target.detect(repoPath);
        emit('launch', 'info', `[launch] Launching app (${det.startCommand ?? 'auto'}).`);
        const handle = await target.launch({
          repoPath,
          startCommand: det.startCommand ?? undefined,
          baseUrl: det.baseUrl ?? undefined,
          port: det.port ?? undefined,
          readyTimeoutMs: 120000,
        });
        launchHandle = handle;
        effectiveBaseUrl = handle.baseUrl;
        emit('launch', 'info', `[launch] App ready at ${handle.baseUrl}.`);
      } catch (err) {
        emit('launch', 'warn', `[launch] Launch failed (continuing best-effort): ${errMsg(err)}`, {
          stack: errStack(err),
        });
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
    };
    const mode = getTestMode(project.mode);

    // ---- 6. EXPLORE (best-effort) ----
    if (effectiveBaseUrl && ctx.explorationMode === 'computer-use') {
      setStatus('exploring');
      emit('explore', 'info', `Exploring ${effectiveBaseUrl} (computer-use).`);
      try {
        await browser.start({ headless: true, baseUrl: effectiveBaseUrl });
        await browser.goto(effectiveBaseUrl);
        const snap = await browser.snapshot();
        emit('explore', 'info', `Explored "${snap.title}".`, {
          url: snap.url,
          interactiveElements: snap.interactiveElements.length,
        });
      } catch (err) {
        emit('explore', 'warn', `Exploration failed (continuing): ${errMsg(err)}`, { stack: errStack(err) });
      } finally {
        await browser.stop().catch(() => undefined);
      }
    } else {
      emit('explore', 'debug', 'Skipping exploration.');
    }

    // ---- 7. GENERATE ----
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
      const summary = await finalizeReport(runDir, run, project, currentStatus, plan, outcome, triageEntries);
      return { runId, status: 'error', reportPath: summary.reportPath, outcome: outcome ?? undefined };
    }

    // ---- 8. EXECUTE ----
    setStatus('executing');
    emit('execute', 'info', `Executing ${specs.length} spec(s).`);
    try {
      outcome = await mode.execute(ctx, specs);
      persistResults(store, runId, specs, outcome, testIdByKey);
      emit('execute', 'info', `Execution complete: ${outcome.passed} passed, ${outcome.failed} failed.`, {
        passed: outcome.passed,
        failed: outcome.failed,
        blocked: outcome.blocked,
        flaky: outcome.flaky,
      });
    } catch (err) {
      emit('execute', 'error', `Execution failed: ${errMsg(err)}`, { stack: errStack(err) });
      setStatus('error', { finishedAt: nowIso() });
      const summary = await finalizeReport(runDir, run, project, currentStatus, plan, outcome, triageEntries);
      return { runId, status: 'error', reportPath: summary.reportPath, outcome: outcome ?? undefined };
    }

    // ---- 9. TRIAGE (best-effort) ----
    setStatus('triaging');
    try {
      const failed = outcome.results.filter((r) => r.status === 'failed');
      if (failed.length > 0) {
        emit('triage', 'info', `Triaging ${failed.length} failure(s).`);
        const engine = createTriageEngine();
        for (const r of failed) {
          try {
            const triage = engine.classify({ title: r.title, error: r.error ?? '' });
            triageEntries.push({ title: r.title, error: r.error ?? '', triage });
          } catch (err) {
            emit('triage', 'warn', `Triage failed for "${r.title}": ${errMsg(err)}`);
          }
        }
        emit('triage', 'info', `Triaged ${triageEntries.length} failure(s).`);
      } else {
        emit('triage', 'debug', 'No failures to triage.');
      }
    } catch (err) {
      emit('triage', 'warn', `Triage phase error (continuing): ${errMsg(err)}`, { stack: errStack(err) });
    }

    // ---- 10. REPORT ----
    setStatus('reporting');
    emit('report', 'info', 'Writing report.');
    const reportPath = (
      await finalizeReport(runDir, run, project, currentStatus, plan, outcome, triageEntries)
    ).reportPath;

    // ---- 11. EXPORT (best-effort) ----
    let suite: RunSummary['suite'];
    try {
      emit('export', 'info', 'Exporting standalone suite.');
      suite = await exportSuite({ suiteDir: ctx.projectDir, outDir: join(runDir, 'export') });
      emit('export', 'info', `Exported ${suite.files.length} file(s).`, { dir: suite.dir, zipPath: suite.zipPath });
    } catch (err) {
      emit('export', 'warn', `Export failed (continuing): ${errMsg(err)}`, { stack: errStack(err) });
    }

    const finalStatus: RunStatus = outcome.failed > 0 ? 'failed' : 'passed';
    setStatus(finalStatus, { finishedAt: nowIso() });
    emit('done', 'info', `Run ${finalStatus}.`, { runId, status: finalStatus });

    return { runId, status: finalStatus, reportPath, suite, outcome };
  } catch (err) {
    // Catch-all: keep the run recoverable and always return a summary.
    emit('done', 'error', `Run failed: ${errMsg(err)}`, { stack: errStack(err) });
    let reportPath: string | undefined;
    try {
      reportPath = (
        await finalizeReport(runDir, run, project, 'error', plan, outcome, triageEntries)
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

/** Resolve the provider: explicit id (router.get) or auto-select for the 'plan' capability. */
async function resolveProvider(id: RunOptions['provider']): Promise<ProviderAdapter | undefined> {
  const router = new ProviderRouter();
  if (id) {
    return router.get(id);
  }
  const selected = await router.select('plan');
  return selected?.provider;
}

/** Run the model to obtain a plan, falling back to a synthesized plan on any failure. */
async function runPlanPhase(
  provider: ProviderAdapter,
  project: Project,
  opts: RunOptions,
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void,
): Promise<TestPlan> {
  const prompt = buildPlanPrompt(project, opts);
  try {
    const completion = await provider.complete(prompt, {
      mode: 'plan',
      cwd: project.repoPath ?? undefined,
    });
    if (completion.ok && completion.text) {
      const parsed = parsePlan(completion.text);
      if (parsed) return parsed;
      emit('plan', 'warn', 'Could not parse plan JSON; synthesizing fallback.');
    } else {
      emit('plan', 'warn', `Provider returned no usable plan (${completion.detail}); synthesizing fallback.`);
    }
  } catch (err) {
    emit('plan', 'warn', `Planning provider threw: ${errMsg(err)}; synthesizing fallback.`, { stack: errStack(err) });
  }
  return synthesizePlan(project);
}

/**
 * Persist execution results. The test rows were already inserted in GENERATE, so each
 * result is matched back to its spec by a stable key (reqTag preferred, else normalized
 * title) and we insert ONLY the result row. A result with no matching spec gets a single
 * fallback test row so it is still recorded exactly once.
 */
function persistResults(
  store: NonNullable<Awaited<ReturnType<typeof getStore>>>,
  runId: string,
  specs: GeneratedSpec[],
  outcome: ExecOutcome,
  testIdByKey: Map<string, string>,
): void {
  for (const r of outcome.results) {
    // Recover the spec by normalized title, then key on the SAME stable key used in GENERATE
    // (reqTag preferred) so we reuse the row inserted there instead of duplicating it.
    const matched = specs.find((s) => stableKey(undefined, s.title) === stableKey(undefined, r.title));
    const key = stableKey(matched?.reqTag, matched?.title ?? r.title);
    let testId = testIdByKey.get(key);
    if (!testId) {
      // No spec matched this result — insert a single fallback test row to anchor it.
      const fallback = store.insertTest({
        runId,
        title: r.title,
        reqTag: matched?.reqTag ?? null,
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
    } catch {
      /* best-effort persistence */
    }
  }
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
): Promise<{ reportPath: string | undefined }> {
  const effectivePlan: TestPlan = plan ?? { summary: 'No plan generated.', items: [] };
  const report = buildReport({
    run: { ...run, status },
    project,
    plan: effectivePlan,
    outcome,
    triage,
  });
  const reportPath = join(runDir, 'reports', 'report.json');
  try {
    await writeJson(reportPath, report);
    await writeFile(join(runDir, 'reports', 'report.html'), renderReportHtml(report), 'utf8');
    return { reportPath };
  } catch {
    return { reportPath: undefined };
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

function nowIso(): string {
  return new Date().toISOString();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}
