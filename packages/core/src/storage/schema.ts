export const SCHEMA_VERSION = 21;

/** Idempotent DDL applied on first open (and on version bumps). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'playwright',
  repo_path     TEXT,
  base_url      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at   TEXT,
  test_username TEXT,
  test_password TEXT
);

CREATE TABLE IF NOT EXISTS project_credentials (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  username        TEXT NOT NULL,
  password        TEXT,
  role            TEXT,
  auth_type       TEXT NOT NULL DEFAULT 'form',
  token           TEXT,
  url_template    TEXT,
  extra_params    TEXT,
  auth_check_text TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  status        TEXT NOT NULL DEFAULT 'pending',
  provider      TEXT,
  mode          TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  suite_mode    TEXT,
  base_run_id   TEXT REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS tests (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  title       TEXT NOT NULL,
  req_tag     TEXT,
  tier        TEXT,
  status      TEXT,
  spec_path   TEXT,
  description TEXT,
  details     TEXT,
  spec_code   TEXT
);

CREATE TABLE IF NOT EXISTS results (
  id             TEXT PRIMARY KEY,
  test_id        TEXT NOT NULL REFERENCES tests(id),
  status         TEXT NOT NULL,
  duration_ms    INTEGER,
  error          TEXT,
  artifacts_json TEXT,
  description    TEXT,
  details        TEXT,
  steps_json     TEXT,
  skip_reason    TEXT,
  video_unavailable_reason TEXT
);

CREATE TABLE IF NOT EXISTS agent_events (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  phase       TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',
  message     TEXT NOT NULL,
  data_json   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- v11: per-call token/cost usage, one row per provider.complete() call captured
-- during a run (plan, gap-fill plan, generate, triage). task is a human label
-- (e.g. a spec item's title, or 'gap-fill') scoping the row within its phase;
-- input_tokens/output_tokens/cost_usd are null when the provider (or a
-- timed-out/aborted call) reported no usage.
-- v12: cache-read/cache-creation token counts alongside the existing
-- input/output/cost columns — null when the provider reported no cache
-- activity for that call (not every call writes to or reads from the cache).
-- v13: model — the dominant modelUsage entry (by input+output tokens) that
-- actually served the call, e.g. 'claude-sonnet-5'. Null when the provider
-- reported no usage at all.
CREATE TABLE IF NOT EXISTS usage (
  id                          TEXT PRIMARY KEY,
  run_id                      TEXT NOT NULL REFERENCES runs(id),
  phase                       TEXT NOT NULL,
  task                        TEXT,
  provider                    TEXT NOT NULL,
  input_tokens                INTEGER,
  output_tokens               INTEGER,
  cost_usd                    REAL,
  cache_creation_input_tokens INTEGER,
  cache_read_input_tokens     INTEGER,
  model                       TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- v14: FK-keyed triage verdicts (one row per triaged test) alongside
-- report.json's title-joined ReportTriageEntry — additive, not a replacement.
-- Lets a later feature (Repair/Fix-up) query "which tests in this run were
-- triaged test_is_wrong" directly via test_id instead of re-deriving it from
-- report.json's fuzzy title join. tests.spec_code carries the generated
-- spec's full source alongside its row, for the same "give me everything
-- about this failed test in one lookup" reason.
CREATE TABLE IF NOT EXISTS triage_results (
  id              TEXT PRIMARY KEY,
  test_id         TEXT NOT NULL REFERENCES tests(id),
  verdict         TEXT NOT NULL,
  confidence      REAL NOT NULL,
  rationale       TEXT NOT NULL,
  suggested_patch TEXT,
  verdict_source  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- v18: two-tier Knowledge Base — one row per plan item, one child row per
-- scenario — durably tracking generation/execution status per run so
-- Retry-pass and the coverage-feedback-loop can query "what's dropped/still
-- pending" directly instead of re-diffing plan.json against tests after the
-- fact. Additive alongside plan.json (which stays the source of full
-- plan-item content) and GEN_CHECKPOINT (unrelated, untouched).
CREATE TABLE IF NOT EXISTS plan_kb_items (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  plan_item_id  TEXT NOT NULL,
  title         TEXT NOT NULL,
  req_tag       TEXT,
  tier          TEXT,
  status        TEXT NOT NULL DEFAULT 'planned',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, plan_item_id)
);

CREATE TABLE IF NOT EXISTS plan_kb_scenarios (
  id             TEXT PRIMARY KEY,
  kb_item_id     TEXT NOT NULL REFERENCES plan_kb_items(id),
  run_id         TEXT NOT NULL REFERENCES runs(id),
  scenario_index INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  description    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'planned',
  test_id        TEXT REFERENCES tests(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kb_item_id, scenario_index)
);

-- v19: kb_test_scripts — one row per Knowledge Base item with known source
-- grounding, recording the real file path where that functionality's actual
-- implementation lives (white-box projects only, resolved from the plan
-- item's unitKey against the run's FunctionalityUnit/SourceContext; a plan
-- item with no unitKey or no matching unit — black-box projects, or a
-- unit-less item — simply has no row here). Lets a later feature look up
-- "which source file backs this functionality" directly via kb_item_id
-- instead of re-deriving it from SourceContext each time.
CREATE TABLE IF NOT EXISTS kb_test_scripts (
  id          TEXT PRIMARY KEY,
  kb_item_id  TEXT NOT NULL UNIQUE REFERENCES plan_kb_items(id),
  run_id      TEXT NOT NULL REFERENCES runs(id),
  file_path   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- v20: kb_execution_artifacts — exactly one row per plan_kb_scenarios row,
-- seeded at the same time (all fields null) and filled in once that
-- scenario's execution result lands. error_message/trace_path stay null for
-- anything that isn't a failure; execution_steps is populated for both
-- passed and failed results (mirrors results.steps_json's own convention).
-- network_logs has no capture source yet anywhere in the pipeline — the
-- column exists for the requested shape, but is always null today.
CREATE TABLE IF NOT EXISTS kb_execution_artifacts (
  id               TEXT PRIMARY KEY,
  kb_scenario_id   TEXT NOT NULL UNIQUE REFERENCES plan_kb_scenarios(id),
  run_id           TEXT NOT NULL REFERENCES runs(id),
  error_message    TEXT,
  trace_path       TEXT,
  execution_steps  TEXT,
  network_logs     TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- v21: KB foundation — persisting plan/mock/exploration/execution evidence
-- for downstream features (requirement-traceability, richer triage, directed
-- re-exploration). See docs/design/kb-foundation-evidence-persistence.md.
-- Schema + write points only — no behavior changes to any existing reader
-- (Retry-pass, the coverage loop, Repair, Top-up, Triage all keep reading
-- exactly what they read today).

-- Canonical dedup of reqTag per run — makes
-- requirements ⋈ plan_kb_items ⋈ plan_kb_scenarios ⋈ tests ⋈ results a
-- direct traceability-matrix query with no new join logic.
CREATE TABLE IF NOT EXISTS requirements (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  tag         TEXT NOT NULL,
  description TEXT,
  source      TEXT NOT NULL DEFAULT 'plan',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_requirements_run ON requirements(run_id);

-- One row per (dependency, method, path) mock target. mock_* columns are
-- populated at generation time from the same data already embedded into
-- fixtures/mock.fixture.ts. observed_* columns are populated AFTER execution
-- with the response the mock fixture ACTUALLY served for that (dependency,
-- method, path) tuple (grounded from the fixture's own write-through hit
-- log, which now carries the matched endpoint's own method/pathPattern —
-- see execute.ts's readObservedMockResponses) — deliberately NOT a
-- comparison against a genuinely different real backend, since tests run
-- fully offline against this same fixture and there is no live upstream to
-- compare against. Resolved to the EXACT row via that tuple, so a
-- dependency with multiple statically-detected endpoints gets each one
-- grounded independently, not conflated into a single row.
CREATE TABLE IF NOT EXISTS mock_responses (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL REFERENCES runs(id),
  dependency_id          TEXT NOT NULL,
  category               TEXT NOT NULL,
  method                 TEXT,
  path_pattern           TEXT,
  mock_strategy          TEXT NOT NULL,
  mock_status            INTEGER,
  mock_body_json         TEXT,
  mock_headers_json      TEXT,
  observed_status        INTEGER,
  observed_body_json     TEXT,
  observed_headers_json  TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, dependency_id, method, path_pattern)
);
CREATE INDEX IF NOT EXISTS idx_mock_responses_run ON mock_responses(run_id);

-- Per-test mock usage, from ExecOutcome.mockedRequestCountsByTest (see its own doc
-- comment in modes/types.ts — distinct from mockedRequestCounts, the pre-existing
-- run-level aggregate, which stays unchanged). Tallied per EXACT (dependency,
-- method, pathPattern) tuple and resolved to that specific mock_responses row, so a
-- dependency with multiple statically-detected endpoints gets each one's usage
-- counted independently rather than conflated into (or overstating) a single row.
CREATE TABLE IF NOT EXISTS test_mock_usage (
  test_id           TEXT NOT NULL REFERENCES tests(id),
  mock_response_id  TEXT NOT NULL REFERENCES mock_responses(id),
  request_count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (test_id, mock_response_id)
);
CREATE INDEX IF NOT EXISTS idx_test_mock_usage_mock ON test_mock_usage(mock_response_id);

-- Per-run, per-route exploration index (summary, not the full raw crawl —
-- exploration-cache.json's file cache stays the source of truth for that,
-- unchanged). Written once EXPLORE (and any gap-fill pass) finishes,
-- regardless of whether this run hit the cache or crawled fresh.
CREATE TABLE IF NOT EXISTS exploration_summaries (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(id),
  route              TEXT NOT NULL,
  selectors_json     TEXT,
  forms_json         TEXT,
  auth_pattern       TEXT,
  state_probe_count  INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, route)
);
CREATE INDEX IF NOT EXISTS idx_exploration_summaries_run ON exploration_summaries(run_id);

-- Durable escape-hatch (fixMe) gap history, from generate.ts's
-- extractEscapeHatchReasons — one row per plan item with at least one
-- unobserved-element marker left in its generated spec. status/iteration
-- are written by (and only meaningful once there is) a directed
-- re-exploration loop, which is not yet implemented — every row lands here
-- as 'open'/iteration 0 until that loop exists to update them.
CREATE TABLE IF NOT EXISTS escape_hatch_gaps (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  plan_item_id  TEXT NOT NULL,
  unit_key      TEXT,
  reasons_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  iteration     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_escape_hatch_gaps_run ON escape_hatch_gaps(run_id);

CREATE INDEX IF NOT EXISTS idx_credentials_project ON project_credentials(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_tests_run ON tests(run_id);
CREATE INDEX IF NOT EXISTS idx_results_test ON results(test_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);
CREATE INDEX IF NOT EXISTS idx_triage_results_test ON triage_results(test_id);
CREATE INDEX IF NOT EXISTS idx_plan_kb_items_run ON plan_kb_items(run_id);
CREATE INDEX IF NOT EXISTS idx_plan_kb_scenarios_kb_item ON plan_kb_scenarios(kb_item_id);
CREATE INDEX IF NOT EXISTS idx_plan_kb_scenarios_run ON plan_kb_scenarios(run_id);
CREATE INDEX IF NOT EXISTS idx_plan_kb_scenarios_test ON plan_kb_scenarios(test_id);
CREATE INDEX IF NOT EXISTS idx_kb_test_scripts_run ON kb_test_scripts(run_id);
CREATE INDEX IF NOT EXISTS idx_kb_execution_artifacts_run ON kb_execution_artifacts(run_id);
`;
