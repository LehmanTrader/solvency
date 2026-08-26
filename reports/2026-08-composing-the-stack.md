---
title: Composing the Stack
note: 4
date: 2026-08-26
description: One workload, three ways to staff it. Give every role to a frontier model and the template month bills $249.00; let the frontier model conduct while a value model types and it bills $36.16 — a 6.9x spread from composition alone.
price_verified: 2026-08-21
pdf_verified: 2026-08-26
pdf_sources: Solvency Build Composer engine
pdf_method: role usage × verified price
pdf_status: Modelled — template assumptions
pdf_tagline: The org chart is a price sheet.
pdf_hero: COMPOSING|THE STACK
---

# Composing the Stack

**Why a build calculator has roles, and what choosing them well is worth.** Notes
[01](/research/cost-per-solved-task) and [02](/research/same-model-four-harnesses) established
two facts the model-picker view of the world cannot hold: the same model's bill moves several-fold
with the harness around it, and per-token price barely predicts per-task cost. This note takes the
next step. Modern agent systems are not one model in a loop — they are an **org chart**: an
orchestrator that reads, decides and delegates; workers that produce the bulk of the tokens; a
fallback that catches what the workers drop. Each seat can be staffed by a different model at a
different verified price. The org chart is a price sheet.

Every figure below is computed by the same engine that runs the
[Build Composer](/build-planner) — role usage × verified catalog prices — using the Composer's
own shipped template assumptions, and is re-derived by test from that engine. Nothing here is
measured; section "What this note cannot tell you" says exactly what that means.

---

## The short version

Take one fixed workload — 200 attempted builds a month, each build one orchestrator call plus
three worker calls and 0.3 expected fallback calls, at the Composer's template token profile.
Staff it three ways:

| Composition | Orchestrator | Workers | Fallback | $ / attempt | $ / month | vs composed |
|---|---|---|---|---:|---:|---:|
| All-frontier monolith | Claude Fable 5 | Claude Fable 5 | Claude Fable 5 | $1.2450 | $249.00 | 6.9x |
| **Composed** | Claude Fable 5 | DeepSeek V4 Flash | Claude Opus 5 | **$0.1808** | **$36.16** | 1.0x |
| All-value monolith | DeepSeek V4 Flash | DeepSeek V4 Flash | DeepSeek V4 Flash | $0.0455 | $9.11 | 0.25x |

The composed stack keeps a frontier model in the one seat where judgment concentrates — and
pays a frontier price for exactly one call per build. It hands the token volume to a model
priced far below it per token, and prices the safety net explicitly instead of pretending
failures are free. Same workload, same token counts, same verified prices: **6.9x apart on
composition alone.**

This is the benefit of having a composer at all. A single-model picker cannot express the
decision that actually moves this bill.

---

## Where the money goes

Inside the composed plan, the cost share by seat is not what the call counts suggest:

| Seat | Model | Calls / build | $ / build | Share |
|---|---|---:|---:|---:|
| Lead orchestrator | Claude Fable 5 | 1 | $0.0900 | 50% |
| Worker pool | DeepSeek V4 Flash | 3 | $0.0383 | 21% |
| Fallback route | Claude Opus 5 | 0.3 | $0.0525 | 29% |

Half the composed bill is the **single** orchestrator call — one 6,000-token read and a
600-token instruction at frontier rates. The three worker calls, carrying ten times the
orchestrator's token volume, cost less than half as much. That inversion is the whole argument:
**price concentrates where judgment concentrates, not where the tokens are** — so put your
dearest model where one call decides everything, and never where three calls type everything.

The fallback line deserves its own sentence. At 0.3 expected invocations it books 29% of the
bill, because a fallback exists precisely to be a stronger, dearer model than the workers it
backs. A plan that omits it does not have a cheaper architecture; it has an unpriced risk.

---

## How to choose a composition

Four rules fall straight out of the arithmetic above and the two earlier notes:

1. **Staff the top seat for judgment, at minimum call count.** The orchestrator's share is set
   by its per-call price times very few calls. This is where a frontier model is cheap.
2. **Staff the volume seats for cost per solved task, not per token.** Workers carry the token
   volume, so their rate multiplies. Note 01's measured table is the shopping list — and it is
   measured, so a cheap model that cannot close tasks shows up there, priced honestly.
3. **Price the fallback explicitly.** `P(primary failure) × fallback cost` is a real line item.
   Choosing the fallback is choosing what a worker failure costs you.
4. **Count the harness as a seat.** Note 02 measured the same model billing 3.77x apart across
   harnesses on one population, and a 1.9–2.8x per-model spread on an independent one. The
   scaffold takes a salary too; the Composer's harness fields are where it goes.

> **Price your own org chart:** [open the Build Composer](/build-planner). Two roles at catalog
> list prices are free; name any harness, mix any models, and every number is tagged with where
> it came from.

---

## What this note cannot tell you

- **These are modelled figures, not measurements.** The token profile per role is the
  Composer's template assumption (6,000 in / 600 out for the orchestrator call; 20,000 in /
  3,000 out for worker and fallback calls; zero cache traffic), and real workloads differ. The
  point estimates above will not survive contact with your traces; the *structure* — judgment
  seats cheap at low call counts, volume seats dominated by rate — will.
- **No completed-build price appears here, deliberately.** Cost per completed build requires an
  end-to-end system success rate, and composing one from individual model benchmark scores is
  not credible. Until a system is measured, the honest per-completed figure is: **success rate
  not supplied**. The Composer holds the same line.
- **Prices move.** The catalog prices behind these quotes carry their own verification dates
  (Claude and DeepSeek rates verified 2026-08-21); the engine re-quotes at current catalog
  state, and the test re-derives this note from the same call.
- **Cache traffic is set to zero in the template.** Real agent stacks read heavily from cache;
  Note 02's token tables show cache reads dominating input volume. A cache-aware profile lowers
  every figure here — by more for the frontier monolith than for the composed stack.

---

## Methodology

For each plan: `quoteBuildPlan()` — the Build Composer's engine, `build-cost-v1` — over the
same `BuildPlanV1`: 200 attempted builds/month, harness fixed costs $0, three roles with the
template usage above, models at verified catalog list prices, no overrides, no success rate.

```
role_cost   = expected_invocations × (fresh_input × input_price + output × output_price)
per_attempt = Σ role_cost          monthly = per_attempt × attempted_builds
```

### Reproduce this

```
npm test          # test/composer-report.test.ts re-derives every figure above
```

The report test builds the three plans, quotes them through the engine used by the website,
and fails if any published dollar figure, share or ratio drifts from the engine's output.
