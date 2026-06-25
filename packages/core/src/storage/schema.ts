export const SCHEMA_VERSION = 2;

/** Idempotent DDL applied on first open (and on version bumps). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'playwright',
  repo_path   TEXT,
  base_url    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  status      TEXT NOT NULL DEFAULT 'pending',
  provider    TEXT,
  mode        TEXT,
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tests (
  id       TEXT PRIMARY KEY,
  run_id   TEXT NOT NULL REFERENCES runs(id),
  title    TEXT NOT NULL,
  req_tag  TEXT,
  tier     TEXT,
  status   TEXT
);

CREATE TABLE IF NOT EXISTS results (
  id             TEXT PRIMARY KEY,
  test_id        TEXT NOT NULL REFERENCES tests(id),
  status         TEXT NOT NULL,
  duration_ms    INTEGER,
  error          TEXT,
  artifacts_json TEXT
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

CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_tests_run ON tests(run_id);
CREATE INDEX IF NOT EXISTS idx_results_test ON results(test_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id);
`;
