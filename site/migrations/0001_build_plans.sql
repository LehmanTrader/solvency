PRAGMA foreign_keys = ON;

CREATE TABLE build_plans (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 8 AND 64),
  owner_user_id TEXT NOT NULL
    CHECK (length(owner_user_id) BETWEEN 8 AND 128),
  display_name TEXT NOT NULL
    CHECK (length(display_name) BETWEEN 1 AND 160),
  current_version INTEGER NOT NULL DEFAULT 0
    CHECK (current_version BETWEEN 0 AND 100),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24)
);

CREATE INDEX build_plans_owner_updated
  ON build_plans (owner_user_id, updated_at DESC, id DESC);

CREATE TABLE build_plan_versions (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 8 AND 64),
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL
    CHECK (version BETWEEN 1 AND 100),
  plan_name TEXT NOT NULL
    CHECK (length(plan_name) BETWEEN 1 AND 160),
  plan_schema_version INTEGER NOT NULL
    CHECK (plan_schema_version = 1),
  quote_engine_version TEXT NOT NULL
    CHECK (quote_engine_version = 'build-cost-v1'),
  plan_json TEXT NOT NULL,
  quote_json TEXT NOT NULL,
  quoted_at TEXT NOT NULL
    CHECK (length(quoted_at) = 24),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24),
  FOREIGN KEY (plan_id) REFERENCES build_plans(id) ON DELETE CASCADE,
  UNIQUE (plan_id, version)
);

CREATE INDEX build_plan_versions_plan_version
  ON build_plan_versions (plan_id, version DESC);

-- Idempotency is owner-scoped. The request hash prevents a caller from reusing
-- a key for different content while allowing a timed-out request to be safely
-- replayed without creating another plan or version.
CREATE TABLE build_plan_requests (
  owner_user_id TEXT NOT NULL
    CHECK (length(owner_user_id) BETWEEN 8 AND 128),
  operation TEXT NOT NULL
    CHECK (length(operation) BETWEEN 1 AND 96),
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64),
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL
    CHECK (version BETWEEN 1 AND 100),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24),
  PRIMARY KEY (owner_user_id, operation, idempotency_key),
  FOREIGN KEY (plan_id) REFERENCES build_plans(id) ON DELETE CASCADE
);

-- Version allocation and parent advancement are one SQLite statement. If the
-- parent is not exactly one version behind, the insert aborts and rolls back.
CREATE TRIGGER build_plan_versions_advance
AFTER INSERT ON build_plan_versions
BEGIN
  UPDATE build_plans
     SET current_version = NEW.version,
         display_name = NEW.plan_name,
         updated_at = NEW.created_at
   WHERE id = NEW.plan_id
     AND current_version = NEW.version - 1;

  SELECT (CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'VERSION_CONFLICT')
  END);
END;

-- Saved versions and their quote snapshots are append-only while their plan
-- exists. Whole-plan deletion is the only supported removal path and cascades.
CREATE TRIGGER build_plan_versions_no_update
BEFORE UPDATE ON build_plan_versions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION');
END;
