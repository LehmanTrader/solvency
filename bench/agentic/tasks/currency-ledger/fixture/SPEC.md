# Multi-currency ledger

`createLedger(rates)` -> `{ post, balance, trialBalance, convert }`.

`rates`: `{ 'EUR': 108133, ... }` — price of ONE unit of the currency in millionths of
the base currency unit... no: in MICRO-base per MINOR unit. Precisely: converting
`amount` minor units of currency C to base minor units is
`round_half_even(amount * rates[C] / 1_000_000)`. The base currency itself must have
rate 1_000_000. Unknown currency in any call: throw Error `unknown currency <C>`.

- `convert(amount, currency)` -> base minor units (integer), half-to-even rounding
  (2.5 -> 2, 3.5 -> 4 at the .5 boundary of the division).
- `post(entryId, legs)`: legs are `{ account, amountMinor, currency }` (amountMinor a
  nonzero integer, debit positive / credit negative; zero: throw Error `zero leg`).
  The entry must balance IN BASE UNITS after conversion: nonzero sum -> throw Error
  `unbalanced entry <entryId> by <sum>` and post nothing. Duplicate entryId: throw
  Error `duplicate entry <entryId>`.
- `balance(account)` -> `{ [currency]: minorUnits }` net per currency (omit zeros).
- `trialBalance()` -> `{ [account]: baseMinor }` for every account with a nonzero
  converted net, keys sorted alphabetically (insertion order of the returned object).
