-- Exact fixed-window throttling for authenticated account-plan requests.
-- The primary key guarantees one bounded counter row per verified Clerk owner;
-- request volume never creates additional rows.
CREATE TABLE build_plan_rate_limits (
  owner_user_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(owner_user_id) BETWEEN 8 AND 128),
  window_bucket INTEGER NOT NULL
    CHECK (window_bucket >= 0),
  request_count INTEGER NOT NULL
    CHECK (request_count BETWEEN 1 AND 120)
);
