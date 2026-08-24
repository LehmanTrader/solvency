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
npx --no-install wrangler d1 time-travel info solvency-build-plans-preview --env preview --timestamp RFC3339_TIMESTAMP --json
npx --no-install wrangler d1 migrations list solvency-build-plans-preview --env preview --remote
```

Record the bookmark, database ID, source SHA and migration checksums in the
change record. Apply only the reviewed database/environment. Afterward, require
`No migrations to apply`, inspect the schema and run the authenticated smoke
suite before enabling a feature flag.

Time Travel restore changes remote data and requires explicit incident-commander
approval. Inspect the target first, then restore by the recorded bookmark:

```bash
npx --no-install wrangler d1 time-travel info solvency-build-plans-preview --env preview --timestamp RFC3339_TIMESTAMP --json
npx --no-install wrangler d1 time-travel restore solvency-build-plans-preview --env preview --bookmark RECORDED_BOOKMARK --json
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

## Stripe sandbox preflight and staged Preview rollout

This rollout is test-mode Preview work, not a paid launch. Production is never
an input to these steps: do not add or rotate Production Stripe credentials, do
not change a Production Cloudflare setting, and do not change a Production
flag. The production `[vars]` in `site/wrangler.toml` must keep every account,
entitlement, intent, erasure and Stripe flag false. The production artifact also
builds the Preview Stripe console as impossible and false. Stop if either
invariant changes.

The server-side Checkout, billing-portal and webhook adapters may be deployed
dark before Stripe is connected. Dark deployment is not provider readiness:
all three Stripe flags remain false and the dark routes return their hardened,
no-store 503 responses. Migration `0007_billing_checkout_attempts.sql` must be applied
to the Preview D1 database before Checkout can be enabled.

### Rollout authority and prerequisites

There are exactly two source authorities for Preview rollout state:

- `site/wrangler.toml` owns the Preview server flags, `APP_ENV`, authorized
  party and D1 binding. Never override its feature flags in the Pages dashboard.
- `site/preview-rollout.json` owns the Preview-only public Stripe console flag
  and the expected webhook Access mode (`protected` or `exact-path-bypass`).

The exact reviewed `main` commit containing those files is the deployment
authority. GitHub and Cloudflare environment values supply credentials and
allowlisted provider identifiers; they do not authorize a feature transition.
The external Access policy must match the manifest before deployment.

Before stage 1 below, all of these conditions are mandatory:

1. The GitHub `preview` environment has a required reviewer and permits only
   `main`. Preview uses a separate Clerk Development instance and Stripe test
   mode only.
2. Cloudflare Access protects the complete stable Preview hostname. No webhook
   bypass exists at baseline.
3. Preview D1 has no pending migration, the immutable checksum gate passes, and
   a recovery bookmark, database ID and exact source SHA are in the change
   record.
4. Preview has its server-only share-token secret. Its provider-owned
   `*.pages.dev` alias remains wholly behind Access except for the later exact
   webhook-path bypass; it does not inherit a `solvency.dev` zone WAF rule.
5. The destructive two-user smoke has passed and removed both synthetic Clerk
   identities and all of their D1 rows.

The destructive Preview erasure route and provider-backed billing must never be
enabled together. Middleware fails erasure closed when any Stripe surface is
enabled, but the source transition must also be explicit: finish and clean the
two-user smoke, then set `PREVIEW_ACCOUNT_ERASURE_ENABLED="false"` before any
Stripe flag becomes true. Do not re-enable erasure merely to roll Stripe back.
A future user-facing deletion flow must first persist a durable, non-cascading
deletion tombstone that blocks Checkout, then reconcile or expire provider
Sessions and subscriptions; deleting the billing customer and its cascading
attempt row is final cleanup only.

### Exact Preview environment inventory

The GitHub `preview` environment must contain exactly the following rollout
inputs for this workflow. Values with provider IDs are non-secret variables;
credentials are environment secrets.

| GitHub Preview variables | Required value |
| --- | --- |
| `PREVIEW_CLERK_PUBLISHABLE_KEY` | Clerk Development `pk_test_...` key |
| `PREVIEW_CLERK_SMOKE_USER_EMAIL` | exact email of the dedicated stable Preview smoke user |
| `PREVIEW_STRIPE_ACCOUNT_ID` | pinned Stripe test account `acct_...` |
| `PREVIEW_STRIPE_PRO_PRODUCT_ID` | reviewed test Product `prod_...` |
| `PREVIEW_STRIPE_PRO_MONTHLY_PRICE_ID` | reviewed monthly test Price `price_...` |
| `PREVIEW_STRIPE_PRO_ANNUAL_PRICE_ID` | reviewed annual test Price `price_...` |
| `PREVIEW_STRIPE_WEBHOOK_ENDPOINT_ID` | exact Preview test endpoint `we_...` |
| `PREVIEW_STRIPE_PORTAL_CONFIGURATION_ID` | reviewed active, non-default test configuration `bpc_...` |

| GitHub Preview secrets | Scope |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Preview Pages deploy and Preview D1 migration listing only |
| `CLOUDFLARE_ACCOUNT_ID` | account selector used with the deploy token |
| `PREVIEW_CLERK_SMOKE_SECRET_KEY` | separately named Clerk Development `sk_test_...` key for smoke only |
| `PREVIEW_CF_ACCESS_CLIENT_ID` | origin-scoped Preview Access service credential |
| `PREVIEW_CF_ACCESS_CLIENT_SECRET` | origin-scoped Preview Access service credential |
| `PREVIEW_STRIPE_CONFIG_READ_ONLY_KEY` | Stripe restricted test key `rk_test_...` for provider preflight only |

Cloudflare Pages **Preview** runtime configuration must contain this separate
matrix. Use the unprefixed names shown here; do not create `PREVIEW_...` aliases
in the Pages runtime. Because this project manages text variables through
Wrangler, commit the four non-secret Stripe identifier rows below under
`[env.preview.vars]` in `site/wrangler.toml`; the dashboard cannot add or edit
them. The provider preflight rejects any difference between those source values
and the GitHub `PREVIEW_...` variables before it contacts Stripe.

| Pages Preview runtime variables/config | Required value |
| --- | --- |
| `CLERK_PUBLISHABLE_KEY` | same Clerk Development `pk_test_...` client as the Preview build |
| `STRIPE_ACCOUNT_ID` | exact same `acct_...` as `PREVIEW_STRIPE_ACCOUNT_ID` |
| `STRIPE_PORTAL_CONFIGURATION_ID` | exact same non-default `bpc_...` as `PREVIEW_STRIPE_PORTAL_CONFIGURATION_ID` |
| `STRIPE_PRO_MONTHLY_PRICE_ID` | exact same monthly `price_...` as the GitHub preflight variable |
| `STRIPE_PRO_ANNUAL_PRICE_ID` | exact same annual `price_...` as the GitHub preflight variable |

| Pages Preview runtime secrets | Scope |
| --- | --- |
| `CLERK_SECRET_KEY` | isolated Clerk Development runtime only |
| `CLERK_JWT_KEY` | isolated Clerk Development verifier only |
| `BUILD_SHARE_TOKEN_SECRET` | Preview share-token signing only |
| `STRIPE_SECRET_KEY` | Stripe test-mode runtime key `sk_test_...` only |
| `STRIPE_WEBHOOK_SECRET` | signing secret `whsec_...` for the exact Preview endpoint only |

`CLERK_AUTHORIZED_PARTIES`, `APP_ENV`, every account/entitlement/intent/erasure
flag and every Stripe feature flag remain source-controlled in
`site/wrangler.toml`; there must be no Pages dashboard override. The Stripe
Product ID and webhook endpoint ID, plus
`PREVIEW_STRIPE_CONFIG_READ_ONLY_KEY`, are preflight-only and must never enter
the Pages runtime. Conversely, `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` must never enter GitHub preflight, deploy or smoke
jobs. The Clerk runtime key, JWT key and share-token secret must not enter
GitHub. Cloudflare deploy credentials must not enter Pages runtime. This
separation is a release boundary, not an organizational preference.

Create one stable, non-production smoke user in the isolated Clerk Development
instance and set its exact email in `PREVIEW_CLERK_SMOKE_USER_EMAIL`. It is not
either destructive synthetic smoke identity and is not deleted by cleanup.
Stripe-enabled smoke uses it only for authenticated GETs. Record one explicit
owner and rotation schedule for this user, the separately named
`PREVIEW_CLERK_SMOKE_SECRET_KEY`, and the Access service credentials. Revoke
those credentials only after billing is dark and recurring smoke is
intentionally retired or replacement credentials have passed the same smoke.

The Stripe restricted key must have exactly these read permissions and no write
permissions: **Accounts Read**, **Products Read**, **Prices Read**, **Webhook
Endpoints Read**, and **Billing Portal Configurations Read**. Do not substitute
an unrestricted `sk_test_...` runtime key for preflight.

### Actual Preview workflow graph

The manual `Deploy Preview` workflow is one exact-SHA, four-job dependency
graph:

```text
resolve-rollout
  -> stripe-config-preflight (conditional: any Stripe server surface is true)
  -> deploy-preview
  -> smoke-preview
```

When all Stripe server surfaces are false, the provider preflight is skipped
and `deploy-preview` proceeds only after `resolve-rollout` succeeds. When any
surface is true, `deploy-preview` is blocked unless the same-commit provider
preflight succeeds. The jobs run on fresh runners and receive only their own
credentials:

- `resolve-rollout` receives no environment secrets. It requires explicit
  authorization, current `main`, the exact GitHub SHA and valid source rollout
  state.
- Conditional `stripe-config-preflight` receives only the restricted Stripe
  read key and the six allowlisted Stripe IDs. It performs GET-only account,
  Product, Price, webhook-endpoint and Billing Portal configuration checks.
- `deploy-preview` receives only the Cloudflare deploy credentials and the
  Clerk publishable build variable. It rejects anything other than a Clerk
  Development `pk_test_...` value, then rechecks source, tests, audit,
  Functions, a clean tree and `No migrations to apply`; it never applies a
  migration.
- `smoke-preview` always performs non-destructive exact-SHA release attestation
  through Access. While Stripe is dark and erasure is enabled it additionally
  runs the destructive two-user cleanup smoke. Once any Stripe surface is on it
  instead uses the stable Clerk user for authenticated provider- and
  product-state-read-only entitlement, plan-list and `/api/billing-readiness`
  GETs. Those GETs still advance the normal bounded per-owner D1 rate-limit
  counter; they do not mutate Clerk, Stripe, plans, entitlements or billing
  records.

`Stripe Preview Configuration Preflight` is a separate, manual GET-only
workflow for stage 2 while all Stripe surfaces are still dark. It does not
deploy or mutate Stripe. Every later enabled `Deploy Preview` repeats the same
provider attestation from the deployment commit before publishing.

Before an enabled deployment, record and re-attest both immutable trust anchors:
the exact `acct_...` account and the exact active, non-default `bpc_...` Portal
configuration. The GitHub and Pages values must match byte-for-byte. Provider
preflight proves the restricted key sees that account and that exact Portal
policy. The deployed authenticated readiness GET independently uses the Pages
runtime `STRIPE_SECRET_KEY` to retrieve `/v1/account` and fails closed unless it
matches `STRIPE_ACCOUNT_ID`. Portal creation always sends the pinned
`STRIPE_PORTAL_CONFIGURATION_ID` and rejects a different returned
configuration. A provider dashboard change, key rotation or ID replacement
requires re-attestation before another enabled deploy.

### Exact stage order

Use one reviewed source commit and one completed `Deploy Preview` run per source
transition. Do not combine stages, and do not proceed unless the final smoke job
passes for the exact deployed SHA.

0. **Dark baseline:** `PREVIEW_ACCOUNT_ERASURE_ENABLED="true"`; Webhook, Portal
   and Checkout false; `stripeSandboxUiEnabled=false`; webhook Access mode
   `protected`. Production remains untouched and dark.
1. **Close destructive testing:** run the two-user smoke to successful cleanup,
   then commit only `PREVIEW_ACCOUNT_ERASURE_ENABLED="false"`. Keep all Stripe
   flags false, UI false and Access protected; deploy and attest.
2. **Pin provider configuration while dark:** create/review the Stripe test
   Product, monthly and annual Prices, enabled exact webhook endpoint and active
   non-default Portal configuration. Install the GitHub and Pages matrices
   above, verify matching account/Portal/Price IDs, then run `Stripe Preview
   Configuration Preflight`. Keep every Stripe flag and the UI false.
3. **Stage the webhook edge:** externally add a bypass for only the exact
   `/api/stripe-webhook` path. Do not bypass a prefix, wildcard, neighbor or any
   other route. Commit only `webhookAccessMode="exact-path-bypass"` in
   `site/preview-rollout.json`; keep Webhook, Portal, Checkout and UI false.
   Deploy and require a public hardened 503 from the exact webhook route while
   neighboring routes remain Access-protected.
4. **Enable Webhook only:** commit only
   `STRIPE_WEBHOOK_ENABLED="true"`; keep Portal, Checkout and UI false. The
   same-commit conditional provider preflight must pass before deploy and smoke.
5. **Enable Portal:** after signed webhook lifecycle evidence passes, commit only
   `STRIPE_PORTAL_ENABLED="true"`; keep Checkout and UI false. Deploy and smoke.
6. **Enable Checkout behind the operator UI:** after Portal evidence passes,
   commit only `STRIPE_CHECKOUT_ENABLED="true"`; keep
   `stripeSandboxUiEnabled=false`. Deploy, smoke and complete the provider-backed
   lifecycle matrix below without exposing the console.
7. **Expose the Preview sandbox console:** only after the lifecycle matrix and
   reconciliation pass, commit only `stripeSandboxUiEnabled=true` in
   `site/preview-rollout.json`, then deploy and smoke.

Production remains untouched and dark during every stage. Never copy a Preview
credential or identifier into Production as part of this sequence.

### Reverse-order rollback

Rollback is a sequence of reviewed forward commits and completed attestations,
not dashboard flag edits. Preserve the exact stage evidence and reverse in this
order:

1. Set `stripeSandboxUiEnabled=false`; deploy and attest.
2. Set `STRIPE_CHECKOUT_ENABLED="false"`; deploy and attest.
3. Set `STRIPE_PORTAL_ENABLED="false"`; deploy and attest.
4. Set `STRIPE_WEBHOOK_ENABLED="false"` while the exact-path Access bypass is
   still present; deploy and prove the publicly reachable exact webhook path is
   a hardened no-store 503 and neighboring paths are still Access-protected.
5. Remove the external exact-path Access bypass, set
   `webhookAccessMode="protected"`, deploy and attest the whole Preview origin
   is protected.

Leave `PREVIEW_ACCOUNT_ERASURE_ENABLED="false"` after ordinary billing
rollback. Re-enabling destructive erasure requires a separate reviewed cleanup
that proves no provider customer, Session, subscription, webhook retry or D1
billing state remains. Production stays untouched and dark throughout rollback.

### Preview red-smoke recovery

Before billing is introduced, treat the Preview checkpoint as incomplete if
`resolve-rollout`, `deploy-preview` or `smoke-preview` fails, or if a destructive
smoke run lacks its final cleanup success. Keep the full Preview origin behind
Access and every Stripe flag false; do not start stage 1.

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
3. Fix forward on `main` with all Stripe flags false and Access protected. Run
   the complete graph again. The non-destructive release attestation always
   runs; the destructive two-user smoke runs only while billing is dark and
   erasure is enabled.
4. Do not consider recovery complete until synthetic Clerk users are absent,
   their D1 data is erased, and the intended exact build SHA and source state
   are independently attested.

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
