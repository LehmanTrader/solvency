# limiter

`createLimiter(max, windowMs)` returns `{ allow(nowMs) }`.
`allow(now)` returns true and records the hit if fewer than `max` recorded hits fall in the half-open window `[now - windowMs, now)` (a hit exactly windowMs old still counts); otherwise false and records nothing.
