# WAL replay and compaction

Ops (applied in order): `{ op: 'set', key, value }`, `{ op: 'del', key }`,
`{ op: 'rename', from, to }`.

`replay(ops)` -> `{ state, errors }`:
- `set` writes; `del` removes (deleting a missing key appends
  `del missing <key>` to `errors` and does nothing); `rename` moves the value
  (missing `from`: append `rename missing <from>`, do nothing; existing `to`:
  overwrite it).
- `state` is a plain object of surviving key -> value; `errors` an array of strings
  in occurrence order.

`compact(ops, baseKeys)` -> minimal op list `out` such that replaying `out` on ANY
starting store whose key set is exactly `baseKeys` (values arbitrary) yields the same
final state as replaying `ops` on it. Rules that make this well-defined:
- For every key in the final picture, the needed op is either one `set` (when its
  final value is known from the log) or one `rename` (only when a base key's unknown
  value flowed, possibly through a rename CHAIN, into a different final key).
- A base key whose value neither survives anywhere nor is overwritten must get one
  `del` (tombstone). Renames count as consuming their `from`.
- Order: all dels first (key-alphabetical), then renames (by `to` alphabetical), then
  sets (key-alphabetical). Rename chains collapse to a single rename from the
  original base key. A rename whose target equals its source is dropped.
- `compact` must ignore ops on keys that end up irrelevant (set-then-del, etc.).
- Replaying `compact(ops, baseKeys)` must produce no errors.
