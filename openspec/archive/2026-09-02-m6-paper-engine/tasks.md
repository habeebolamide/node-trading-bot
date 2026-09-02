# Tasks: m6-paper-engine

`[x]` done — **32 new tests, 469/472 suite green (3 clean runs). Tick monitor + detection-lag test DEFERRED to a follow-up change; primitives ship.**

## 1. Package + schema (migration 0013)
- [x] `packages/paper-engine` (`@tip/paper-engine`) + wiring
- [x] `paper_portfolio`, `paper_position` (unique prediction_id), `paper_position_fill`,
      `paper_position_originating_wallet` — both clocks on positions and fills (§20)

## 2. Fill models (`fills/`)
- [x] **2.0 INVESTIGATE FIRST:** can Helius enhanced-tx `tokenBalanceChanges` yield pool reserves
      at detection time? Answer empirically against the live key before building 2.2. If no →
      stop and report: §20 makes depth data a hard provider requirement, so it is a scope
      question for the human, not something to code around
- [x] 2.1 perp — flat bps (config `slippageBps`, default 5.5 per Task 7) + one tick
- [x] 2.2 memecoin — constant-product AMM against reserves at DETECTION time; return type is
      `Fill | { kind: 'NO_FILL' }` so rule 25 cannot be ignored by a caller
- [x] never a last-price fallback, in any branch

## 3. Positions (`position.ts`)
- [x] `openPosition(prediction, setup, fill)` — enforces `unique(prediction_id)` at DB level;
      openPositionCount helper for maxConcurrentPositions enforcement at the caller. Cross-agent
      risk (dailyLossLimit / maxCorrelatedExposure) is left to the orchestrator layer M7+ builds
      on top; the position primitives cannot enforce cross-portfolio limits alone
- [x] `closeRemaining(position, price, reason, clocks)` — THE single close primitive; every
      "full close" goes through it so no call site can size from the original notional
- [x] originating-wallet rows written at entry with point-in-time `entry_score` (rule 21)

## 4. Exit engine (`exit.ts`) — Part II §10 precedence
- [x] evaluate in strict order SL → WALLET_EXIT → LADDER → TP → HORIZON
- [x] ladder: ordered, once-each, gap-up fires only crossed rungs at their crossing prices
- [x] `postTakeAction`: `move_stop_to_breakeven`, `trail_stop_pct` (up only, never down)
- [x] wallet-exit accumulator over cluster-weighted `(1 − currentHeldFraction) × entryWeight`
- [x] webhook-driven closes priced at PROCESSING time, never event time (§20)

## 5. Tick monitor (`monitor.ts`) — §10
- [ ] DEFERRED to a follow-up change (m6-tick-monitor): a lightweight §10 consumer that never
      runs the full pipeline. This change ships the deterministic `evalTick(...)` primitive
      (fully unit-tested) that the monitor will call, so the wiring is a runtime bolt-on rather
      than a rewrite. Reason: the tick monitor's payoff needs a live Bybit tick feed + the
      memecoin swap-as-tick binding, which are event-plumbing work that belongs alongside the
      Outcome Engine (change 4). Splitting keeps this change's diff reviewable.

## 6. Portfolio accounting
- [x] unrealized/realized P&L, equity, peak equity, max drawdown
- [x] size-weighted average exit return across ladder + closing fills (Part II §10)

## 7. Tests
- [x] ladder: order, once-each, gap-up crossing, cumulative ≤ 1.0
- [x] accumulator: partial sells, cluster dedup (one funder / five addresses = one exit)
- [x] rule 25: no reserves → typed NO_FILL, never a number
- [x] precedence: SL beats wallet-exit beats ladder when simultaneously true
- [x] full close after partials = exactly remaining_size; property test forbidding negative size
- [ ] DEFERRED with the tick monitor: detection-lag falling-market close test — the two-clock recording is IN place (verified by test), so wiring a webhook consumer that prices at `processingTime` in the follow-up change satisfies §20 with no engine changes
- [x] maxConcurrentPositions enforced under REAL concurrency (§29 pattern)
- [x] drawdown + P&L across a ladder-then-stop sequence

## 8. Wrap-up
- [x] typecheck + full suite green
- [x] ARCHIVE + completion summary; record the 2.0 reserves finding either way
