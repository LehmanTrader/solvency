# Solvency Bench — task-suite + grader (solvency-bench-v0)

**Purpose.** Solvency's own measurement infrastructure: the missing piece that
turns "how cheap would it be to benchmark X?" from a scoping doc into a
button. Phase-3 groundwork (own measured runs; the durable fix for the AA
licensing problem).

## Protocol v0 — single-turn code tasks

- 12 self-contained JavaScript tasks (`bench/tasks/<id>/`), each: a prompt
  asking for ONE exported function, a deterministic checker (`check.mjs`)
  with hidden test vectors, and a reference solution the self-test validates.
- One API call per attempt (single-turn — this protocol measures single-turn
  code correctness, NOT agentic harness behaviour; that is Phase B).
- temperature 0, max_tokens capped (default 1600), 3 trials per task.
- The model's reply must contain a fenced code block exporting the named
  function; the last fenced block wins. No retry on malformed output — a
  reply the grader cannot extract is a failed attempt (that inability is
  signal, not noise).
- Checker runs in a throwaway temp dir under a hard timeout; exit 0 = pass.

## Scoring

- pass rate  = passing attempts / countable attempts
- $/task     = mean attempt cost (usage tokens × verified catalog prices)
- $/solved   = $/task ÷ pass rate  (MISSING when pass rate is 0)
- Attempts that fail on infra (network, our bug) are excluded and counted
  separately — same rule OpenBench applies.

## Guards (why it "doesn't make mistakes or waste tokens")

1. **Dry-run first.** The GUI's Run button stays disabled until an estimate
   has been computed for the exact model+tasks+trials selection.
2. **Hard budget cap.** The run aborts the moment recorded spend crosses the
   cap you set. Default $5.
3. **max_tokens cap** on every call; temperature 0; no streaming.
4. **Resume, never repeat.** Every attempt is appended to
   `results/<run>/results.jsonl` as it lands; re-running the same run id
   skips completed attempts.
5. **Fail-closed pricing.** A model whose OpenRouter slug cannot be matched
   to a catalog row with verified prices refuses to run unless explicit
   --price-in/--price-out are supplied; the run record stores which was used.
6. **Self-test.** `node bench/runner.mjs --selftest` runs every checker
   against its reference solution (must pass) and against a stub (must
   fail) before any paid run.

## Provenance and isolation

- Output rows carry `benchmark: "solvency-bench-v0"`, `cost_basis:
  "measured_by_solvency"`, run date, model slug, prices used (with their
  verification dates), protocol hash (task list + trials + max_tokens).
- This population is its OWN group. Never merged, compared or charted
  against AA / OpenBench / WildClawBench numbers — the comparability rule
  applies here exactly as everywhere else on the site. Ingestion into
  data/benchmarks.json is a separate, reviewed step, not automatic.

## Running

    OPENROUTER_API_KEY=... npm run bench:gui     # http://localhost:4871
    node bench/runner.mjs --selftest             # free, no key needed
    node bench/runner.mjs --model z-ai/glm-5.3-flash --trials 3 --budget 5

## Phase B (not built)

Agentic extension: drive real harnesses (Hermes serve / Claude Code -p /
Codex exec) against multi-step tasks with environment checkers — the
infrastructure gap the harness-expansion doc priced. v0's grader, budget
guard, resume and provenance layers carry over.

## Phase B — SHIPPED: subscription harness runs (solvency-bench-v0h)

Operator insight, 2026-08-26: the frontier models are already paid for via
Claude Code and Codex subscriptions, both harnesses report their own token
usage, and usage × verified API price is a benchmark number. Precedent:
Note 02's OpenBench population is exactly this shape (subscription-backed
runs, usage repriced at API rates, basis `source_usage_repriced`).

    node bench/runner.mjs --model claude-opus-5   --harness claude-code --trials 3
    node bench/runner.mjs --model gpt-5.6-sol     --harness codex       --trials 3

- Basis: `subscription_usage_repriced` — tokens measured from the harness's
  own accounting; dollars are catalog list prices with their verification
  dates; the subscription's flat fee never enters the math.
- What it measures: the MODEL+HARNESS pair, recorded with harness name and
  version — never presented as the model alone.
- Cache reads priced at the cached-input rate; cache writes at the uncached
  input rate, stated in the record (write premiums not modelled).
- An attempt whose usage cannot be read from the harness is excluded
  fail-closed — no usage, no reprice, no number.
- Practical notes: subscription rate windows throttle throughput (runs
  resume, guard 4); results derive from personal-plan access the way
  OpenBench's did, and the run record says so.
