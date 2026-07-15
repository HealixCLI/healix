import { nanoid } from 'nanoid';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, resetDbForTests } from './db.js';
import { validateNewProject } from './validate.js';
import type {
  AgentEvent,
  EventLevel,
  NewProject,
  Project,
  Run,
  RunStatus,
  TestCase,
  TestResult,
  TestStatus,
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
    const { name, mode, repoPath, baseUrl, testUsername, testPassword } = validation.value;
    this.assertNameAvailable(name);
    const project: Project = {
      id: `prj_${nanoid(10)}`,
      name,
      mode,
      repoPath,
      baseUrl,
      createdAt: new Date().toISOString(),
      archivedAt: null,
      testUsername,
      testPassword,
    };
    this.db
      .prepare(
        'INSERT INTO projects (id, name, mode, repo_path, base_url, created_at, test_username, test_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        project.id,
        project.name,
        project.mode,
        project.repoPath,
        project.baseUrl,
        project.createdAt,
        project.testUsername,
        project.testPassword,
      );
    return project;
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
    const { name, mode, repoPath, baseUrl, testUsername, testPassword } = validation.value;
    this.assertNameAvailable(name, id);
    this.db
      .prepare(
        'UPDATE projects SET name = ?, mode = ?, repo_path = ?, base_url = ?, test_username = ?, test_password = ? WHERE id = ?',
      )
      .run(name, mode, repoPath, baseUrl, testUsername, testPassword, id);
    return { ...existing, name, mode, repoPath, baseUrl, testUsername, testPassword };
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
    ).map(rowToProject);
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToProject(row) : null;
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
      // 2. agent_events of runs of this project
      this.db
        .prepare('DELETE FROM agent_events WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)')
        .run(id);
      // 3. tests of runs of this project
      this.db.prepare('DELETE FROM tests WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)').run(id);
      // 4. runs of this project
      this.db.prepare('DELETE FROM runs WHERE project_id = ?').run(id);
      // 5. the project row itself
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
  createRun(projectId: string, opts: { provider?: string | null; mode?: string | null } = {}): Run {
    const run: Run = {
      id: `run_${nanoid(10)}`,
      projectId,
      status: 'pending',
      provider: (opts.provider ?? null) as Run['provider'],
      mode: opts.mode ?? null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        'INSERT INTO runs (id, project_id, status, provider, mode, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
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
      );
    return run;
  }

  /**
   * Janitor for runs orphaned by a crash/quit mid-pipeline: any run still in a
   * non-terminal status whose row is older than `olderThanMs` (default 6h) is
   * marked 'error' with a finishedAt stamp. The age threshold exists because a
   * run may legitimately be in flight in ANOTHER process (CLI vs desktop) — we
   * only reap runs old enough that no real pipeline could still be driving them.
   * Returns the number of runs reaped.
   */
  failOrphanedRuns(opts: { olderThanMs?: number } = {}): number {
    const olderThanMs = opts.olderThanMs ?? 6 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE runs SET status = 'error', finished_at = ?
         WHERE status NOT IN ('passed', 'failed', 'blocked', 'error', 'cancelled') AND created_at < ?`,
      )
      .run(new Date().toISOString(), cutoff);
    return Number(result.changes ?? 0);
  }

  updateRunStatus(
    id: string,
    status: RunStatus,
    patch: { startedAt?: string; finishedAt?: string } = {},
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
    values.push(id);
    this.db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
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
      // 2. agent_events of this run
      this.db.prepare('DELETE FROM agent_events WHERE run_id = ?').run(id);
      // 3. tests of this run
      this.db.prepare('DELETE FROM tests WHERE run_id = ?').run(id);
      // 4. the run row itself
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
  insertTest(test: Omit<TestCase, 'id'> & { id?: string }): TestCase {
    const full: TestCase = { ...test, id: test.id ?? `tst_${nanoid(10)}` };
    this.db
      .prepare('INSERT INTO tests (id, run_id, title, req_tag, tier, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(full.id, full.runId, full.title, full.reqTag, full.tier, full.status);
    return full;
  }

  /** Reflect an execution outcome back onto the test row (inserted as 'pending' in GENERATE). */
  updateTestStatus(id: string, status: TestStatus): void {
    this.db.prepare('UPDATE tests SET status = ? WHERE id = ?').run(status, id);
  }

  insertResult(result: Omit<TestResult, 'id'> & { id?: string }): TestResult {
    const full: TestResult = { ...result, id: result.id ?? `res_${nanoid(10)}` };
    this.db
      .prepare(
        'INSERT INTO results (id, test_id, status, duration_ms, error, artifacts_json) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(full.id, full.testId, full.status, full.durationMs, full.error, full.artifactsJson);
    return full;
  }

  listTests(runId: string): TestCase[] {
    return (
      this.db.prepare('SELECT * FROM tests WHERE run_id = ?').all(runId) as Array<Record<string, unknown>>
    ).map(rowToTest);
  }

  /** All result rows for a run, joined through tests (results have no run_id of their own). */
  listResults(runId: string): TestResult[] {
    return (
      this.db
        .prepare('SELECT r.* FROM results r JOIN tests t ON r.test_id = t.id WHERE t.run_id = ?')
        .all(runId) as Array<Record<string, unknown>>
    ).map(rowToResult);
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

function rowToProject(r: Record<string, unknown>): Project {
  return {
    id: String(r.id),
    name: String(r.name),
    mode: String(r.mode),
    repoPath: s(r.repo_path),
    baseUrl: s(r.base_url),
    createdAt: String(r.created_at),
    archivedAt: s(r.archived_at),
    testUsername: s(r.test_username),
    testPassword: s(r.test_password),
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
