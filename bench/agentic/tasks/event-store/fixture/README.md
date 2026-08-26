# eventstore

Events: `{ type: 'deposit'|'withdraw', account, amount }` (amount > 0).
`project(events)` in src/projector.js -> `Map` of account -> balance; a withdraw beyond the balance is IGNORED (balance never goes negative, later events still apply).
`balanceOf(store, account)` in src/index.js -> number (0 for unknown accounts).
