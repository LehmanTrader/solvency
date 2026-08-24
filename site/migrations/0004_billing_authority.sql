-- Server-owned mapping created by authenticated checkout code. Webhook payload
-- metadata must never be able to move a provider customer between Clerk owners.
CREATE TABLE billing_customers (
  owner_user_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(owner_user_id) BETWEEN 8 AND 128),
  provider_customer_id TEXT UNIQUE NOT NULL
    CHECK (length(provider_customer_id) BETWEEN 8 AND 128),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24),
  UNIQUE (owner_user_id, provider_customer_id)
);

-- One current v1 subscription per owner. Entitlement is derived from this
-- server-owned row, never from Clerk metadata, redirect parameters or the UI.
CREATE TABLE billing_subscriptions (
  owner_user_id TEXT PRIMARY KEY NOT NULL,
  provider_customer_id TEXT UNIQUE NOT NULL,
  provider_subscription_id TEXT UNIQUE NOT NULL
    CHECK (length(provider_subscription_id) BETWEEN 8 AND 128),
  -- A NULL group means the signed event had no single, fully normalized price
  -- item (absent, malformed or mixed). It can never grant an entitlement.
  provider_price_id TEXT,
  provider_price_quantity INTEGER,
  provider_price_currency TEXT,
  provider_price_interval TEXT,
  status TEXT NOT NULL
    CHECK (status IN (
      'trialing', 'active', 'past_due', 'paused', 'unpaid',
      'incomplete', 'incomplete_expired', 'canceled'
    )),
  current_period_end INTEGER NOT NULL
    CHECK (current_period_end >= 0),
  cancel_at_period_end INTEGER NOT NULL
    CHECK (cancel_at_period_end IN (0, 1)),
  last_event_created INTEGER NOT NULL
    CHECK (last_event_created >= 0),
  last_event_id TEXT NOT NULL
    CHECK (length(last_event_id) BETWEEN 8 AND 128),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24),
  CHECK (
    (
      provider_price_id IS NULL
      AND provider_price_quantity IS NULL
      AND provider_price_currency IS NULL
      AND provider_price_interval IS NULL
    )
    OR (
      provider_price_id IS NOT NULL
      AND provider_price_quantity IS NOT NULL
      AND provider_price_currency IS NOT NULL
      AND provider_price_interval IS NOT NULL
      AND length(provider_price_id) BETWEEN 10 AND 128
      AND substr(provider_price_id, 1, 6) = 'price_'
      AND substr(provider_price_id, 7) NOT GLOB '*[^A-Za-z0-9]*'
      AND provider_price_quantity BETWEEN 1 AND 1000000
      AND length(provider_price_currency) = 3
      AND provider_price_currency NOT GLOB '*[^a-z]*'
      AND provider_price_interval IN ('month', 'year')
    )
  ),
  FOREIGN KEY (owner_user_id, provider_customer_id)
    REFERENCES billing_customers(owner_user_id, provider_customer_id)
    ON DELETE CASCADE
);

-- Store only the normalized fields needed for replay protection and state
-- reduction, plus a hash of the signed raw event. Raw billing payloads are not
-- retained. Old rows are pruned during later verified event application.
CREATE TABLE billing_events (
  provider_event_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(provider_event_id) BETWEEN 8 AND 128),
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64),
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted'
    )),
  owner_user_id TEXT NOT NULL,
  provider_customer_id TEXT NOT NULL,
  provider_subscription_id TEXT NOT NULL
    CHECK (length(provider_subscription_id) BETWEEN 8 AND 128),
  provider_price_id TEXT,
  provider_price_quantity INTEGER,
  provider_price_currency TEXT,
  provider_price_interval TEXT,
  subscription_status TEXT NOT NULL
    CHECK (subscription_status IN (
      'trialing', 'active', 'past_due', 'paused', 'unpaid',
      'incomplete', 'incomplete_expired', 'canceled'
    )),
  current_period_end INTEGER NOT NULL
    CHECK (current_period_end >= 0),
  cancel_at_period_end INTEGER NOT NULL
    CHECK (cancel_at_period_end IN (0, 1)),
  event_created INTEGER NOT NULL
    CHECK (event_created >= 0),
  received_at INTEGER NOT NULL
    CHECK (received_at >= 0),
  CHECK (
    (
      provider_price_id IS NULL
      AND provider_price_quantity IS NULL
      AND provider_price_currency IS NULL
      AND provider_price_interval IS NULL
    )
    OR (
      provider_price_id IS NOT NULL
      AND provider_price_quantity IS NOT NULL
      AND provider_price_currency IS NOT NULL
      AND provider_price_interval IS NOT NULL
      AND length(provider_price_id) BETWEEN 10 AND 128
      AND substr(provider_price_id, 1, 6) = 'price_'
      AND substr(provider_price_id, 7) NOT GLOB '*[^A-Za-z0-9]*'
      AND provider_price_quantity BETWEEN 1 AND 1000000
      AND length(provider_price_currency) = 3
      AND provider_price_currency NOT GLOB '*[^a-z]*'
      AND provider_price_interval IN ('month', 'year')
    )
  ),
  CHECK (
    event_type <> 'customer.subscription.deleted'
    OR subscription_status = 'canceled'
  ),
  FOREIGN KEY (owner_user_id, provider_customer_id)
    REFERENCES billing_customers(owner_user_id, provider_customer_id)
    ON DELETE CASCADE
);

CREATE INDEX billing_events_received
  ON billing_events (received_at);

-- Never commit a processed-event marker for an identity transition that the
-- current subscription row would reject. This keeps retries visibly failed
-- instead of turning the second delivery into a false successful replay.
CREATE TRIGGER billing_events_identity_guard
BEFORE INSERT ON billing_events
WHEN EXISTS (
  SELECT 1
    FROM billing_subscriptions s
   WHERE s.owner_user_id = NEW.owner_user_id
     AND (
       s.provider_customer_id <> NEW.provider_customer_id
       OR (
         s.provider_subscription_id <> NEW.provider_subscription_id
         AND s.status NOT IN ('unpaid', 'incomplete_expired', 'canceled')
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'BILLING_IDENTITY_CONFLICT');
END;

CREATE TRIGGER billing_events_no_update
BEFORE UPDATE ON billing_events
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_BILLING_EVENT');
END;
