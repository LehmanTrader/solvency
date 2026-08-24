-- One owner-scoped durable generation prevents concurrent workers from creating
-- multiple live Checkout Sessions. The hosted URL is deliberately not stored;
-- a ready attempt is replayed through Stripe with the same generation-derived
-- idempotency input. Expired receipts must pass exact-session reconciliation
-- under a separate short CAS lease before a new generation can be created.
CREATE TABLE billing_checkout_attempts (
  owner_user_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(owner_user_id) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  lease_token TEXT NOT NULL
    CHECK (
      length(lease_token) = 36
      AND substr(lease_token, 9, 1) = '-'
      AND substr(lease_token, 14, 1) = '-'
      AND substr(lease_token, 19, 1) = '-'
      AND substr(lease_token, 24, 1) = '-'
      AND substr(lease_token, 15, 1) = '4'
      AND substr(lease_token, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(lease_token, 1, 8) NOT GLOB '*[^0-9a-f]*'
      AND substr(lease_token, 10, 4) NOT GLOB '*[^0-9a-f]*'
      AND substr(lease_token, 15, 4) NOT GLOB '*[^0-9a-f]*'
      AND substr(lease_token, 20, 4) NOT GLOB '*[^0-9a-f]*'
      AND substr(lease_token, 25, 12) NOT GLOB '*[^0-9a-f]*'
    ),
  reconciliation_token TEXT
    CHECK (
      reconciliation_token IS NULL
      OR (
        length(reconciliation_token) = 36
        AND substr(reconciliation_token, 9, 1) = '-'
        AND substr(reconciliation_token, 14, 1) = '-'
        AND substr(reconciliation_token, 19, 1) = '-'
        AND substr(reconciliation_token, 24, 1) = '-'
        AND substr(reconciliation_token, 15, 1) = '4'
        AND substr(reconciliation_token, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(reconciliation_token, 1, 8) NOT GLOB '*[^0-9a-f]*'
        AND substr(reconciliation_token, 10, 4) NOT GLOB '*[^0-9a-f]*'
        AND substr(reconciliation_token, 15, 4) NOT GLOB '*[^0-9a-f]*'
        AND substr(reconciliation_token, 20, 4) NOT GLOB '*[^0-9a-f]*'
        AND substr(reconciliation_token, 25, 12) NOT GLOB '*[^0-9a-f]*'
      )
    ),
  state TEXT NOT NULL
    CHECK (state IN (
      'creating',
      'ready',
      'reconciling',
      'completed_pending_webhook',
      'manual_review'
    )),
  provider_session_id TEXT UNIQUE
    CHECK (
      provider_session_id IS NULL
      OR (
        length(provider_session_id) BETWEEN 12 AND 128
        AND (
          substr(provider_session_id, 1, 8) = 'cs_test_'
          OR substr(provider_session_id, 1, 8) = 'cs_live_'
        )
        AND substr(provider_session_id, 9) NOT GLOB '*[^A-Za-z0-9]*'
      )
    ),
  provider_subscription_id TEXT UNIQUE
    CHECK (
      provider_subscription_id IS NULL
      OR (
        length(provider_subscription_id) BETWEEN 8 AND 128
        AND substr(provider_subscription_id, 1, 4) = 'sub_'
        AND substr(provider_subscription_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
      )
    ),
  provider_expires_at INTEGER NOT NULL
    CHECK (provider_expires_at BETWEEN 0 AND 253402300799),
  lock_expires_at INTEGER NOT NULL
    CHECK (
      lock_expires_at BETWEEN 0 AND 253402300799
      AND lock_expires_at >= provider_expires_at + 180
    ),
  CHECK (
    (state = 'creating' AND provider_session_id IS NULL
      AND provider_subscription_id IS NULL AND reconciliation_token IS NULL)
    OR (state = 'ready' AND provider_session_id IS NOT NULL
      AND provider_subscription_id IS NULL AND reconciliation_token IS NULL)
    OR (state = 'reconciling' AND provider_session_id IS NOT NULL
      AND provider_subscription_id IS NULL AND reconciliation_token IS NOT NULL)
    OR (state = 'completed_pending_webhook' AND provider_session_id IS NOT NULL
      AND provider_subscription_id IS NOT NULL AND reconciliation_token IS NULL)
    OR (state = 'manual_review' AND provider_subscription_id IS NULL
      AND reconciliation_token IS NULL)
  ),
  FOREIGN KEY (owner_user_id)
    REFERENCES billing_customers(owner_user_id)
    ON DELETE CASCADE
);

-- Unpaid subscriptions can recover after invoice payment and therefore remain
-- the same live subscription identity for Checkout-safety purposes. Tighten
-- the original authority trigger without rewriting applied migration 0004.
DROP TRIGGER billing_events_identity_guard;

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
         AND s.status NOT IN ('incomplete_expired', 'canceled')
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'BILLING_IDENTITY_CONFLICT');
END;
