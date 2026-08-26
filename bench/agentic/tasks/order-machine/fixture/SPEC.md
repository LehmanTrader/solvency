# Order lifecycle machine

`createOrder(nowFn)` -> `{ state(), send(event, atMs), history() }`.
`nowFn` is unused except that `send` receives an explicit `atMs` timestamp.

States and transitions:
- 'draft'    --submit-->  'placed'
- 'placed'   --pay-->     'paid'
- 'placed'   --cancel-->  'cancelled'
- 'paid'     --ship-->    'shipped'
- 'paid'     --refund-->  'refunded'   (guard: only within 3_600_000 ms of the 'pay' event's atMs)
- 'shipped'  --deliver--> 'delivered'

Rules:
- Illegal event for the current state: throw Error `cannot <event> from <state>`.
- A refund outside the window: throw Error `refund window closed`; state unchanged.
- `history()` returns `[{ from, to, event, atMs }, ...]` in order (guards that throw add nothing).
- `state()` returns the current state string; initial state 'draft'.
