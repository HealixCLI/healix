export const SCHEMA_VERSION = 13;

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
  details     TEXT
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
  steps_json     TEXT
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

CREATE INDEX IF NOT EXISTS idx_credentials_project ON project_credentials(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_tests_run ON tests(run_id);
CREATE INDEX IF NOT EXISTS idx_results_test ON results(test_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);
`;
