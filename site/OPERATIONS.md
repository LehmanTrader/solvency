# Solvency release and billing operations

This is the operator runbook for Cloudflare Pages, Pages Functions and D1. It
does not authorize a paid launch. Production account, entitlement, intent and
Stripe webhook flags remain false until the separate launch review approves
them.

## Release evidence and preflight

The production workflow is the release authority. It checks an exact `main`
commit, immutable migration digests, tests, source coverage, dependency audit,
the static build, the Functions bundle and a clean source tree. The build embeds
the full GitHub commit in `<meta name="solvency-build-sha">`. After Pages
publishes, the workflow retries a fixed production health matrix and requires
the same SHA plus hardened 503 responses from every dark endpoint.

Useful read-only checks from the repository root:

```bash
npm test
npm run coverage
cd site
npm run check:migrations
npm audit --audit-level=high
npm run build:functions
npx --no-install wrangler pages deployment list --project-name solvency --json
```

Inspect a GitHub release without changing it:

```bash
gh run view RUN_ID --repo LehmanTrader/solvency
gh run view RUN_ID --repo LehmanTrader/solvency --log
```

Never edit or replace an existing entry in `migrations/checksums.json`. Add a
new, sorted entry only with a new numbered SQL migration. `npm run
check:migrations` must pass before a remote migration is considered.

## Pages rollback

1. Confirm the incident and record the current deployment ID, source SHA and
   the last known-good production deployment using `wrangler pages deployment
   list` above.
2. If billing code is involved, first turn the affected runtime flag off in the
   Pages Production environment. `STRIPE_WEBHOOK_ENABLED=false` is the webhook
   kill switch. Do not change the client gate as a substitute for the server
   flag.
3. In Cloudflare Pages, open the known-good production deployment and use the
   dashboard rollback control. Do not delete either deployment: deployment
   deletion is not rollback and destroys evidence.
4. From `site/`, attest the rollback using the full known-good SHA:

   ```bash
   EXPECTED_BUILD_SHA=KNOWN_GOOD_40_CHARACTER_SHA npm run verify:production-dark
   ```

5. Preserve the rollback in source with a reviewed forward fix on `main`. A
   Pages rollback does not revert D1 and does not replace a source fix.

If the known-good release was not a dark release, use its documented health
matrix rather than weakening `verify:production-dark`.

## D1 migration and recovery boundary

Production D1 must not be migrated as part of an ordinary site release. The
preview workflow deliberately lists migrations and refuses to apply them.
Migration application is a separate, reviewed operator action.

Immediately before an approved remote migration, record an RFC3339 timestamp
and retrieve a Time Travel bookmark:

```bash
cd site
npx --no-install wrangler d1 time-travel info solvency-build-plans-preview --timestamp RFC3339_TIMESTAMP --json
npx --no-install wrangler d1 migrations list solvency-build-plans-preview --env preview --remote
```

Record the bookmark, database ID, source SHA and migration checksums in the
change record. Apply only the reviewed database/environment. Afterward, require
`No migrations to apply`, inspect the schema and run the authenticated smoke
suite before enabling a feature flag.

Time Travel restore changes remote data and requires explicit incident-commander
approval. Inspect the target first, then restore by the recorded bookmark:

```bash
npx --no-install wrangler d1 time-travel info solvency-build-plans-preview --timestamp RFC3339_TIMESTAMP --json
npx --no-install wrangler d1 time-travel restore solvency-build-plans-preview --bookmark RECORDED_BOOKMARK --json
```

After restore, keep affected flags false. Re-run migration listing, schema
checks and the smoke suite before reopening traffic. Never restore production
to repair only a Pages deployment.

## Functions monitoring and reconciliation

Pages logs can be tailed with the pinned local Wrangler installation:

```bash
cd site
npx --no-install wrangler pages deployment tail --project-name solvency --environment production --format json --status error
```

Unexpected server failures emit exactly this application record; Cloudflare
adds request/runtime metadata outside the application payload:

```json
{"schema_version":1,"event":"server_error","severity":"error","boundary":"account_api","request_id":"..."}
```

The application record must never gain an owner ID, bearer token, URL, header,
request/response body, Stripe object or exception message. Alert on any sustained
`server_error`, any webhook non-2xx rate, signature failure, billing identity
conflict or entitlement-read outage. Use the request ID to correlate platform
logs without placing identity or billing payloads in application logs.

Before enabling the sandbox webhook, add aggregate outcome counters for applied,
replayed, stale/restrictive and rejected deliveries; those outcomes are not all
persisted in `billing_events`. Once sandbox billing exists, reconcile at least
daily while testing and after every incident:

- Stripe webhook deliveries: delivered, retrying and permanently failed.
- Application outcome counters against Stripe delivery results. Counters contain
  no provider, owner or payload identifiers.
- D1 normalized billing-event row counts and age against processed Stripe
  subscription-event deliveries.
- D1 subscription status counts against Stripe subscription status counts.
- Accounts with an entitlement but no bound customer, or a bound customer but
  no subscription state; either condition is investigated, never repaired from
  browser metadata.
- Product-intent aggregate counts and expiry only; do not export owner rows.

Pause the webhook flag if reconciliation diverges. Repair the adapter or replay
verified Stripe events; do not hand-edit entitlement rows to make counts agree.

## Stripe sandbox preflight

Connected Stripe sandbox work is allowed only after all of these are true:

1. The GitHub `preview` environment has a required reviewer and `main` branch
   restriction. Preview uses a separate Clerk Development instance.
2. Cloudflare Access rejects requests without valid user/service credentials.
   The public webhook exception does not exist until raw-body signature
   verification and a byte cap are deployed.
3. Preview D1 has no pending migration, its checksum gate passes, and a recovery
   bookmark is recorded.
4. Preview has a server-only share-token secret and edge rate limiting for the
   public-share path. Account, entitlement and intent flags are enabled only in
   Preview; `STRIPE_WEBHOOK_ENABLED` remains false.
5. The two-user authenticated smoke matrix passes and leaves both Clerk and D1
   clean.

Then create sandbox-only monthly and annual flat USD Prices. Checkout and the
billing portal must select a server allowlisted Price; the browser never submits
an authoritative amount or entitlement.

Only these verified events are direct inputs to the current entitlement reducer:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Checkout completion and invoice events may be used as operational signals or to
request authoritative subscription state, but they are not passed to the
reducer and cannot grant Pro. Verify `Stripe-Signature` over a byte-bounded,
untouched raw body before JSON parsing. Test monthly/annual purchase, portal
cancellation, expiration, payment failure/recovery, unknown/wrong/mixed Prices,
quantity other than one, duplicates, same-time and out-of-order delivery,
cross-account attempts and kill-switch recovery before considering live mode.
