# DAG scheduler

`plan(tasks, limit)` -> array of batches (arrays of task ids).

`tasks` is an object: `{ id: [depId, ...], ... }`. `limit` is a positive integer.

Rules:
- A task may only appear in a batch after every dependency appeared in an earlier batch.
- Each batch holds at most `limit` ids.
- Deterministic: among all ready tasks, earlier alphabetical ids go first; a batch is
  filled alphabetically from the ready set before the next batch starts.
- Unknown dependency id: throw Error `unknown dependency <dep> of <id>` (first offender
  in alphabetical order of task id, then dependency order as listed).
- Cycle: throw Error `cycle: a -> b -> ... -> a` — the cycle path starting from the
  alphabetically smallest id in the cycle, following dependency direction
  (each task points to a dependency it waits on), ending back at the start.
- Empty tasks object: return `[]`.
