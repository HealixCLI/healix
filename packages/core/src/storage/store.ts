import { nanoid } from 'nanoid';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, resetDbForTests } from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { validateNewProject } from './validate.js';
import type {
  AgentEvent,
  EventLevel,
  KbItemStatus,
  KbScenarioStatus,
  NewProject,
  NewProjectCredential,
  NewTriageResult,
  NewUsage,
  PauseReason,
  PlanKbItem,
  PlanKbScenario,
  Project,
  ProjectCredential,
  Run,
  RunStatus,
  SuiteMode,
  Tier,
  TestCase,
  TestResult,
  TestStatus,
  TriageResultRow,
  UsageAggregate,
  UsageRow,
} from './types.js';

/**
 * Thin synchronous repository over the local SQLite database.
 * All persistence (projects, runs, tests, results, orchestrator events) flows through here.
 */
export class HealixStore {
  constructor(private readonly db: DatabaseSync) {}

  // ---- projects ----
  createProject(input: NewProject): Project {
    // Validate + normalize here so EVERY caller (desktop IPC, CLI) is guarded
    // against creating an empty/unreachable project. validateNewProject is the
    // single source of truth for the invariant; the UI mirrors it for feedback.
    const validation = validateNewProject(input);
    if (!validation.ok) throw new Error(validation.error);
    const { name, mode, repoPath, baseUrl, credentials } = validation.value;
    this.assertNameAvailable(name);
    const id = `prj_${nanoid(10)}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO projects (id, name, mode, repo_path, base_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, mode, repoPath, baseUrl, createdAt);
    const savedCredentials = this.replaceCredentials(id, credentials);
    return { id, name, mode, repoPath, baseUrl, createdAt, archivedAt: null, credentials: savedCredentials };
  }

  /**
   * Update a project's editable fields (name, mode, repoPath, baseUrl, test
   * credentials). Runs the same validation as createProject — it is edited via
   * the identical form, so the identical invariant (name required, at least one
   * of repo/URL, a valid base URL) must hold. Throws if the project does not exist.
   */
  updateProject(id: string, input: NewProject): Project {
    const existing = this.getProject(id);
    if (!existing) throw new Error(`Project not found: ${id}`);
    const validation = validateNewProject(input);
    if (!validation.ok) throw new Error(validation.error);
    const { name, mode, repoPath, baseUrl, credentials } = validation.value;
    this.assertNameAvailable(name, id);
    this.db
      .prepare('UPDATE projects SET name = ?, mode = ?, repo_path = ?, base_url = ? WHERE id = ?')
      .run(name, mode, repoPath, baseUrl, id);
    const savedCredentials = this.replaceCredentials(id, credentials);
    return { ...existing, name, mode, repoPath, baseUrl, credentials: savedCredentials };
  }

  /**
   * Replace-all: delete every existing credential row for the project and
   * insert the given set fresh. Simple, correct semantics for a form that
   * always submits its full desired credential list rather than a delta —
   * the alternative (diffing old vs. new rows) buys nothing here since the
   * UI has no concept of "this row's identity persisted across edits" to
   * diff against anyway.
   */
  private replaceCredentials(projectId: string, credentials: NewProjectCredential[]): ProjectCredential[] {
    this.db.prepare('DELETE FROM project_credentials WHERE project_id = ?').run(projectId);
    const saved: ProjectCredential[] = [];
    credentials.forEach((c, i) => {
      const credId = `cred_${nanoid(10)}`;
      const authType = c.authType === 'url-token' ? 'url-token' : 'form';
      const username = c.username ?? '';
      const password = c.password ?? '';
      const role = c.role ?? null;
      const token = c.token ?? null;
      const urlTemplate = c.urlTemplate ?? null;
      const extraParams = c.extraParams ?? null;
      const authCheckText = c.authCheckText ?? null;
      this.db
        .prepare(
          'INSERT INTO project_credentials (id, project_id, username, password, role, auth_type, token, url_template, extra_params, auth_check_text, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          credId,
          projectId,
          username,
          encryptSecret(password),
          role,
          authType,
          encryptSecret(token),
          urlTemplate,
          extraParams ? JSON.stringify(extraParams) : null,
          authCheckText,
          i,
        );
      saved.push({
        id: credId,
        authType,
        username,
        password,
        role,
        token,
        urlTemplate,
        extraParams,
        authCheckText,
      });
    });
    return saved;
  }

  /** Every credential for a project, in save order, passwords decrypted. */
  private getCredentials(projectId: string): ProjectCredential[] {
    return (
      this.db
        .prepare('SELECT * FROM project_credentials WHERE project_id = ? ORDER BY sort_order ASC')
        .all(projectId) as Array<Record<string, unknown>>
    ).map(rowToCredential);
  }

  /**
   * Block duplicate project creation/renaming: names collide case-
   * insensitively (so "Acme" and "acme" can't coexist and confuse the Project
   * picker), scoped to ACTIVE projects only — an archived project's name is
   * free to reuse, since archiving is Healix's own "this is effectively gone"
   * signal. `excludeId` lets updateProject rename a project without it
   * colliding with itself.
   */
  private assertNameAvailable(name: string, excludeId = ''): void {
    const clash = this.db
      .prepare('SELECT id FROM projects WHERE lower(name) = lower(?) AND archived_at IS NULL AND id != ?')
      .get(name, excludeId) as { id: string } | undefined;
    if (clash) throw new Error(`A project named "${name}" already exists.`);
  }

  /** Soft-archive (or restore) a project. Archived projects keep all runs and assets. */
  setProjectArchived(id: string, archived: boolean): void {
    this.db
      .prepare('UPDATE projects SET archived_at = ? WHERE id = ?')
      .run(archived ? new Date().toISOString() : null, id);
  }

  listProjects(): Project[] {
    return (
      this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Array<
        Record<string, unknown>
      >
    ).map((row) => rowToProject(row, this.getCredentials(String(row.id))));
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToProject(row, this.getCredentials(id)) : null;
  }

  deleteProject(id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 1. results whose test belongs to a test of a run of this project
      this.db
        .prepare(
          'DELETE FROM results WHERE test_id IN (SELECT id FROM tests WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?))',
        )
        .run(id);
      // 2. triage_results whose test belongs to a test of a run of this project
      this.db
        .prepare(
          'DELETE FROM triage_results WHERE test_id IN (SELECT id FROM tests WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?))',
        )
        .run(id);
      // 3. agent_events of runs of this project
      this.db
        .prepare('DELETE FROM agent_events WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)')
        .run(id);
      // 4. tests of runs of this project
      this.db.prepare('DELETE FROM tests WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)').run(id);
      // 5. runs of this project
      this.db.prepare('DELETE FROM runs WHERE project_id = ?').run(id);
      // 6. this project's credentials
      this.db.prepare('DELETE FROM project_credentials WHERE project_id = ?').run(id);
      // 7. the project row itself
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // No active transaction to roll back — keep the original error.
      }
      throw err;
    }
  }

  // ---- runs ----
  createRun(
    projectId: string,
    opts: {
      provider?: string | null;
      mode?: string | null;
      suiteMode?: SuiteMode | null;
      baseRunId?: string | null;
    } = {},
  ): Run {
    const run: Run = {
      id: `run_${nanoid(10)}`,
      projectId,
      status: 'pending',
      provider: (opts.provider ?? null) as Run['provider'],
      mode: opts.mode ?? null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date().toISOString(),
      suiteMode: opts.suiteMode ?? null,
      baseRunId: opts.baseRunId ?? null,
      pauseReason: null,
    };
    this.db
      .prepare(
        'INSERT INTO runs (id, project_id, status, provider, mode, started_at, finished_at, created_at, suite_mode, base_run_id, pause_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        run.id,
        run.projectId,
        run.status,
        run.provider,
        run.mode,
        run.startedAt,
        run.finishedAt,
        run.createdAt,
        run.suiteMode,
        run.baseRunId,
        run.pauseReason,
      );
    return run;
  }

  /**
   * Most recent run for a project that actually executed and is eligible as a
   * top-up/reuse base — 'passed', 'failed', or 'blocked' (it produced a real
   * verdict over real tests), but NOT 'error' (verified nothing — no runnable
   * specs) or 'cancelled' (aborted mid-run, unreliable). Deliberately NOT
   * restricted to 'passed' only: a run with some failures still has its whole
   * suite worth carrying forward (regardless of each test's own status) —
   * that's the whole point of top-up.
   */
  getLastSuccessfulRun(projectId: string): Run | null {
    const row = this.db
      .prepare(
        // rowid tiebreaker: same reasoning as listEvents — several runs can share
        // the same millisecond created_at, so insertion order must break ties.
        `SELECT * FROM runs WHERE project_id = ? AND status IN ('passed', 'failed', 'blocked')
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : null;
  }

  /**
   * Janitor for runs orphaned by a crash/quit mid-pipeline that have NO
   * checkpoint to resume from (see checkpoint.ts) — genuinely nothing to
   * recover, so any run still in a non-terminal status whose row is older
   * than `olderThanMs` (default 6h) is marked 'error' with a finishedAt
   * stamp. The age threshold exists because a run may legitimately be in
   * flight in ANOTHER process (CLI vs desktop) — we only reap runs old
   * enough that no real pipeline could still be driving them.
   *
   * A run that DOES have a checkpoint is never reaped here: the desktop
   * app's boot-time reconciliation claims those first (marking them 'paused'
   * with pauseReason 'crashed' and auto-resuming), so by the time this runs
   * they're already 'paused' and excluded by the status filter below.
   * Returns the number of runs reaped.
   */
  failOrphanedRuns(opts: { olderThanMs?: number } = {}): number {
    const olderThanMs = opts.olderThanMs ?? 6 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE runs SET status = 'error', finished_at = ?
         WHERE status NOT IN ('passed', 'failed', 'blocked', 'error', 'cancelled', 'paused') AND created_at < ?`,
      )
      .run(new Date().toISOString(), cutoff);
    return Number(result.changes ?? 0);
  }

  updateRunStatus(
    id: string,
    status: RunStatus,
    patch: { startedAt?: string; finishedAt?: string; pauseReason?: PauseReason | null } = {},
  ): void {
    const fields: string[] = ['status = ?'];
    const values: unknown[] = [status];
    if (patch.startedAt !== undefined) {
      fields.push('started_at = ?');
      values.push(patch.startedAt);
    }
    if (patch.finishedAt !== undefined) {
      fields.push('finished_at = ?');
      values.push(patch.finishedAt);
    }
    if (patch.pauseReason !== undefined) {
      fields.push('pause_reason = ?');
      values.push(patch.pauseReason);
    }
    values.push(id);
    this.db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * Runs currently 'paused' with a transient reason ('network' or
   * 'credits-exhausted') — candidates for boot-time auto-resume (see
   * checkpoint.ts / the desktop app's reconciliation step). 'manual' and
   * 'budget-exceeded' never appear here: both need a human decision (resume
   * as-is, or — for a budget ceiling — raise it) rather than an automatic retry.
   */
  listAutoResumableRuns(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE status = 'paused' AND pause_reason NOT IN ('manual', 'budget-exceeded') ORDER BY created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToRun);
  }

  /**
   * Non-terminal, non-paused runs — i.e. still showing an in-flight status
   * (planning/generating/executing/...) from a process that's no longer
   * driving them. Used by boot-time reconciliation to find crashed runs
   * BEFORE deciding (via checkpoint presence) whether to mark them resumable
   * or hand them to failOrphanedRuns().
   */
  listInFlightRuns(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE status NOT IN ('passed', 'failed', 'blocked', 'error', 'cancelled', 'paused')
         ORDER BY created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToRun);
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(projectId?: string): Run[] {
    const rows = projectId
      ? (this.db
          .prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC')
          .all(projectId) as Array<Record<string, unknown>>)
      : (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as Array<
          Record<string, unknown>
        >);
    return rows.map(rowToRun);
  }

  deleteRun(id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 1. results whose test belongs to this run
      this.db.prepare('DELETE FROM results WHERE test_id IN (SELECT id FROM tests WHERE run_id = ?)').run(id);
      // 2. triage_results whose test belongs to this run
      this.db
        .prepare('DELETE FROM triage_results WHERE test_id IN (SELECT id FROM tests WHERE run_id = ?)')
        .run(id);
      // 3. agent_events of this run
      this.db.prepare('DELETE FROM agent_events WHERE run_id = ?').run(id);
      // 4. usage rows of this run
      this.db.prepare('DELETE FROM usage WHERE run_id = ?').run(id);
      // 5. tests of this run
      this.db.prepare('DELETE FROM tests WHERE run_id = ?').run(id);
      // 6. the run row itself
      this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // No active transaction to roll back — keep the original error.
      }
      throw err;
    }
  }

  // ---- tests + results ----
  insertTest(
    test: Omit<TestCase, 'id' | 'specPath' | 'description' | 'details' | 'specCode'> & {
      id?: string;
      specPath?: string | null;
      description?: string | null;
      details?: string | null;
      specCode?: string | null;
    },
  ): TestCase {
    const full: TestCase = {
      ...test,
      id: test.id ?? `tst_${nanoid(10)}`,
      specPath: test.specPath ?? null,
      description: test.description ?? null,
      details: test.details ?? null,
      specCode: test.specCode ?? null,
    };
    this.db
      .prepare(
        'INSERT INTO tests (id, run_id, title, req_tag, tier, status, spec_path, description, details, spec_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        full.id,
        full.runId,
        full.title,
        full.reqTag,
        full.tier,
        full.status,
        full.specPath,
        full.description,
        full.details,
        full.specCode,
      );
    return full;
  }

  /** Reflect an execution outcome back onto the test row (inserted as 'pending' in GENERATE). */
  updateTestStatus(id: string, status: TestStatus): void {
    this.db.prepare('UPDATE tests SET status = ? WHERE id = ?').run(status, id);
  }

  /**
   * Replace a test row's placeholder title (synthesized at GENERATE time, before the
   * model's actual scenario test title was known) with its real executed title.
   */
  updateTestTitle(id: string, title: string): void {
    this.db.prepare('UPDATE tests SET title = ? WHERE id = ?').run(title, id);
  }

  /**
   * Upsert-by-test: a test row maps to exactly one result (see updateTestStatus's
   * doc comment), so any prior result for this testId is deleted before the new
   * one is inserted. Without this, re-persisting a test's outcome — e.g. a
   * resumed run re-executing a tier whose results already made it to the DB
   * before the checkpoint recorded that tier as done — leaves a stale row
   * behind, silently inflating any count that sums `results` rather than
   * joining through one-row-per-test.
   */
  insertResult(
    result: Omit<
      TestResult,
      'id' | 'description' | 'details' | 'stepsJson' | 'skipReason' | 'videoUnavailableReason'
    > & {
      id?: string;
      description?: string | null;
      details?: string | null;
      stepsJson?: string | null;
      skipReason?: string | null;
      videoUnavailableReason?: string | null;
    },
  ): TestResult {
    const full: TestResult = {
      ...result,
      id: result.id ?? `res_${nanoid(10)}`,
      description: result.description ?? null,
      details: result.details ?? null,
      stepsJson: result.stepsJson ?? null,
      skipReason: result.skipReason ?? null,
      videoUnavailableReason: result.videoUnavailableReason ?? null,
    };
    this.db.prepare('DELETE FROM results WHERE test_id = ?').run(full.testId);
    this.db
      .prepare(
        'INSERT INTO results (id, test_id, status, duration_ms, error, artifacts_json, description, details, steps_json, skip_reason, video_unavailable_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        full.id,
        full.testId,
        full.status,
        full.durationMs,
        full.error,
        full.artifactsJson,
        full.description,
        full.details,
        full.stepsJson,
        full.skipReason,
        full.videoUnavailableReason,
      );
    return full;
  }

  listTests(runId: string): TestCase[] {
    return (
      this.db.prepare('SELECT * FROM tests WHERE run_id = ?').all(runId) as Array<Record<string, unknown>>
    ).map(rowToTest);
  }

  /** Single test row by id, e.g. to copy its description/details onto a result being persisted. */
  getTest(id: string): TestCase | undefined {
    const row = this.db.prepare('SELECT * FROM tests WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTest(row) : undefined;
  }

  /** All result rows for a run, joined through tests (results have no run_id of their own). */
  listResults(runId: string): TestResult[] {
    return (
      this.db
        .prepare('SELECT r.* FROM results r JOIN tests t ON r.test_id = t.id WHERE t.run_id = ?')
        .all(runId) as Array<Record<string, unknown>>
    ).map(rowToResult);
  }

  /**
   * Persist one FK-keyed triage verdict for a test — upserts by testId (one
   * current verdict per test), rather than accumulating a new row every call.
   * Best-effort by design (mirrors recordUsage/insertResult's own style) — a
   * bad testId or a store fault here must never block report-writing, since
   * report.json's title-joined ReportTriageEntry already carries the verdict
   * either way; this is an additional, queryable record, not the source of
   * truth. The upsert matters because triage can legitimately run against the
   * same test more than once — a resumed mid-TRIAGE crash re-triages
   * candidates the orchestrator doesn't track as already-done (unlike
   * Generate/Execute's item-level skip), and Retry-pass/Repair re-triage a
   * targeted test outright — so a plain INSERT would leave stale duplicate
   * rows for the same test rather than replacing them.
   */
  recordTriageResult(input: NewTriageResult): TriageResultRow {
    const row: TriageResultRow = {
      id: `trg_${nanoid(10)}`,
      testId: input.testId,
      verdict: input.verdict,
      confidence: input.confidence,
      rationale: input.rationale,
      suggestedPatch: input.suggestedPatch ?? null,
      verdictSource: input.verdictSource ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM triage_results WHERE test_id = ?').run(row.testId);
      this.db
        .prepare(
          'INSERT INTO triage_results (id, test_id, verdict, confidence, rationale, suggested_patch, verdict_source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          row.id,
          row.testId,
          row.verdict,
          row.confidence,
          row.rationale,
          row.suggestedPatch,
          row.verdictSource,
          row.createdAt,
        );
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* best-effort rollback */
      }
      throw err;
    }
    return row;
  }

  /** All triage-result rows for a run, joined through tests (triage_results has no run_id of its own). */
  listTriageResults(runId: string): TriageResultRow[] {
    return (
      this.db
        .prepare(
          'SELECT tr.* FROM triage_results tr JOIN tests t ON tr.test_id = t.id WHERE t.run_id = ? ORDER BY tr.created_at ASC, tr.rowid ASC',
        )
        .all(runId) as Array<Record<string, unknown>>
    ).map(rowToTriageResult);
  }

  /**
   * Remove test rows pre-registered for a scenario that never actually got an
   * execution result — e.g. the plan called for 3 scenarios but generation
   * only produced 2 `test()` blocks, or the coverage loop broke early after
   * registering gap-fill rows but before executing them. Without this, those
   * rows sit at their initial 'pending' status forever, so the Results tab's
   * Total (which counts every `tests` row) ends up higher than the Report's
   * Total (`outcome.results.length`, grounded in what actually ran) — the
   * `tests` table and `outcome.results` must agree on "how many test cases".
   * A row with zero result rows (any status, including a genuine 'pending'/
   * skipped result) is unambiguously never-executed, so this only ever
   * removes rows that would otherwise silently inflate the count.
   */
  deleteUnexecutedTests(runId: string): number {
    const res = this.db
      .prepare('DELETE FROM tests WHERE run_id = ? AND id NOT IN (SELECT test_id FROM results)')
      .run(runId);
    return Number(res.changes ?? 0);
  }

  // ---- plan Knowledge Base (Retry-pass / coverage-feedback-loop) ----
  /**
   * Seed one KB item + its scenarios, idempotently (INSERT OR IGNORE — safe
   * to re-run on a resumed run without clobbering a further-along status).
   * `status`/each scenario's `status`/`testId` default to 'planned'/undefined
   * for the normal Planner seed call; the lazy pre-KB backfill (see
   * repair-candidates.ts) passes real current statuses instead, since it's
   * seeding a KB for a run whose items/scenarios may already be generated,
   * executed, or dropped. Returns the item's persisted KB id (existing row's,
   * if one already existed).
   */
  seedPlanKbItem(input: {
    runId: string;
    planItemId: string;
    title: string;
    reqTag: string | null;
    tier: Tier | null;
    status?: KbItemStatus;
    scenarios: Array<{
      index: number;
      kind: string;
      description: string;
      status?: KbScenarioStatus;
      testId?: string | null;
    }>;
  }): string {
    const id = `kbi_${nanoid(10)}`;
    this.db
      .prepare(
        'INSERT OR IGNORE INTO plan_kb_items (id, run_id, plan_item_id, title, req_tag, tier, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.runId,
        input.planItemId,
        input.title,
        input.reqTag,
        input.tier,
        input.status ?? 'planned',
      );
    const row = this.db
      .prepare('SELECT id FROM plan_kb_items WHERE run_id = ? AND plan_item_id = ?')
      .get(input.runId, input.planItemId) as { id: string } | undefined;
    const kbItemId = row?.id ?? id;
    for (const scenario of input.scenarios) {
      const scenarioId = `kbs_${nanoid(10)}`;
      this.db
        .prepare(
          'INSERT OR IGNORE INTO plan_kb_scenarios (id, kb_item_id, run_id, scenario_index, kind, description, status, test_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          scenarioId,
          kbItemId,
          input.runId,
          scenario.index,
          scenario.kind,
          scenario.description,
          scenario.status ?? 'planned',
          scenario.testId ?? null,
        );
    }
    return kbItemId;
  }

  /** True once at least one KB item exists for this run — used to decide whether a pre-KB run needs the lazy backfill. */
  hasPlanKbItems(runId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM plan_kb_items WHERE run_id = ? LIMIT 1').get(runId);
    return row !== undefined;
  }

  /**
   * Mark a KB item generated or dropped, cascading the CORRESPONDING status
   * to all its scenarios in the same write — GENERATE's own atomicity
   * guarantee (a spec is never partially accepted) means an item and its
   * scenarios always transition together. The cascade is NOT the same
   * literal string as the item's status: 'generated' is item-level only (it
   * means "a spec was produced") — a scenario whose item was just generated
   * is 'pending' (spec exists, no execution result yet; this is exactly what
   * listPendingPlanKbScenarios/Retry-pass/the coverage loop look for), not
   * 'generated'. A dropped item's scenarios genuinely are 'dropped' too, so
   * that one cascades as-is. UPDATE, not insert — the row must already exist
   * from the Planner's seed write; see
   * docs/design/retry-pass-coverage-kb-redesign.md's write-semantics callout
   * for why this must never be implemented as INSERT OR IGNORE.
   */
  updatePlanKbItemStatus(runId: string, planItemId: string, status: 'generated' | 'dropped'): void {
    const scenarioStatus: KbScenarioStatus = status === 'generated' ? 'pending' : 'dropped';
    this.db
      .prepare(
        "UPDATE plan_kb_items SET status = ?, updated_at = datetime('now') WHERE run_id = ? AND plan_item_id = ?",
      )
      .run(status, runId, planItemId);
    this.db
      .prepare(
        `UPDATE plan_kb_scenarios SET status = ?, updated_at = datetime('now')
         WHERE run_id = ? AND kb_item_id = (SELECT id FROM plan_kb_items WHERE run_id = ? AND plan_item_id = ?)`,
      )
      .run(scenarioStatus, runId, runId, planItemId);
  }

  /** Link a KB scenario row to the real tests row registerSpecRows just created for it. */
  linkPlanKbScenarioTest(runId: string, planItemId: string, scenarioIndex: number, testId: string): void {
    this.db
      .prepare(
        `UPDATE plan_kb_scenarios SET test_id = ?, updated_at = datetime('now')
         WHERE run_id = ? AND scenario_index = ?
           AND kb_item_id = (SELECT id FROM plan_kb_items WHERE run_id = ? AND plan_item_id = ?)`,
      )
      .run(testId, runId, scenarioIndex, runId, planItemId);
  }

  /**
   * Mirror an execution result's status onto whichever KB scenario row is
   * linked to this test (by test_id, not by re-deriving position) — best
   * effort no-op when the test predates the KB or has no KB link (a fallback
   * row persistResults minted with no matching plan item).
   */
  updatePlanKbScenarioStatusByTestId(testId: string, status: TestStatus): void {
    this.db
      .prepare("UPDATE plan_kb_scenarios SET status = ?, updated_at = datetime('now') WHERE test_id = ?")
      .run(status, testId);
  }

  /** KB items still needing regeneration for this run. */
  listDroppedPlanKbItems(runId: string): PlanKbItem[] {
    return (
      this.db
        .prepare("SELECT * FROM plan_kb_items WHERE run_id = ? AND status = 'dropped'")
        .all(runId) as Array<Record<string, unknown>>
    ).map(rowToPlanKbItem);
  }

  /** KB scenarios that were generated but never got an execution result. */
  listPendingPlanKbScenarios(runId: string): PlanKbScenario[] {
    return (
      this.db
        .prepare("SELECT * FROM plan_kb_scenarios WHERE run_id = ? AND status = 'pending'")
        .all(runId) as Array<Record<string, unknown>>
    ).map(rowToPlanKbScenario);
  }

  /** All KB items for a run — used by the lazy backfill's "already seeded?" callers that need full rows, not just a boolean. */
  listPlanKbItems(runId: string): PlanKbItem[] {
    return (
      this.db.prepare('SELECT * FROM plan_kb_items WHERE run_id = ?').all(runId) as Array<
        Record<string, unknown>
      >
    ).map(rowToPlanKbItem);
  }

  /** All KB scenarios for a run. */
  listPlanKbScenarios(runId: string): PlanKbScenario[] {
    return (
      this.db.prepare('SELECT * FROM plan_kb_scenarios WHERE run_id = ?').all(runId) as Array<
        Record<string, unknown>
      >
    ).map(rowToPlanKbScenario);
  }

  // ---- orchestrator events (resumable checkpoints) ----
  appendEvent(
    runId: string,
    phase: string,
    message: string,
    opts: { level?: EventLevel; data?: unknown } = {},
  ): AgentEvent {
    const evt: AgentEvent = {
      id: `evt_${nanoid(10)}`,
      runId,
      phase,
      level: opts.level ?? 'info',
      message,
      dataJson: opts.data === undefined ? null : JSON.stringify(opts.data),
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        'INSERT INTO agent_events (id, run_id, phase, level, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(evt.id, evt.runId, evt.phase, evt.level, evt.message, evt.dataJson, evt.createdAt);
    return evt;
  }

  listEvents(runId: string): AgentEvent[] {
    return (
      (
        this.db
          // rowid is a monotonic insertion counter; it breaks ties when several
          // events share the same millisecond created_at, so the log never
          // reorders within a burst (created_at alone has no stable tiebreaker).
          .prepare('SELECT * FROM agent_events WHERE run_id = ? ORDER BY created_at ASC, rowid ASC')
          .all(runId) as Array<Record<string, unknown>>
      ).map(rowToEvent)
    );
  }

  /** Persist one captured provider.complete() call's token/cost usage. Never throws on a bad runId — this schema never enables `PRAGMA foreign_keys`, so the runId REFERENCES is unenforced (like every other FK here); an orphaned row is simply possible, at the caller's own risk, matching insertResult's best-effort style. */
  recordUsage(input: NewUsage): UsageRow {
    const row: UsageRow = {
      id: `usg_${nanoid(10)}`,
      runId: input.runId,
      phase: input.phase,
      task: input.task ?? null,
      provider: input.provider,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      costUsd: input.costUsd ?? null,
      cacheCreationInputTokens: input.cacheCreationInputTokens ?? null,
      cacheReadInputTokens: input.cacheReadInputTokens ?? null,
      model: input.model ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        'INSERT INTO usage (id, run_id, phase, task, provider, input_tokens, output_tokens, cost_usd, cache_creation_input_tokens, cache_read_input_tokens, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.runId,
        row.phase,
        row.task,
        row.provider,
        row.inputTokens,
        row.outputTokens,
        row.costUsd,
        row.cacheCreationInputTokens,
        row.cacheReadInputTokens,
        row.model,
        row.createdAt,
      );
    return row;
  }

  listUsageForRun(runId: string): UsageRow[] {
    return (
      this.db
        .prepare('SELECT * FROM usage WHERE run_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(runId) as Array<Record<string, unknown>>
    ).map(rowToUsage);
  }

  /**
   * Cross-run usage aggregation for the Reports/Usage page: one row per run
   * (its own total tokens/cost, newest-first) plus per-phase averages across
   * every matching run. Scoped to a project when given, else every run in the
   * store — mirrors listRuns' own (projectId?) scoping.
   */
  getUsageAggregate(opts: { projectId?: string } = {}): UsageAggregate {
    const runFilter = opts.projectId ? 'WHERE r.project_id = ?' : '';
    const params = opts.projectId ? [opts.projectId] : [];

    // rowid tiebreaker: same reasoning as listRuns/listEvents — created_at has
    // only second resolution, so two runs created within the same second (easy
    // on a fast CI runner) would otherwise sort nondeterministically.
    const perRunRows = this.db
      .prepare(
        `SELECT r.id AS run_id, r.created_at AS run_created_at,
                SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens, SUM(u.cost_usd) AS cost_usd,
                SUM(u.cache_creation_input_tokens) AS cache_creation_input_tokens, SUM(u.cache_read_input_tokens) AS cache_read_input_tokens
         FROM runs r
         LEFT JOIN usage u ON u.run_id = r.id
         ${runFilter}
         GROUP BY r.id
         ORDER BY r.created_at DESC, r.rowid DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    const perPhaseRows = this.db
      .prepare(
        `SELECT u.phase AS phase, COUNT(*) AS call_count,
                AVG(u.input_tokens) AS avg_input_tokens, AVG(u.output_tokens) AS avg_output_tokens, AVG(u.cost_usd) AS avg_cost_usd,
                SUM(u.input_tokens) AS total_input_tokens, SUM(u.output_tokens) AS total_output_tokens, SUM(u.cost_usd) AS total_cost_usd,
                AVG(u.cache_creation_input_tokens) AS avg_cache_creation_input_tokens, AVG(u.cache_read_input_tokens) AS avg_cache_read_input_tokens,
                SUM(u.cache_creation_input_tokens) AS total_cache_creation_input_tokens, SUM(u.cache_read_input_tokens) AS total_cache_read_input_tokens
         FROM usage u
         JOIN runs r ON r.id = u.run_id
         ${runFilter}
         GROUP BY u.phase
         ORDER BY u.phase ASC`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    // model IS NOT NULL: a call that reported no usage at all has model=NULL
    // (see recordUsage) — grouping on NULL would otherwise surface a bogus
    // "unknown model" row, unlike per-phase (phase is always a real string).
    const perModelRows = this.db
      .prepare(
        `SELECT u.model AS model, COUNT(*) AS call_count,
                AVG(u.input_tokens) AS avg_input_tokens, AVG(u.output_tokens) AS avg_output_tokens, AVG(u.cost_usd) AS avg_cost_usd,
                SUM(u.input_tokens) AS total_input_tokens, SUM(u.output_tokens) AS total_output_tokens, SUM(u.cost_usd) AS total_cost_usd,
                AVG(u.cache_creation_input_tokens) AS avg_cache_creation_input_tokens, AVG(u.cache_read_input_tokens) AS avg_cache_read_input_tokens,
                SUM(u.cache_creation_input_tokens) AS total_cache_creation_input_tokens, SUM(u.cache_read_input_tokens) AS total_cache_read_input_tokens
         FROM usage u
         JOIN runs r ON r.id = u.run_id
         ${runFilter ? `${runFilter} AND u.model IS NOT NULL` : 'WHERE u.model IS NOT NULL'}
         GROUP BY u.model
         ORDER BY u.model ASC`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return {
      perRun: perRunRows.map((r) => ({
        runId: String(r.run_id),
        runCreatedAt: String(r.run_created_at),
        inputTokens: n(r.input_tokens),
        outputTokens: n(r.output_tokens),
        costUsd: n(r.cost_usd),
        cacheCreationInputTokens: n(r.cache_creation_input_tokens),
        cacheReadInputTokens: n(r.cache_read_input_tokens),
      })),
      perPhase: perPhaseRows.map((r) => ({
        phase: String(r.phase),
        callCount: Number(r.call_count ?? 0),
        avgInputTokens: n(r.avg_input_tokens),
        avgOutputTokens: n(r.avg_output_tokens),
        avgCostUsd: n(r.avg_cost_usd),
        totalInputTokens: n(r.total_input_tokens),
        totalOutputTokens: n(r.total_output_tokens),
        totalCostUsd: n(r.total_cost_usd),
        avgCacheCreationInputTokens: n(r.avg_cache_creation_input_tokens),
        avgCacheReadInputTokens: n(r.avg_cache_read_input_tokens),
        totalCacheCreationInputTokens: n(r.total_cache_creation_input_tokens),
        totalCacheReadInputTokens: n(r.total_cache_read_input_tokens),
      })),
      perModel: perModelRows.map((r) => ({
        model: String(r.model),
        callCount: Number(r.call_count ?? 0),
        avgInputTokens: n(r.avg_input_tokens),
        avgOutputTokens: n(r.avg_output_tokens),
        avgCostUsd: n(r.avg_cost_usd),
        totalInputTokens: n(r.total_input_tokens),
        totalOutputTokens: n(r.total_output_tokens),
        totalCostUsd: n(r.total_cost_usd),
        avgCacheCreationInputTokens: n(r.avg_cache_creation_input_tokens),
        avgCacheReadInputTokens: n(r.avg_cache_read_input_tokens),
        totalCacheCreationInputTokens: n(r.total_cache_creation_input_tokens),
        totalCacheReadInputTokens: n(r.total_cache_read_input_tokens),
      })),
    };
  }
}

let cached: HealixStore | null = null;

/** Open the store (cached). Returns null when the runtime lacks node:sqlite. */
export async function getStore(): Promise<HealixStore | null> {
  if (cached) return cached;
  const db = await openDb();
  if (!db) return null;
  cached = new HealixStore(db);
  return cached;
}

/**
 * Test-only seam: clear the cached store and reset the underlying database so the
 * next getStore() opens a fresh store from the current HEALIX_DATA_DIR.
 */
export function resetStoreForTests(): void {
  cached = null;
  resetDbForTests();
}

function s(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function n(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function rowToProject(r: Record<string, unknown>, credentials: ProjectCredential[]): Project {
  return {
    id: String(r.id),
    name: String(r.name),
    mode: String(r.mode),
    repoPath: s(r.repo_path),
    baseUrl: s(r.base_url),
    createdAt: String(r.created_at),
    archivedAt: s(r.archived_at),
    credentials,
  };
}

function rowToCredential(r: Record<string, unknown>): ProjectCredential {
  const extraParamsRaw = s(r.extra_params);
  let extraParams: Record<string, string> | null = null;
  if (extraParamsRaw) {
    try {
      extraParams = JSON.parse(extraParamsRaw) as Record<string, string>;
    } catch {
      extraParams = null;
    }
  }
  return {
    id: String(r.id),
    authType: r.auth_type === 'url-token' ? 'url-token' : 'form',
    username: String(r.username ?? ''),
    password: decryptSecret(s(r.password)) ?? '',
    role: s(r.role),
    token: decryptSecret(s(r.token)),
    urlTemplate: s(r.url_template),
    extraParams,
    authCheckText: s(r.auth_check_text),
  };
}

function rowToRun(r: Record<string, unknown>): Run {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    status: String(r.status) as RunStatus,
    provider: s(r.provider) as Run['provider'],
    mode: s(r.mode),
    startedAt: s(r.started_at),
    finishedAt: s(r.finished_at),
    createdAt: String(r.created_at),
    suiteMode: s(r.suite_mode) as Run['suiteMode'],
    baseRunId: s(r.base_run_id),
    pauseReason: s(r.pause_reason) as Run['pauseReason'],
  };
}

function rowToTest(r: Record<string, unknown>): TestCase {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    title: String(r.title),
    reqTag: s(r.req_tag),
    tier: s(r.tier),
    status: s(r.status) as TestCase['status'],
    specPath: s(r.spec_path),
    description: s(r.description),
    details: s(r.details),
    specCode: s(r.spec_code),
  };
}

function rowToResult(r: Record<string, unknown>): TestResult {
  return {
    id: String(r.id),
    testId: String(r.test_id),
    status: String(r.status) as TestStatus,
    durationMs: n(r.duration_ms),
    error: s(r.error),
    artifactsJson: s(r.artifacts_json),
    description: s(r.description),
    details: s(r.details),
    stepsJson: s(r.steps_json),
    skipReason: s(r.skip_reason),
    videoUnavailableReason: s(r.video_unavailable_reason),
  };
}

function rowToTriageResult(r: Record<string, unknown>): TriageResultRow {
  return {
    id: String(r.id),
    testId: String(r.test_id),
    verdict: String(r.verdict) as TriageResultRow['verdict'],
    confidence: Number(r.confidence),
    rationale: String(r.rationale),
    suggestedPatch: s(r.suggested_patch),
    verdictSource: s(r.verdict_source),
    createdAt: String(r.created_at),
  };
}

function rowToPlanKbItem(r: Record<string, unknown>): PlanKbItem {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    planItemId: String(r.plan_item_id),
    title: String(r.title),
    reqTag: s(r.req_tag),
    tier: s(r.tier),
    status: String(r.status) as KbItemStatus,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToPlanKbScenario(r: Record<string, unknown>): PlanKbScenario {
  return {
    id: String(r.id),
    kbItemId: String(r.kb_item_id),
    runId: String(r.run_id),
    scenarioIndex: Number(r.scenario_index),
    kind: String(r.kind),
    description: String(r.description),
    status: String(r.status) as KbScenarioStatus,
    testId: s(r.test_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToEvent(r: Record<string, unknown>): AgentEvent {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    phase: String(r.phase),
    level: String(r.level) as EventLevel,
    message: String(r.message),
    dataJson: s(r.data_json),
    createdAt: String(r.created_at),
  };
}

function rowToUsage(r: Record<string, unknown>): UsageRow {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    phase: String(r.phase),
    task: s(r.task),
    provider: String(r.provider) as UsageRow['provider'],
    inputTokens: n(r.input_tokens),
    outputTokens: n(r.output_tokens),
    costUsd: n(r.cost_usd),
    cacheCreationInputTokens: n(r.cache_creation_input_tokens),
    cacheReadInputTokens: n(r.cache_read_input_tokens),
    model: s(r.model),
    createdAt: String(r.created_at),
  };
}
