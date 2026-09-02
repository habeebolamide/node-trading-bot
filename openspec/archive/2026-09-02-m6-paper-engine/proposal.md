# Change: m6-paper-engine

> **COMPLETED 2026-09-02** (with a scoped-out follow-up — see below). New
> `packages/paper-engine` (`@tip/paper-engine`) + migration 0013.
>
> - `fills/perp.ts` — flat bps (default 5.5 per Task 7) + one tick; LONG pays up, SHORT pays down.
> - `fills/memecoin.ts` — constant-product AMM against actual reserves. Return type
>   `FillResult = FILL | NO_FILL` so a caller CANNOT ignore rule 25; a NO_FILL result has no
>   `price` field at all, structurally. **Depth-aware pricing works when reserves are supplied.**
> - `exit.ts` — 5-condition precedence per Part II §10 (`STOP_LOSS > WALLET_EXIT > LADDER >
>   TAKE_PROFIT > HORIZON`), `crossedLadderRungs` for gap-up semantics (only rungs actually
>   crossed, in order, at their crossing prices), `walletExitAccumulator` for cluster-weighted
>   exit signal, `applyPostTakeAction` (breakeven / trail-up-only).
> - `position.ts` — `openPosition` (`unique(prediction_id)` at DB level), `applyLadderRung`
>   (partial close, ladder-state, stop adjust, PnL, portfolio cash), **`closeRemaining` — THE
>   single full-close primitive** so "close 100% of what is CURRENTLY held" (Part II §10) is a
>   structural property, not a discipline; `updateExcursion` for MFE/MAE; `openPositionCount`.
> - `portfolio.ts` — cash, equity, peak equity, max drawdown (deepest fractional trough below
>   peak; never resets), realized P&L.
> - Migration 0013: `paper_portfolio`, `paper_position` (unique prediction_id, both clocks per
>   §20), `paper_position_fill` (both clocks), `paper_position_originating_wallet`.
>
> **Verified:** typecheck green; **469/472 tests pass** (3 opt-in live) across 3 consecutive
> full-suite runs, 32 new — pure fills (10, incl. rule-25 NO_FILL preserving no `price` field),
> pure exit engine (13, incl. precedence + gap-up ladder + trail-up-only), live-DB position
> integration (9, incl. concurrent double-open rejected by `unique(prediction_id)`, ladder-then-
> close preserving no-negative-size, drawdown arithmetic, MFE/MAE, idempotent re-close).
>
> **TWO THINGS DEFERRED TO A FOLLOW-UP CHANGE (m6-tick-monitor):**
>
> 1. **The tick monitor itself** — the §10 lightweight consumer that never runs the full
>    pipeline. This change ships the DETERMINISTIC `evalTick(...)` primitive it calls, fully
>    unit-tested, so the follow-up is event plumbing (Bybit tick feed for perp; memecoin's
>    "each observed swap on the mint IS the tick" binding) rather than logic. Splitting keeps
>    this change's diff reviewable.
> 2. **Detection-lag falling-market close test** — the two-clock recording is verified against a
>    real DB row (both `openedAtEvent`/`openedAtProcessing` and every fill's clocks are
>    persisted). The falling-market assertion needs the tick monitor to drive it; the engine
>    change itself is complete.
>
> **RULE 25 AT THE PROVIDER BOUNDARY — task 2.0 finding.** §20 makes depth-aware memecoin fills
> a HARD provider requirement and forbids last-price fallbacks. The current M1 Helius parser
> (`packages/ingestion/src/helius/parse.ts`) projects only the wallet's `tokenTransfers`;
> enhanced-tx returns richer data — `accountData[].tokenBalanceChanges`, which for an AMM swap
> covers the pool's own token accounts — but we do not parse it yet. **Consequence stated
> plainly:** until a follow-up change extends the Helius parser to derive reserves at detection
> time, the memecoin paper engine will `NO_FILL` on every entry. That is rule 25 working
> (§20's own answer when reserves are absent), not a bug — but it is a SCOPE QUESTION for the
> operator, because the only alternative §20 explicitly forbids by name is the last-price
> fallback. Recorded in-code alongside the fill module so the constraint is visible where it
> matters.
>
> **Cross-portfolio risk gates** (`dailyLossLimit`, `maxCorrelatedExposure`) are the M7+
> orchestrator's job — the position primitives cannot enforce cross-portfolio limits alone, and
> pretending they can would create a false-safety guard. `maxConcurrentPositions` is checkable
> by `openPositionCount`; the caller enforces it.

**Status:** COMPLETED — archived (with tick monitor scoped to a follow-up)
**Original status:** PROPOSED (scoping)
**Milestone:** M6 (change 3 of 6) — **the largest change in the milestone**
**Implements:** §20 Paper Engine (fill model, detection-lag pricing, TP/SL detection) ·
§21 (holding period, both clocks) · Part II §10 memecoin exit precedence + profit ladder +
`walletExitThreshold` · §13 (`PaperPortfolio`, `PaperPosition`, `PaperPositionFill`,
`PaperPositionOriginatingWallet`) · §10 tick monitor · §33 rules 20, 25, 8

## What's changing

"What would have happened if we took it?" — virtual cash, positions, fills, and the exit engine.

1. **Portfolios and positions** — virtual cash, unrealized/realized P&L, drawdown, and the risk
   constraints from `ScoringConfig` (`maxConcurrentPositions`, `dailyLossLimit`,
   `maxCorrelatedExposure`).
2. **Domain-split fill model** (§20 — "the biggest hole in making backtest/paper results
   trustworthy"):
   - **Perp** — flat bps: fill = last ± a small fixed bps. Major perp books are deep enough that
     a paper position doesn't move them.
   - **Memecoin** — **depth-aware constant-product AMM math against actual reserves**. A flat bps
     or last-price fill is explicitly *not acceptable and must not be used*: it "will manufacture
     returns that don't survive contact with a real order book," undermining the §32 success
     criterion for the very domain the roadmap front-loads. **If reserves are unavailable the
     position does not fill** (Part II §10) — rule 25, never fabricate.
3. **Detection-lag pricing** (§20) — memecoin fills are priced at the pool state **when the system
   could first have acted** (detection/processing time), not at the wallet's on-chain action time.
   Pricing at action time credits a fill the system could never have gotten. **Both clocks are
   recorded on every fill and close**, so reaction lag is a measured number rather than a guess.
4. **The exit engine** — Part II §10's five conditions in strict precedence:
   `STOP LOSS → WALLET EXIT → PROFIT LADDER → TAKE PROFIT → HORIZON EXPIRY`, across two
   deliberately different latency paths (tick monitor vs. webhook pipeline).
5. **Profit ladder** — rungs fire in order, each once; a gap-up hits only crossed rungs; cumulative
   `sellFraction` ≤ 1.0 validated at config-write (M4 already does this); `postTakeAction` supports
   `move_stop_to_breakeven` and `trail_stop_pct`.
6. **`walletExitThreshold` accumulator** — fires on cluster *weight* sold, not wallet count, using
   the same funder-cluster dedup as convergence (§5), so one funder dumping through five addresses
   is one exit, not five.
7. **Tick monitor** (§10, §20) — a lightweight consumer that never runs the full pipeline, watching
   open positions against the live feed and closing at the exact crossing tick.

## Why this is the milestone's centre of gravity

Everything else in M6 measures or records; this is the only change that *decides what happened*.
It also carries the two rules most likely to silently invalidate every downstream number: rule 25
(never fabricate a fill) and §20's detection-lag honesty. Both are the kind of error that makes
results look *better*, which is the direction nobody notices.

## Known consequence, stated up front

**Memecoin paper trading may fill rarely — or not at all — until a pool-reserves source exists.**
§20 makes depth-aware fills a hard provider requirement; §25 separately resolves that the Helius
free tier (live watching only) is sufficient for MVP. Whether Helius exposes usable reserves at
execution time is an open question this change must answer empirically. Part II §10 already
supplies the correct behaviour either way — *no reserves, no fill* — so the system stays honest,
but the operational reality could be a memecoin paper engine that declines most entries. That is
rule 25 working, not a bug, and it is better surfaced now than discovered as a mysteriously empty
positions table. See `design.md` for the investigation task and the fallback.

## What this change does NOT do

- **No real-money execution** (rule 20). Not stubs, not commented-out, not "for later."
- **No outcome rows** — change 4 owns `prediction_outcome`. This change owns *position* P&L, which
  is a different question: the position closed once, the prediction is measured at three horizons.
- **No memecoin autopsy** (§24, deferred until memecoin has a backtest).
