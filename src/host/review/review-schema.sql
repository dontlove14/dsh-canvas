PRAGMA user_version=1;
CREATE TABLE IF NOT EXISTS review_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS review_profiles (
  provider TEXT PRIMARY KEY, revision INTEGER NOT NULL, activated_at INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_groups (
  id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, provider TEXT NOT NULL, scope TEXT NOT NULL,
  status TEXT NOT NULL, issued INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL, UNIQUE(canvas_id,provider,scope)
);
CREATE TABLE IF NOT EXISTS review_jobs (
  id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, asset_id TEXT NOT NULL, provider TEXT NOT NULL,
  scope TEXT NOT NULL, file_hash TEXT NOT NULL, group_key TEXT NOT NULL,
  status TEXT NOT NULL, issued INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_jobs_asset ON review_jobs(canvas_id,asset_id,provider,scope,file_hash);
CREATE INDEX IF NOT EXISTS review_jobs_due ON review_jobs(status,due);
CREATE TABLE IF NOT EXISTS review_requests (
  request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES review_jobs(id)
);
CREATE TABLE IF NOT EXISTS generation_review_bindings (
  request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, canvas_id TEXT NOT NULL,
  task_id TEXT UNIQUE, created_at INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_audit (
  id TEXT PRIMARY KEY, event TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL
);
