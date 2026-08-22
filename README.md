# Solvency

Cost per solved task for AI coding models.

**Prime directive:** every number displayed anywhere carries a `last_verified` date and a
source URL. A stale-but-labeled number is fine. An unlabeled number is a bug.

## Status

Phase 1 shipped and live at [solvency.dev](https://solvency.dev) (2026-08-22). Research Note 01
(cost per solved task, August 2026), a calculator, 25 model pages, 300 comparison pages, a CC-BY
pricing export, an embed widget and a changelog. Every push to `main` runs the test suite and
deploys via GitHub Actions to Cloudflare Pages. Phase 3 (Solvency's own measured runs) is not
started.

```
npm test          # 38 tests; the report tests re-derive every published table
npm run coverage  # source, coverage and staleness audit
npm run table     # headline table
npm run watch     # checks each recorded price still appears on its source page; never writes
npm run site      # builds the Astro site in site/
```

## Method

```
cost_per_solved_task = cost_per_attempt / pass_rate
```

Solvency needs only `pass_rate` from a benchmark. Cost comes from one of two clearly
separated bases, which are labeled everywhere and **never averaged together**:

| Basis | Cost comes from | Assumptions applied |
|---|---|---|
| `measured_by_source` | A per-task cost the benchmark source actually observed | **None** |
| `modelled_by_solvency` | Loop model x current verified prices | Loop count, per-loop tokens, frontier-efficiency |

Where a source publishes measured cost, the loop model is bypassed outright — no loop count,
no per-loop token figure, and no frontier-efficiency multiplier touches the number. Tests
assert that changing those assumptions cannot move a measured row.

Three retry variants are computed:

| Variant | Formula | Note |
|---|---|---|
| `naive` | `cost / p` | Unlimited independent retries. **Lead with this.** |
| `capped` | `min(1/p, K) x cost + residual x (1-p)^K` | Only with a real labour rate set |
| `truncatedGeometric` | `(E[N] x cost + (1-p)^K x residual) / P(solved)` | Rigorous truncated geometric |

Two proven results:

1. With `residual_human_cost_usd = 0`, `truncatedGeometric` reduces **exactly** to `naive`.
2. `capped` **understates** cost for low pass rates. At p = 0.2 it bills 3 attempts instead of
   5 and books nothing for the 51.2% of tasks still unsolved — it makes weak models look cheap.

## Sources

In preference order — fewest Solvency assumptions first, then freshness.

| Source | Tasks | Covers 2026 models | Publishes cost | Basis |
|---|---|---|---|---|
| [Artificial Analysis Coding Agent Index v1.4](https://artificialanalysis.ai/agents/coding-agents) | 326 | **Yes** | Yes, measured | `measured_by_source` |
| [Scale SEAL — SWE-bench Pro](https://labs.scale.com/leaderboard/swe_bench_pro_public) | 1,865 | **Yes** | Not captured | `modelled_by_solvency` |
| [Aider polyglot](https://aider.chat/docs/leaderboards/) | 225 | No | Yes, historical | `historical_at_run_date` |

Evaluated and rejected: **HAL** (Princeton) — right shape, 26,597 rollouts with centralized
cost tracking, but the project has paused updating and its newest entries are Aug–Sep 2025.
**llm-stats.com** — human-verification wall, and a mirror of an older index version.

### Redistribution

All ingested benchmark data is third-party and carries `redistributable: false`. It is cited
and linked, never republished. **Nothing here may enter the CC-BY `/data` export** — only
Solvency's own Phase 3 measured runs are published as open data. Enforced by test.

### AA caveat that matters

AA rows are **harness + model combinations**, not bare models. "Claude Code + Opus 5" is not a
property of Opus 5; AA's own harness comparison shows the harness materially moves the score.
Solvency carries the harness on every row and must never present these as model properties.

AA's index is read from the published chart as a 0–100 composite. `pass_rate = index / 100` is
an **interpretation**, flagged per row as `pass_rate_derivation`.

## Findings so far

**1. Per-token price and per-task cost diverge violently.** DeepSeek V4 Flash is ~11x cheaper
than Claude Opus 5 on input tokens and ~19x cheaper on output tokens — but **100x cheaper per
solved task** ($0.12 vs $12.01), because it burns far fewer tokens and less wall time to close
each task. Per-token pricing, which is what every pricing page publishes and every calculator
compares, is close to useless as a cost predictor. This is the product thesis.

**2. Near-identical capability, 2.6x the price.** Grok 4.5 (64% index, $3.81/solved) against
GPT-5.6 Sol (65% index, $9.88/solved). One index point costs $6 per solved task.

**3. The benchmark everyone cites is 12–16 months stale.** Aider polyglot's raw YAML contains
zero 2026 entries; newest is 2025-10-03, and its top entries are retired models. HAL, the
other cost-aware leaderboard, paused updating in Aug–Sep 2025. The current data lives in one
aggregator most cost calculators ignore.

**4. Coverage is still partial and stated as such.** 8 of 16 current models have a pass rate.
The other 8 render `MISSING`, never imputed. Two well-known models (Grok 4, DeepSeek V3.2)
have pass rates but no current list price — their providers now price only successors.

## Data integrity rules

- Prices web-verified at write time. Prices recalled from model memory are never used.
- Missing is `null` and renders as `MISSING`. A missing cache price is never treated as $0.
- Modelled parameters carry `kind: "assumption"` with provenance and are overridable.
- Prompt-length-tiered, promotional, and time-of-day prices record the tier used and state
  the alternative in `pricing_notes`.
- Approximate model-identity matches are flagged with `match_confidence` and a note.

## Assumption health

`frontier_efficiency` (0.6x loops on heavy tasks) is **demoted to fallback**. It has no
published source, and it now applies only to rows with no measured cost. Set it to 1.0 to see
unadjusted results. Phase 3 replaces it outright.

## METR caveat

A METR randomized controlled trial found experienced open-source developers were **19% slower**
using early-2025 AI tools while believing they were **20% faster** (they expected 24%).
Solvency measures cost per benchmark-solved task, not developer throughput.
