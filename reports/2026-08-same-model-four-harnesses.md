---
title: Same Model, Four Harnesses
note: 2
date: 2026-08-23
description: Hold GPT-5.6 Sol and the task set constant, change only the coding harness, and the point-estimate cost per solved task moves from $0.36 to $1.37—a 3.77x spread.
price_verified: 2026-08-21
pdf_verified: 2026-08-23
pdf_sources: OpenBench
pdf_method: usage × price
pdf_status: Phase 1 — harness
pdf_tagline: The harness changes the bill.
pdf_hero: SAME MODEL|FOUR HARNESSES
---

# Same Model, Four Harnesses

**GPT-5.6 Sol, one OpenBench release, four coding harnesses.** OpenBench observed the
token usage. Solvency repriced that usage at the model's API rates verified 2026-08-21.
The result isolates a variable that most model calculators leave out entirely.

---

## The short version

Hold the model constant. Hold the 15-task benchmark constant. Change the harness, and the
point-estimate cost per solved task moves from **$0.363 with Pi to $1.370 with Codex**.
That is a **3.77x spread at the same 72.7% pass rate**.

This is not a finding that Pi is universally better than Codex. It is a finding that the
harness changes the bill, even when the name in the model column does not. A useful cost
planner therefore has to price the whole agent architecture—not just the foundation model.

---

## The matched comparison

![Same model, four harness bills](charts/harness.svg)

| Harness | Version | Solved | Pass | $ / attempt | **$ / solved** | vs Pi |
|---|---|---:|---:|---:|---:|---:|
| Pi | 0.80.10 | 32/44 | 72.7% | $0.264 | **$0.363** | 1.00x |
| Claude Code | 2.1.214 | 35/45 | 77.8% | $0.327 | **$0.420** | 1.16x |
| Grok Build | 0.2.103 (89c3d36fb6f1) | 37/45 | 82.2% | $0.491 | **$0.597** | 1.64x |
| Codex | 0.144.5 | 32/44 | 72.7% | $0.997 | **$1.370** | 3.77x |

Source: [OpenBench harness benchmark (MIT)](https://openbench.run/openbench/releases/2026-07-21-gpt56/),
verified 2026-08-23 against the release's digest-sealed
[raw results](https://github.com/minghinmatthewlam/openbench/blob/db193457a3d9128cd4d01fd839c2a890c186c9ac/docs/releases/2026-07-21-gpt56/results.jsonl)
and [provenance](https://github.com/minghinmatthewlam/openbench/blob/db193457a3d9128cd4d01fd839c2a890c186c9ac/docs/releases/2026-07-21-gpt56/provenance.json).

### What the dollar figures are

OpenBench did not publish a metered dollar bill. It published complete proxy-measured input,
cache-read and output token totals for these four arms. Solvency divides each total by the
arm's countable attempts and applies the current GPT-5.6 Sol rates:

| Token class | Price / million | Verified |
|---|---:|---:|
| Uncached input | $5.00 | 2026-08-21 |
| Cached input read | $0.50 | 2026-08-21 |
| Output | $30.00 | 2026-08-21 |

We label this basis **source usage repriced**. No Solvency task tier, loop count, cache-hit
assumption, retry cap or frontier-efficiency multiplier is inside these values.

---

## Finding 1 — A matched pass rate, a 3.77x bill

Pi and Codex each solved 32 of 44 countable attempts: **72.7%**. The success denominator is
therefore identical. Their cost difference comes entirely from the observed token mix.

| Harness | Uncached input / attempt | Cache read / attempt | Output / attempt |
|---|---:|---:|---:|
| Pi | 24,086 | 81,024 | 3,442 |
| Codex | 64,828 | 769,419 | 9,593 |

Codex read roughly **9.5x as many cached tokens per attempt**, consumed **2.7x as many
uncached input tokens**, and produced **2.8x as many output tokens** in this release. Cheap
cache reads softened the dollar impact; they did not erase it.

The model price card cannot reveal this difference. Both rows say GPT-5.6 Sol. The usage
pattern belongs to the model-harness system.

---

## Finding 2 — The cheapest attempt was also the cheapest solve

Pi has the lowest point estimate both per attempt and per solved task. Grok Build has the
highest pass-rate point estimate—82.2%—but its higher token usage leaves it **64% more
expensive per solved task than Pi**.

That does not establish a statistically decisive correctness ranking. With only 44 or 45
countable attempts per arm, the correctness intervals are wide. It does establish the
accounting fact behind each point estimate: modest success-rate differences can be outweighed
by large differences in the number and kind of tokens a harness consumes.

---

## Finding 3 — A build calculator needs roles, not one model picker

Modern agent systems can route different work to different models. The
[Hermes Agent documentation](https://hermes-agent.nousresearch.com/docs/) describes isolated
subagents and support for multiple model providers; its delegation configuration can assign a
different, cheaper model to subagents. A realistic plan might use Claude Fable 5 as an
orchestrator and lower-priced models for parallel workers.

The correct unit to price is a call graph:

```
role_cost = expected_invocations
          × (fresh_input × input_price
             + cached_input × cache_read_price
             + output × output_price)

cost_per_build_attempt = harness_overhead + sum(role_cost)
```

Fallbacks and retries add their expected cost explicitly. For example, a fallback contributes
`P(primary failure) × fallback cost`. Solvency should always report cost per attempted build
and monthly spend. It should report cost per completed build **only** when the user supplies
or Solvency measures an end-to-end system success rate.

Individual model benchmark scores cannot be averaged or multiplied into a credible composed
success rate. Until the system is measured, the honest result is: **success rate not supplied**.

> **Price your own architecture:** [Open the Build Composer](/build-planner). Enter any public,
> internal or custom harness, then mix orchestrator, worker and fallback models role by role.

---

## What this report cannot tell you

- **It is one release.** The four arms cover 15 admission-gated tasks and 44–45 countable
  attempts each. They demonstrate a harness effect; they do not estimate its universal size.
- **It is a point-estimate cost comparison.** Wide correctness intervals prevent strong claims
  about the middle of the pass-rate ranking.
- **The dollars are a reprice, not a subscription invoice.** OpenBench used subscription-backed
  GPT-5.6 Sol access. Solvency applies API token rates so the usage has a common dollar basis.
- **Pi is provisional.** OpenBench flagged Pi for a rerun after a surprising per-task swing.
- **The exclusions matter.** Cursor and OpenCode are absent because their tokens were
  CLI-self-reported rather than proxy-measured. Devin is absent because its split usage was
  incomplete. Including them would mix measurement bases.
- **It says nothing about arbitrary stacks.** A Hermes + Fable + worker-model plan is a
  user-modelled architecture until traces or a controlled benchmark measure that exact system.

---

## Methodology

For every admitted harness arm:

```
cost_per_attempt =
  (uncached_input_total / countable_attempts) × $5 / 1,000,000
  + (cache_read_total / countable_attempts) × $0.50 / 1,000,000
  + (output_total / countable_attempts) × $30 / 1,000,000

cost_per_solved_task = cost_per_attempt / (solved / countable_attempts)
```

The source's infrastructure and rate-limited failures remain excluded exactly as its
methodology specifies. The four harness rows are isolated from Solvency's general model
leaderboard and are never compared across benchmark populations.

### Reproduce this

The table and chart regenerate from the repository's canonical data:

```
npm test
npm run charts
npm run charts:light
node scripts/render-pdf.ts reports/2026-08-same-model-four-harnesses.md
```

The report test parses every published row and re-derives its pass rate, per-attempt cost,
per-solved cost and relative multiplier through the same engine used by the website. OpenBench
source data was verified 2026-08-23; GPT-5.6 Sol API prices were verified 2026-08-21, so the
source and price do not appear fresher than they are.
