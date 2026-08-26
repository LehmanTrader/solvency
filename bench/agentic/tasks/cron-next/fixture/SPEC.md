# Cron

`nextFire(expr, fromMs)` -> epoch ms of the first fire time STRICTLY AFTER `fromMs`,
computed in UTC. Fires happen at second 0 of matching minutes.

Fields (space separated, exactly five): minute hour day-of-month month day-of-week.
Ranges: minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-6 (0 = Sunday).
Month names JAN..DEC and day names SUN..SAT (case-insensitive) allowed in those fields.

Syntax per field: `*`, `N`, `A-B` (A <= B), `*/S`, `A-B/S` (S >= 1), and
comma-separated lists of the above.

Errors (throw Error with exactly this message):
- wrong field count: `expected 5 fields, got <n>`
- unparseable token or value out of range: `bad field <1-based-index>: <token>`
  (report the first bad token scanning fields left to right)

Matching rule (standard cron quirk): if BOTH dom and dow are restricted (neither is `*`),
a day matches when EITHER matches. If only one is restricted, it must match.
`nextFire` may assume an answer exists within 5 years of `fromMs`.
