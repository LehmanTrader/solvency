# Solvency Bench

**The measurement engine behind [solvency.dev](https://solvency.dev): what a solved
software task actually costs, on every model worth running.**

The AI industry prices models by the token. Nobody ships tokens. Solvency's thesis —
demonstrated across three published research notes — is that per-token price predicts almost
nothing about the cost of *finished work*: measured per-solved-task costs span **145x** across
current models, and the same model's bill moves **3.8x** with the scaffold around it. Solvency
Bench is the instrument that produces those numbers first-hand: an open task suite, a
deterministic grader, and a budget-guarded runner that turns any model into a
cost-per-solved-task figure with its provenance attached.

```
                 ┌─────────────────────────────────────────────────┐
                 │                SOLVENCY BENCH                   │
                 │                                                 │
  model ────────▶│  task suite ─▶ sandboxed run ─▶ deterministic   │────▶ pass rate
  (API key or    │  (open,        (docker,         grader          │      $ / task
  local harness  │   versioned)    network-less)   (hidden tests,  │      $ / solved task
  subscription)  │                                 injected after) │      + full provenance
                 └─────────────────────────────────────────────────┘
```

---

## Why this is credible

1. **Deterministic grading.** Every task ships with hidden tests. No LLM judges, no rubric
   scoring, no partial credit — an attempt passes or it does not, and the grader that decides
   is committed to this repository.
2. **Leak-proof by construction.** Hidden tests are injected into the workspace only *after*
   the agent finishes (the same discipline WildClawBench documents). The model can read the
   task's visible spec and tests; it can never read the answer key.
3. **Self-verifying suite.** `--selftest` proves, for every task, that the committed reference
   solution passes the hidden tests and the untouched fixture fails them — before a single
   paid call. A grader that can't tell solved from unsolved never runs.
4. **Fail-closed everywhere.** No verified price → no run. No usage accounting from a
   harness → the attempt is excluded, not guessed. No container runtime → agentic tasks
   refuse to execute model-written code.
5. **Spend can't run away.** A run must be estimated before it can be started (the GUI's Run
   button is disabled until the exact selection is priced); a hard budget cap aborts mid-run;
   completed attempts are journaled and never re-billed on resume; temperature 0 and hard
   `max_tokens` caps throughout.
6. **Populations never mix.** Each protocol and harness family is its own labeled group, with
   its own run dates and price citations. Nothing here is ever averaged into, ranked against,
   or charted beside third-party benchmarks or a different protocol's numbers.

---

## The suites

| Suite | Protocol | What it measures | Tasks | Grading |
|---|---|---|---|---|
| **Single-turn** | `solvency-bench-v0` | Raw model correctness floor: one prompt, one reply, no scaffold | 12 self-contained functions | Hidden vectors, subprocess-isolated |
| **Agentic** | `solvency-bench-a1` | Real software work: navigate a repo, change code, run tests | 8 repo fixtures (growing → 30 → 120) | Hidden test suites, injected post-run, executed in a network-less container |

Agentic tasks are small but real repositories — an off-by-one in pagination, a sliding-window
rate limiter to implement from spec, a concurrency bug the grader catches by measuring actual
overlap, a CLI graded by executing it. Each fixture contains a README contract, source, and
visible tests; each hidden suite is the contract, enforced.

### Statistical honesty

At 3 trials per task, task count sets the confidence interval on a pass rate:

| Tasks | 95% CI (worst case) | Tier |
|---:|---:|---|
| 12 | ±27pp | smoke signal |
| 30 | ±10pp | screening |
| 120 | ±5pp | publishable leaderboard |
| 326 | ±3pp | parity with the largest commercial index |

Published Solvency numbers state their tier. A ±27pp smoke run is never dressed up as a
leaderboard.

---

## Two harness populations — and why

An agent's bill is a property of the **model + harness pair**: the scaffold decides the turns
taken, the context stuffed, the cache traffic, the retries. Solvency measures both of the
populations that matter, and never blends them:

**Reference population (`solvency-loop`).** A deliberately minimal, model-agnostic tool loop —
list/read/write/run-tests — drives *every* model identically through the agentic suite. Equal
scaffold, equal conditions: this is the apples-to-apples cross-model comparison, paid per
token through one metered API account.

**Native population (subscription harnesses).** The same tasks driven through the harness each
frontier model actually ships in — Claude Code, Codex CLI — on locally-authenticated
subscription logins. Token usage is read from the harness's own accounting (cache reads and
writes included) and **repriced at verified API list prices**; the subscription's flat fee
never enters the math. This is the `subscription_usage_repriced` basis, and it has published
precedent: Solvency's Research Note 02 is built on exactly this shape of data.

*The caveat, stated on every native row:* a native-harness number reflects the model inside
its own tuned scaffold and is not comparable with the reference population. It is also,
deliberately, the most honest answer to the question users actually have — nobody drives a
frontier model without its harness and plan. As grant funding lands, frontier models join the
reference population at metered API rates, and the two views sit side by side, labeled.

---

## Provenance of every number

Each run writes `results/<run-id>/results.jsonl` (one journal line per attempt: tokens, cost,
grader verdict, wall time) and `summary.json` carrying: protocol id and hash (task list ×
trials × caps), model slug, harness name + version, the exact prices used with their
verification dates, countable vs infra-excluded attempts, pass rate, $/task, $/solved, spend
against cap, run date, and the isolation statement. A number that can't cite this record
doesn't ship.

---

## Quickstart

```bash
# free — verify every grader before spending anything
npm run bench:selftest                      # single-turn suite
node bench/agentic/loop.mjs --selftest      # agentic suite

# the GUI (also on the Desktop as "Solvency Bench.app")
npm run bench:gui                           # http://localhost:4871

# metered API runs (any OpenRouter model)
echo 'export OPENROUTER_API_KEY=sk-or-...' > ~/.solvency-bench-env
node bench/runner.mjs --model z-ai/glm-5.3-flash --trials 3 --budget 5
OPENROUTER_API_KEY=... node bench/agentic/loop.mjs --model z-ai/glm-5.3-flash --budget 2

# subscription harness runs (local logins; zero marginal token cost)
node bench/runner.mjs --model claude-opus-5 --harness claude-code --trials 3
node bench/runner.mjs --model gpt-5.6-sol  --harness codex       --trials 3
```

Agentic model runs require Docker (task code executes with `--network none`, memory- and
CPU-capped); graders self-verify without it.

### What it costs

Measured ceilings for the single-turn suite (36 attempts, completion priced at the full
token cap — real bills land under these): GLM-5.3-Flash **$0.015** · DeepSeek V4 Flash
**$0.079** · Kimi K3 **$0.88**. Agentic attempts run 10–100x that, which is still cents-to-
dollars for value-tier models; frontier agentic runs ride subscription logins at zero marginal
cost until the reference-population budget unlocks them. Current operating envelope:
**$100/month metered spend**, operator-approved 2026-08-26.

---

## Roadmap

- **Suite growth:** agentic tasks 8 → 30 (screening tier) → 120 (publishable tier), with the
  category mix documented and versioned; every expansion re-runs `--selftest` in CI.
- **Harness adapters:** Gemini CLI and Grok harness adapters join Claude Code and Codex as
  their local auth paths are verified; any harness that cannot report usage is excluded
  fail-closed.
- **Reference-population frontier runs:** metered API runs of frontier models through
  `solvency-loop`, unlocked by grant funding — the direct, vendor-independent complement to
  the native population.
- **Site ingestion:** bench results flow into solvency.dev's leaderboard as their own group,
  through the same reviewed pipeline and isolation rules as every existing source — and into
  the CC-BY export, because these numbers are Solvency's own.

## License and independence

The suite, graders, and runner are Solvency's own work. Solvency takes no money from model
vendors; benchmark spend is funded by Pro subscriptions and grants. Results produced by this
instrument are published under CC-BY as first-party measurements.
