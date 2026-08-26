# Async cache: fix the races

`createCache(loader)` -> `{ get, invalidate, stats }` (API is FROZEN — fix behavior).

- `get(key)`: resolve the cached value or load it via `loader(key)`.
- `invalidate(key)`: drop the key.
- `stats()` -> `{ loads }` — how many times `loader` was actually invoked.

Bugs to fix (currently present):
1. **Stampede**: N concurrent `get('k')` calls each invoke the loader. Required:
   concurrent gets for the same key share ONE loader call (single-flight).
2. **Stale write-back**: `invalidate(key)` during an in-flight load must prevent that
   load's result from being cached — the in-flight callers still get the value, but a
   LATER `get` must call the loader again.
Behavior on loader rejection: the error propagates to every waiting caller and
nothing is cached (a later get retries).
