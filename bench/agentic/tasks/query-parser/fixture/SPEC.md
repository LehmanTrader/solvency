# Query language

`compile(query)` -> `(doc) => boolean`. `doc` is `{ [field]: string }`.

Grammar (case-sensitive keywords):
- Terms: bare word (`[A-Za-z0-9_]+`) or quoted phrase `"two words"`.
- Optional field prefix: `title:word` or `body:"a phrase"`. Unfielded terms match if
  ANY field's value matches.
- Matching is case-insensitive whole-word / whole-phrase: a term matches when it
  appears as a word-boundary-delimited substring of the field text (a phrase must
  appear with single spaces between its words).
- Operators, tightest first: NOT (prefix), AND, OR. `a b` (juxtaposition) means AND.
- Parentheses group.

Errors (throw Error with exactly this message at compile time):
- `unbalanced parens`
- `unterminated phrase`
- `dangling operator` (AND/OR with a missing side, or NOT with nothing after it)
- `empty query` (whole query or `()`)
