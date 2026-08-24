# Solvency release and billing operations

This is the operator runbook for Cloudflare Pages, Pages Functions and D1. It
does not authorize a paid launch. Production account, entitlement and intent
flags, plus `STRIPE_CHECKOUT_ENABLED`, `STRIPE_PORTAL_ENABLED` and
`STRIPE_WEBHOOK_ENABLED`, remain false until the separate launch review
approves them.

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
2. If billing code is involved, first turn the affected server runtime flag off
   in the Pages Production environment: `STRIPE_CHECKOUT_ENABLED=false`,
   `STRIPE_PORTAL_ENABLED=false` or `STRIPE_WEBHOOK_ENABLED=false`. If the
   boundary is uncertain, turn off all three. Do not change a client gate as a
   substitute for these server kill switches.
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

The adapters emit only closed, identifier-free aggregate outcomes. Checkout and
portal use `billing_outcome`; the webhook uses `billing_webhook_outcome`. Do not
add request IDs, owner IDs, provider IDs, URLs, headers, bodies or exception text
to either record. Before enabling sandbox billing, connect counters for created,
replayed, conflicting, provider-rejected, provider-retryable, ambiguous,
completion-failure, pending-webhook and manual-review Checkout outcomes;
created, replayed and failed portal outcomes; and applied, replayed, stale,
ignored, signature-rejected, payload-rejected and retryable webhook outcomes.
These outcomes are not all persisted in D1.

Alert immediately on any `checkout_manual_review` outcome. It is the closed,
identifier-free signal that a stale creating generation, an aged receipt with no
exact terminal authority, or an inconclusive aged recovery needs operator
investigation. Do not treat `checkout_pending_webhook` as the same incident; it
signals an exactly subscription-bound Session receipt that remains fail-closed
while signed webhook authority is pending.

Once sandbox billing exists, reconcile at least daily while testing and after
every incident:

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

The server-side Checkout, billing-portal and webhook adapters may be deployed
dark before Stripe is connected. Dark deployment is not a paid launch: all
three Stripe flags must remain false, and the production health matrix must
continue to receive hardened no-store 503 responses from all three routes.
Migration `0007_billing_checkout_attempts.sql` must be applied to the selected
D1 database before Checkout can be enabled there.

The destructive Preview smoke erasure route and provider-backed billing must
never be enabled together. Middleware fails the erasure route closed whenever
Checkout, Portal or Webhook is enabled. Before an operator-only sandbox run,
finish the clean two-user smoke checkpoint, confirm no synthetic identity or D1
row remains, then disable `PREVIEW_ACCOUNT_ERASURE_ENABLED` before enabling any
Stripe flag. A future user-facing deletion flow must first persist a durable,
non-cascading deletion tombstone that blocks Checkout, then reconcile or expire
provider Sessions and subscriptions; deleting the billing customer and its
cascading attempt row is final cleanup only.

The manual Preview workflow uses two separately approved jobs on fresh runners.
The deploy job receives only Cloudflare deployment credentials. The dependent
smoke job checks out the same `github.sha`, attests that SHA through Access and
then receives only these GitHub `preview` environment values:

- variable `PREVIEW_CLERK_PUBLISHABLE_KEY`;
- secrets `PREVIEW_CLERK_SMOKE_SECRET_KEY`,
  `PREVIEW_CF_ACCESS_CLIENT_ID` and `PREVIEW_CF_ACCESS_CLIENT_SECRET`.

Create the smoke Secret Key as a separately named key in the isolated Clerk
Development instance so it can be revoked without changing the Pages runtime.
Pages Preview alone receives runtime `CLERK_PUBLISHABLE_KEY`,
`CLERK_SECRET_KEY`, `CLERK_JWT_KEY` and `BUILD_SHARE_TOKEN_SECRET`; never copy
the JWT or share-token secret into GitHub. Revoke the smoke Clerk key and Access
token after the one-time checkpoint, or retain them only with an explicit
rotation owner if recurring Preview smoke is approved.

### Preview red-smoke recovery

Treat the Preview checkpoint as incomplete if the deploy job succeeds but the
second approval is not granted, the smoke job fails, or its final cleanup line
is absent. Keep Cloudflare Access and `STRIPE_WEBHOOK_ENABLED=false` in force;
do not start Stripe work.

1. If smoke created identities, list only Clerk Development users whose
   `externalId`, private metadata and test email all carry the exact synthetic
   smoke markers. Rerun the corrected smoke workflow: before creating any new
   identity it signs each exact stale user in through Clerk's supported browser
   testing flow on the stable Preview origin, calls authenticated
   `DELETE /api/preview-account-erasure` with the exact confirmation plus
   origin-scoped Access service headers, and requires
   `{ "data": { "erased": true } }`. It deletes that Clerk user only after D1
   erasure succeeds. Never create a Backend API-only session for recovery,
   hand-delete D1 owner rows or delete the Clerk identity first.
2. Preserve logs that contain operation names and request IDs, but never copy
   Access credentials, Clerk keys, session tokens or `sv1_` paths into an
   issue, artifact or support ticket.
3. To darken Preview, make a reviewed commit that restores only the three
   `[env.preview.vars]` account, entitlement and intent flags to `"false"`,
   leave Preview erasure true and Stripe false, and run the manual Preview
   deploy job. Reject the dependent smoke job because its readiness contract
   correctly requires feature-on Preview; verify instead that the stable alias
   and latest immutable hash remain behind Access and the three
   account routes return the hardened no-store `503 SERVICE_UNAVAILABLE` state
   through service authentication.
4. Do not consider recovery complete until synthetic Clerk users are absent,
   their D1 data is erased, and the intended exact build SHA and flag state are
   independently attested.

1. The GitHub `preview` environment has a required reviewer and `main` branch
   restriction. Preview uses a separate Clerk Development instance.
2. Cloudflare Access rejects requests without valid user/service credentials.
   The public webhook exception does not exist until raw-body signature
   verification and a byte cap are deployed.
3. Preview D1 has no pending migration, its checksum gate passes, and a recovery
   bookmark is recorded.
4. Preview has a server-only share-token secret. Its `*.pages.dev` alias remains
   wholly behind Access and cannot inherit a `solvency.dev` zone WAF rule. Before
   making any bearer link public, use a proxied custom hostname and complete the
   public-share edge gate below. Account, entitlement and intent flags are
   enabled only in Preview; every Stripe flag remains false.
5. The two-user authenticated smoke matrix passes and leaves both Clerk and D1
   clean.

### Public-share edge gate

Cloudflare zone settings apply to a proxied custom Pages domain, not the
provider-owned `*.pages.dev` hostname. Do not mark the public-share edge gate
complete on the current Preview alias. Before exposing `/shared-build-plans/*`
without Access:

1. Attach a branch-specific proxied custom hostname such as
   `preview.solvency.dev` to `d1-functions-preview`. Complete certificate/domain
   validation while the public-share and billing runtime flags remain false.
2. Add and verify a separate Access application for that hostname. The Pages
   Preview Access policy does not automatically cover custom domains.
3. Update every exact-origin pin together: Wrangler authorized party, Clerk
   Development allowed origin/redirect, smoke base URL and erasure origin.
4. On Business or higher, deploy this rate-limit expression with IP as the
   characteristic, 60 requests per 60 seconds, Block for 600 seconds, cached
   assets included and the default 429 response:

   ```text
   (http.host eq "preview.solvency.dev"
    and starts_with(http.request.uri.path, "/shared-build-plans/")
    and http.request.method eq "GET")
   ```

   On Pro, omit the method and retain host + path. On Free, only a path-scoped
   fallback is available; use 10 requests per 10 seconds and Block for 10
   seconds. The application rejects non-GET requests before D1, but a lower-plan
   rule can affect the same path on every hostname in the zone.
5. Send a controlled burst through the custom hostname, require a 429 above the
   threshold, then prove ordinary HTML and JSON-link reads recover after the
   mitigation window. Treat this as per-location burst protection rather than a
   global hard quota.

Share tokens appear in request paths and therefore may appear in Cloudflare
Security Events. Restrict analytics access and never export or circulate sampled
event logs containing those paths.

Then create sandbox-only monthly and annual flat USD Prices. Checkout and the
billing portal must select a server allowlisted Price; the browser never submits
an authoritative amount or entitlement.

Before enabling sandbox Checkout, turn on Stripe Checkout's **Limit customers
to one subscription** setting for the sandbox account, keep customer-portal
login enabled, and configure the existing-subscriber redirect to the billing
portal. Verify both an `active` and an `unpaid` test subscription are redirected
instead of receiving a second Checkout Session. This provider control is a
required backstop for the final D1 subscription-check-to-Stripe-create race;
`unpaid` counts as an existing subscription even though it grants no Pro access.

Checkout permits only one active attempt per verified owner across Cloudflare
isolates. D1 stores a SHA-256 request hash, a random generation token, state,
bounded expiries, a nullable short reconciliation token and, only after
successful Stripe Session creation and durable receipt, the Stripe Checkout
Session ID. While a completed Session is waiting for verified subscription
authority, the same row also stores the exact Stripe Subscription ID. It never
stores the raw browser idempotency key or hosted Checkout URL. Stripe idempotency is
derived from the persisted generation token: a ready replay uses the same key,
while an authorized replacement receives a fresh generation and key.

A new attempt uses a provider expiry 32 minutes in the future and a crash-safe
lock lasting 35 minutes. An unexpired same-request ready retry replays the exact
Stripe request with the persisted expiry and requires the same Session ID. From
provider expiry through the remaining three-minute grace, all Checkout callers
are blocked. After grace, one caller may atomically move the receipt to
`reconciling` under a fresh 30-second CAS lease and retrieve that exact Session.
Validate its Session ID, owner-bound customer, test/live mode, subscription
mode, persisted expiry, status and subscription field. Before the 72-hour
boundary, only an exact `expired` Session with no subscription may directly
retire the receipt and install a fresh creating generation. A non-null
subscription is settled in one SQL CAS: replacement is allowed only when D1
currently proves that exact owner, bound customer and retrieved subscription is
`canceled` or `incomplete_expired`; otherwise the exact Subscription ID is kept
in `completed_pending_webhook`. A later verified terminal event retires only
that exact owner/customer/subscription-bound receipt. `unpaid` is not terminal
for replacement and must remain blocked or be managed in the billing portal.
`open`, `complete` without a subscription, and ambiguous responses retain the
receipt with a 60-second backoff.

At 72 hours after provider expiry, an aged ready or reconciling receipt normally
moves to `manual_review`. There is one narrow recovery path when the same atomic
acquisition UPDATE proves current D1 authority for the owner's bound customer is
`canceled` or `incomplete_expired`: retrieve the exact Session once, then allow
a fresh generation only if a second CAS matches its non-null Subscription ID to
that exact terminal row. An expired Session with no subscription, a mismatch,
an inconclusive response, or terminal authority revoked before settlement is
unsafe; each moves the aged receipt to `manual_review`. A stale creating row
also requires manual review; it is never blindly recycled. Signed webhook authority may make the
subscription pre-check block sooner, but the absence of an event never
authorizes replacement.

A same-request creating retry or a different active request returns a sanitized
409 with `Retry-After`; it cannot create another Session. Release an acquired
generation only before any provider request or after a bounded, valid Stripe
error envelope conclusively rejects creation with status 400, 401, 402 or 403
and `Stripe-Should-Retry` is absent or exactly `false`. A strict 429
`rate_limit_error` under the same retry-header rule releases only that exact
generation and returns a sanitized backoff response. Status 408, 409, 404, 422,
unknown statuses, unknown or malformed errors, `Stripe-Should-Retry: true` or a
malformed retry header, network failure, timeout and 5xx are ambiguous and
retain the generation.

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
