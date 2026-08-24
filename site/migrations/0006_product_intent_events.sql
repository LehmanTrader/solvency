-- Minimal first-party product-intent measurements. The closed event enum and
-- narrow column set prevent plan, harness, model, price, threshold, URL and
-- request-body data from entering this table.
CREATE TABLE product_intent_events (
  owner_user_id TEXT NOT NULL
    CHECK (length(owner_user_id) BETWEEN 8 AND 128),
  event_id TEXT NOT NULL
    CHECK (
      length(event_id) = 36
      AND event_id GLOB '????????-????-4???-[89ab]???-????????????'
      AND event_id NOT GLOB '*[^0-9a-f-]*'
      AND length(replace(event_id, '-', '')) = 32
    ),
  event_name TEXT NOT NULL
    CHECK (event_name IN (
      'planner_started',
      'valid_quote_created',
      'account_plan_saved',
      'export_downloaded',
      'share_created',
      'alert_setting_saved',
      'pro_price_interest'
    )),
  signal_version INTEGER NOT NULL DEFAULT 1
    CHECK (signal_version = 1),
  price_experiment_id TEXT NOT NULL DEFAULT 'pro_19_monthly_190_annual_v1'
    CHECK (price_experiment_id IN ('pro_19_monthly_190_annual_v1')),
  recorded_at INTEGER NOT NULL
    CHECK (recorded_at BETWEEN 0 AND 253402300799),
  expires_at INTEGER NOT NULL
    CHECK (expires_at = recorded_at + 7776000),
  PRIMARY KEY (owner_user_id, event_id),
  UNIQUE (owner_user_id, event_name, signal_version, price_experiment_id)
);

CREATE INDEX product_intent_events_expiry
  ON product_intent_events (expires_at, owner_user_id);

-- Rows are append-only while retained. Deletion remains available for expiry
-- pruning and verified account erasure.
CREATE TRIGGER product_intent_events_no_update
BEFORE UPDATE ON product_intent_events
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_PRODUCT_INTENT');
END;

CREATE TRIGGER product_intent_events_owner_retention_and_quota
BEFORE INSERT ON product_intent_events
BEGIN
  DELETE FROM product_intent_events
   WHERE owner_user_id = NEW.owner_user_id
     AND expires_at <= NEW.recorded_at;

  SELECT CASE WHEN (
    SELECT COUNT(*) FROM product_intent_events
     WHERE owner_user_id = NEW.owner_user_id
       AND expires_at > NEW.recorded_at
  ) >= 512 THEN RAISE(ABORT, 'OWNER_PRODUCT_INTENT_LIMIT') END;
END;
