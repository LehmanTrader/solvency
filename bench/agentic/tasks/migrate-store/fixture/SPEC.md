# Store v2 migration

Replace the v1 callback store in `src/store.js` with the v2 API and migrate every
caller in `src/` to it. Delete no files; keep each caller's exported names and
documented behavior.

## v2 API (exact)
`createStore()` -> `{ get, put, del }`:
- `get(key)` -> Promise resolving the value, or REJECTING with
  `new Error('not found: <key>')` for a missing key.
- `put(key, value, { ttlMs } = {})` -> Promise<void>. ttl is accepted but not enforced.
- `del(key)` -> Promise<boolean> — true if the key existed (never rejects).

## Callers to migrate (their contracts stay identical)
- `session.js` `createSessions(store)`: `open(id, user)` stores `sess:<id>` -> user and
  resolves the user; `whoIs(id)` resolves the stored user or `null` for a missing
  session (it must not reject).
- `cache-facade.js` `cached(store, key, producer)`: resolve the stored value if
  present; otherwise call `producer()`, store the result under `key`, resolve it.
  A second call with the same key must NOT call the producer again.
- `audit.js` `record(store, event)`: appends event strings under key `audit-log`
  (array), creating it on first use; resolves the new length. `entries(store)`
  resolves the array (empty array when absent).
