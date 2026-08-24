-- Durable, owner-managed unlisted links for immutable server-quoted versions.
-- The bearer token itself is never stored; token_hash is SHA-256(token).
CREATE TABLE build_plan_shares (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (id GLOB 'share_????????-????-4???-[89ab]???-????????????'),
  owner_user_id TEXT NOT NULL
    CHECK (length(owner_user_id) BETWEEN 8 AND 128),
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL
    CHECK (version BETWEEN 1 AND 100),
  token_hash TEXT UNIQUE NOT NULL
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  allow_quote_export INTEGER NOT NULL
    CHECK (allow_quote_export IN (0, 1)),
  expires_at TEXT
    CHECK (expires_at IS NULL OR length(expires_at) = 24),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24),
  FOREIGN KEY (plan_id, version)
    REFERENCES build_plan_versions(plan_id, version)
    ON DELETE CASCADE,
  UNIQUE (owner_user_id, plan_id, version)
);

CREATE INDEX build_plan_shares_owner_plan
  ON build_plan_shares (owner_user_id, plan_id, created_at DESC, id DESC);

CREATE TRIGGER build_plan_shares_owned_version
BEFORE INSERT ON build_plan_shares
WHEN NOT EXISTS (
  SELECT 1
    FROM build_plans p
    JOIN build_plan_versions v ON v.plan_id = p.id
   WHERE p.id = NEW.plan_id
     AND p.owner_user_id = NEW.owner_user_id
     AND v.version = NEW.version
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_SHARE_VERSION');
END;

CREATE TRIGGER build_plan_shares_owner_quota
BEFORE INSERT ON build_plan_shares
WHEN (SELECT COUNT(*) FROM build_plan_shares WHERE owner_user_id = NEW.owner_user_id) >= 100
BEGIN
  SELECT RAISE(ABORT, 'OWNER_SHARE_LIMIT');
END;

CREATE TRIGGER build_plan_shares_plan_quota
BEFORE INSERT ON build_plan_shares
WHEN (SELECT COUNT(*) FROM build_plan_shares WHERE plan_id = NEW.plan_id) >= 20
BEGIN
  SELECT RAISE(ABORT, 'PLAN_SHARE_LIMIT');
END;

-- Share policy and token hashes are immutable. Revocation is an owner-qualified
-- delete, and plan deletion cascades through the immutable version foreign key.
CREATE TRIGGER build_plan_shares_no_update
BEFORE UPDATE ON build_plan_shares
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_SHARE');
END;

-- Durable settings only. Every row is explicitly inactive: this schema cannot
-- claim that a monitor ran or that an email/message was delivered.
CREATE TABLE build_plan_alert_settings (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (id GLOB 'alert_????????-????-4???-[89ab]???-????????????'),
  owner_user_id TEXT NOT NULL
    CHECK (length(owner_user_id) BETWEEN 8 AND 128),
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL
    CHECK (version BETWEEN 1 AND 100),
  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN (
      'model_price_change',
      'monthly_spend_above',
      'monthly_spend_change_percent',
      'baseline_delta_percent'
    )),
  threshold REAL,
  baseline_version INTEGER
    CHECK (baseline_version IS NULL OR baseline_version BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'inactive'
    CHECK (status = 'inactive'),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24),
  FOREIGN KEY (plan_id, version)
    REFERENCES build_plan_versions(plan_id, version)
    ON DELETE CASCADE,
  FOREIGN KEY (plan_id, baseline_version)
    REFERENCES build_plan_versions(plan_id, version)
    ON DELETE CASCADE,
  CHECK (
    (trigger_type = 'model_price_change'
      AND threshold IS NULL AND baseline_version IS NULL)
    OR
    (trigger_type IN ('monthly_spend_above', 'monthly_spend_change_percent')
      AND threshold > 0 AND threshold <= 1000000000
      AND baseline_version IS NULL)
    OR
    (trigger_type = 'baseline_delta_percent'
      AND threshold > 0 AND threshold <= 1000000000
      AND baseline_version IS NOT NULL AND baseline_version <> version)
  )
);

CREATE INDEX build_plan_alert_settings_owner_plan
  ON build_plan_alert_settings (owner_user_id, plan_id, updated_at DESC, id DESC);

-- COALESCE uses sentinels outside the valid threshold/version domains so exact
-- duplicate settings cannot be inserted even when nullable columns are used.
CREATE UNIQUE INDEX build_plan_alert_settings_no_duplicates
  ON build_plan_alert_settings (
    owner_user_id, plan_id, version, trigger_type,
    COALESCE(threshold, -1), COALESCE(baseline_version, 0)
  );

CREATE TRIGGER build_plan_alert_settings_owned_versions_insert
BEFORE INSERT ON build_plan_alert_settings
WHEN NOT EXISTS (
  SELECT 1
    FROM build_plans p
    JOIN build_plan_versions v ON v.plan_id = p.id
   WHERE p.id = NEW.plan_id
     AND p.owner_user_id = NEW.owner_user_id
     AND v.version = NEW.version
     AND (
       NEW.baseline_version IS NULL
       OR EXISTS (
         SELECT 1 FROM build_plan_versions b
          WHERE b.plan_id = NEW.plan_id AND b.version = NEW.baseline_version
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ALERT_VERSION');
END;

CREATE TRIGGER build_plan_alert_settings_owned_versions_update
BEFORE UPDATE ON build_plan_alert_settings
WHEN NOT EXISTS (
  SELECT 1
    FROM build_plans p
    JOIN build_plan_versions v ON v.plan_id = p.id
   WHERE p.id = NEW.plan_id
     AND p.owner_user_id = NEW.owner_user_id
     AND v.version = NEW.version
     AND (
       NEW.baseline_version IS NULL
       OR EXISTS (
         SELECT 1 FROM build_plan_versions b
          WHERE b.plan_id = NEW.plan_id AND b.version = NEW.baseline_version
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ALERT_VERSION');
END;

CREATE TRIGGER build_plan_alert_settings_owner_quota
BEFORE INSERT ON build_plan_alert_settings
WHEN (SELECT COUNT(*) FROM build_plan_alert_settings WHERE owner_user_id = NEW.owner_user_id) >= 100
BEGIN
  SELECT RAISE(ABORT, 'OWNER_ALERT_LIMIT');
END;

CREATE TRIGGER build_plan_alert_settings_plan_quota
BEFORE INSERT ON build_plan_alert_settings
WHEN (SELECT COUNT(*) FROM build_plan_alert_settings WHERE plan_id = NEW.plan_id) >= 20
BEGIN
  SELECT RAISE(ABORT, 'PLAN_ALERT_LIMIT');
END;

CREATE TRIGGER build_plan_alert_settings_identity_immutable
BEFORE UPDATE ON build_plan_alert_settings
WHEN NEW.id <> OLD.id
  OR NEW.owner_user_id <> OLD.owner_user_id
  OR NEW.plan_id <> OLD.plan_id
  OR NEW.status <> 'inactive'
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_ALERT_IDENTITY');
END;

-- A compact owner-scoped ledger makes create/update/revoke/delete retries safe.
-- It never stores bearer tokens, request bodies, plan JSON, quotes or identity
-- beyond the verified Clerk owner ID already used by account plans.
CREATE TABLE build_plan_operation_requests (
  owner_user_id TEXT NOT NULL
    CHECK (length(owner_user_id) BETWEEN 8 AND 128),
  operation TEXT NOT NULL
    CHECK (length(operation) BETWEEN 8 AND 96),
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  plan_id TEXT NOT NULL,
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('share', 'alert')),
  resource_id TEXT NOT NULL
    CHECK (length(resource_id) BETWEEN 8 AND 64),
  result_kind TEXT NOT NULL
    CHECK (result_kind IN ('created', 'updated', 'revoked', 'deleted')),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24),
  expires_at TEXT NOT NULL
    CHECK (length(expires_at) = 24 AND expires_at > created_at),
  PRIMARY KEY (owner_user_id, operation, idempotency_key),
  FOREIGN KEY (plan_id) REFERENCES build_plans(id) ON DELETE CASCADE
);

CREATE INDEX build_plan_operation_requests_owner_expiry
  ON build_plan_operation_requests (owner_user_id, expires_at);

CREATE TRIGGER build_plan_operation_requests_owned_plan
BEFORE INSERT ON build_plan_operation_requests
WHEN NOT EXISTS (
  SELECT 1 FROM build_plans p
   WHERE p.id = NEW.plan_id AND p.owner_user_id = NEW.owner_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_OPERATION_OWNER');
END;

CREATE TRIGGER build_plan_operation_requests_owner_quota
BEFORE INSERT ON build_plan_operation_requests
BEGIN
  -- Idempotency is guaranteed for 24 hours by the store. Pruning on the next
  -- mutation prevents a long-lived legitimate account from exhausting this
  -- table permanently while the hard cap still fails closed under bursts.
  DELETE FROM build_plan_operation_requests
   WHERE owner_user_id = NEW.owner_user_id AND expires_at <= NEW.created_at;

  SELECT (CASE WHEN (
    SELECT COUNT(*) FROM build_plan_operation_requests
     WHERE owner_user_id = NEW.owner_user_id
  ) >= 4096 THEN RAISE(ABORT, 'OWNER_OPERATION_LIMIT') END);
END;
