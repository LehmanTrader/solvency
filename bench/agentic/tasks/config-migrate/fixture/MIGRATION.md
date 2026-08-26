# v1 -> v2 config migration

Input: a v1 object. Output: a NEW v2 object (never mutate the input).

Rules:
1. `server.host` and `server.port` move to top-level `listen` as `"host:port"`.
   Missing host defaults to '0.0.0.0'; missing port to 8080.
2. `timeoutSec` (seconds, number) becomes `timeoutMs` (milliseconds).
   Absent -> 30000.
3. `features` (array of names) becomes an object `{name: true, ...}`.
   Absent or empty -> `{}`. Duplicate names collapse.
4. The deprecated `debug` key is DROPPED, but if it was `true`, add
   `"log"` to v2 `features` (as `log: true`) unless already present.
5. Every OTHER top-level key passes through unchanged (shallow copy).
6. Add `schemaVersion: 2` (always; overwrite any incoming value).
