# JSON patch

`apply(doc, ops)` -> new document. Never mutate `doc`. `ops` is an array of
`{ op, path, value?, from? }` applied in order; if any op throws, nothing is returned.

Pointers: RFC-6901. `""` is the whole document; `~1` -> `/`, `~0` -> `~` (in that
decode order). Array index token must be a canonical integer (`0`, `7`, no leading
zeros, no minus) or `-` (end of array, only where noted).

Ops:
- add: insert at path. Object key: set. Array index: splice in at index (0..len allowed,
  `-` appends). Parent must exist: else throw Error `missing parent <parentPointer>`.
- remove: delete at path. Missing target: throw Error `missing <pointer>`.
- replace: like remove+add at an existing location; missing: `missing <pointer>`.
- move: remove at `from`, add at path. Moving into your own subtree
  (path == from or path starts with from + '/'): throw Error `cannot move into self`
  — except path == from is a no-op returning the same content.
- copy: read at `from` (missing: `missing <pointer>`), deep-copy, add at path.
- test: deep-equal check; mismatch: throw Error `test failed at <pointer>`.
- Bad array index token (e.g. `01`, `x`, out of range): throw Error `bad index <token>`.
- Unknown op: throw Error `unknown op <op>`.
