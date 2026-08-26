# Retry engine

`retry(fn, policy)` -> Promise of `{ value, attempts }` or rejects with the final error
(the error object from the last attempt, with `error.attempts` set to the history).

`policy`:
- `retries`      max retry count after the first attempt (so attempts <= retries + 1)
- `baseMs`       first delay
- `factor`       multiplier per retry
- `capMs`        delay ceiling (applied before jitter)
- `jitter(ms)`   returns the actual delay for a computed ms (injected, deterministic)
- `sleep(ms)`    injected async sleep; MUST be awaited with the jittered value
- `budgetMs`     total allowed sleeping; if the next jittered delay would push the
                 cumulative slept time over budget, stop and reject with the last error,
                 message untouched, `error.retryStopped = 'budget'`
- `retryable(e)` predicate; a non-retryable error rejects immediately with
                 `error.retryStopped = 'non-retryable'`

`attempts` (also set on the rejection error as `error.attempts`) is an array of
`{ n, delayMs }`: n is 1-based attempt number; delayMs the jittered delay slept BEFORE
that attempt (0 for the first). Exhausting retries sets `error.retryStopped = 'exhausted'`.
`fn(n)` receives the attempt number.
