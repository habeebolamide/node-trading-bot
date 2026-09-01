# Change: m4-risk-agent

> **COMPLETED 2026-09-01 — M4 (all 5 changes) is done.** Grew `packages/agents/common/`:
> - `risk-checks.ts` — pure `evaluatePerpRisk` / `evaluateMemecoinRisk`. Perp checks: S/R
>   proximity against direction (0.3×ATR), funding percentile extremes (>95 / <5), OI >90
>   percentile, ATR ratio >2.0, price extension >2 ATR from EMA(50). Memecoin checks: token
>   age <5m, position notional >50% of pool-share cap, wallet below universe median.
>   Aggregation: 0→LOW · 1→MEDIUM · 2→MEDIUM_HIGH · 3→HIGH · 4+→INVALIDATED.
> - `risk-agent.ts` — `createRiskAgent(deps)` wraps injectable input loaders + persist +
>   state transition. Consumes `SIGNAL_CREATED`, skips non-ACTIVE signals idempotently,
>   writes `signal_risk` on every verdict, transitions the Signal to INVALIDATED and
>   publishes `SIGNAL_INVALIDATED` when the level warrants it.
>
> Schema migration 0008 (`signal_risk`) applied.
>
> **Verified:** typecheck green; **239/242 tests pass** (3 opt-in live). 15 new tests:
> pure risk-checks (12 — perp: 6 individual checks + aggregation → MEDIUM_HIGH → INVALIDATED;
> memecoin: 4 individual + aggregation) + live-Postgres integration (3 — LOW keeps ACTIVE,
> INVALIDATED flips state + publishes event, non-ACTIVE skipped).
>
> **Deviations from spec:** none material. Input loaders (`loadPerpInputs` / `loadMemecoinInputs`)
> are injectable at wiring time — production will build these from M1 buffers + M4-signal-engine
> stored features; MVP-tests inject snapshots directly. Rolling 30-day S/R and funding/OI
> percentile computation is left to the wiring layer (M1's `fundingRate` / `openInterest` tables
> already have the raw history).
>
> **M4 wrap-up:** all 14 Analysis Agents + 5 Features per Part IV §40 exist. TradingAgent CRUD
> + versioned ScoringConfig, deterministic Signal Engine with §36 lifecycle, memecoin roster +
> Token Risk hard veto, perp roster + Volume + Historical Edge stub, and Risk Agent gate — the
> whole "signal generation → post-veto" chain works end-to-end. Ready for M5 (Brain memories
> populating from resolved outcomes) and M6 (Predictions + Paper Engine consuming signals).

**Status:** COMPLETED — archived
**Original status:** PROPOSED (scoping)
**Milestone:** M4 — Agent Swarm (§30), change 5 of 5 (final)
**Implements:** §40.12 Risk Agent (post-aggregation veto, perp + memecoin variants), §36
`INVALIDATED` state transition. §33 rule 12.
**Depends on:** m4-signal-engine (signal.created is the trigger), m4-memecoin-agents,
m4-perp-agents.

## Why

Risk sits **outside** the composite (no weight) — its job is to try to invalidate an
otherwise-good-looking signal by checking dangerous market conditions the individual agents
don't cover on their own (S/R proximity against direction, funding/OI/vol extremity, price
extension, memecoin freshness / pool-share caps). It fires last, before any downstream
consumer (Judge, Trade Planner, Prediction) sees the signal.

Change 5 completes M4 by wiring this gate — after which the whole "SIGNAL created → optionally
INVALIDATED" flow is deterministic end-to-end.

## What changes

`packages/agents` grows `common/risk-agent.ts`:

- **`risk-agent.ts`** — EVENT trigger on `signal.created` (published by change 2). Runs the
  domain-appropriate check set (perp vs memecoin), aggregates flags into `risk_level ∈
  {LOW | MEDIUM | MEDIUM_HIGH | HIGH | INVALIDATED}`.
- On `INVALIDATED` → transition the signal to `INVALIDATED` (§36) and publish
  `signal.invalidated`. On other levels → attach `risk_level` + `risk_flags` to the signal as
  narrative context (via a small `signal_risk` join row), no state change.

Perp checks (§40.12):
- **S/R proximity** — entry within 0.3 × ATR of a major level *against* trade direction.
- **Funding extremity** — funding > 95th percentile against direction.
- **OI extremity** — OI at 90th percentile of rolling → moderate risk.
- **Volatility extremity** — ATR ratio > 2.0 → HIGH_VOL context.
- **Price extension** — price > 2 ATR from EMA(50).

Memecoin checks:
- **Extreme freshness** — token < 5 min old.
- **Position notional > 50% of `maxPoolShare` limit** (thin fill risk).
- **Wallet quality below universe median** → risk flag.

Schema (migration 0008):
- `signal_risk` — `{ signal_id PK, risk_level, risk_flags text[], evaluated_at, agent_version }`.

Also: an `AgentPerformance` record for the Risk Agent (not in the composite, but still
tracked — its accuracy metric is "how often did INVALIDATED signals turn out to have been
correctly invalidated?" measured via M7 shadow trades once Judge exists).

## What this change does NOT do

- **No STAND ASIDE shadow trade** — that requires the Judge (M7). At M4, `INVALIDATED` simply
  prevents the signal from progressing to Prediction (M6).
- **No Prediction creation** — the Risk Agent gates whether a signal is even eligible;
  Prediction lifecycle is M6.
- **No Trade Planner** — M6.
- Risk Agent shadow-trade evaluation (§23 STAND_ASIDE) — M7.

## Resolved solo (flag)

- Support/Resistance computation for perp uses rolling 30-candle high/low bands per primary TF
  — a simple structural approximation, not a full swing-detector. Full pattern detection is
  deferred (§7 "Setup/Pattern Agent — deferred").
- Memecoin S/R skipped — not meaningful for tokens minutes old (§40.10 edge case handling).

## M4 wrap-up (after this change)

- All 14 Analysis Agents + 5 features live per Part IV §40.
- Signal Scoring Engine composes them per config, Risk Agent gates.
- Ready for M5 (Brain: BrainSetupMemory populates from signal outcomes once M6's Predictions
  land) and M6 (Predictions/Paper Engine consume signals).
