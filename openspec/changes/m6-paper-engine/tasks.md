# Tasks: m6-paper-engine

## 1. Package + schema (migration 0013)
- [ ] `packages/paper-engine` (`@tip/paper-engine`) + wiring
- [ ] `paper_portfolio`, `paper_position` (unique prediction_id), `paper_position_fill`,
      `paper_position_originating_wallet` — both clocks on positions and fills (§20)

## 2. Fill models (`fills/`)
- [ ] **2.0 INVESTIGATE FIRST:** can Helius enhanced-tx `tokenBalanceChanges` yield pool reserves
      at detection time? Answer empirically against the live key before building 2.2. If no →
      stop and report: §20 makes depth data a hard provider requirement, so it is a scope
      question for the human, not something to code around
- [ ] 2.1 perp — flat bps (config `slippageBps`, default 5.5 per Task 7) + one tick
- [ ] 2.2 memecoin — constant-product AMM against reserves at DETECTION time; return type is
      `Fill | { kind: 'NO_FILL' }` so rule 25 cannot be ignored by a caller
- [ ] never a last-price fallback, in any branch

## 3. Positions (`position.ts`)
- [ ] `openPosition(prediction, setup, fill)` — respects maxConcurrentPositions (1 memecoin),
      dailyLossLimit, maxCorrelatedExposure
- [ ] `closeRemaining(position, price, reason, clocks)` — THE single close primitive; every
      "full close" goes through it so no call site can size from the original notional
- [ ] originating-wallet rows written at entry with point-in-time `entry_score` (rule 21)

## 4. Exit engine (`exit.ts`) — Part II §10 precedence
- [ ] evaluate in strict order SL → WALLET_EXIT → LADDER → TP → HORIZON
- [ ] ladder: ordered, once-each, gap-up fires only crossed rungs at their crossing prices
- [ ] `postTakeAction`: `move_stop_to_breakeven`, `trail_stop_pct` (up only, never down)
- [ ] wallet-exit accumulator over cluster-weighted `(1 − currentHeldFraction) × entryWeight`
- [ ] webhook-driven closes priced at PROCESSING time, never event time (§20)

## 5. Tick monitor (`monitor.ts`) — §10
- [ ] lightweight consumer; never runs the full pipeline
- [ ] perp: Bybit tick feed; memecoin: each observed swap on the mint IS the tick (documented)
- [ ] emits `paper_trade.tp_hit` / `paper_trade.sl_hit` / ladder-rung events

## 6. Portfolio accounting
- [ ] unrealized/realized P&L, equity, peak equity, max drawdown
- [ ] size-weighted average exit return across ladder + closing fills (Part II §10)

## 7. Tests
- [ ] ladder: order, once-each, gap-up crossing, cumulative ≤ 1.0
- [ ] accumulator: partial sells, cluster dedup (one funder / five addresses = one exit)
- [ ] rule 25: no reserves → typed NO_FILL, never a number
- [ ] precedence: SL beats wallet-exit beats ladder when simultaneously true
- [ ] full close after partials = exactly remaining_size; property test forbidding negative size
- [ ] detection lag: falling-market webhook close prices worse than on-chain-time price
- [ ] maxConcurrentPositions enforced under REAL concurrency (§29 pattern)
- [ ] drawdown + P&L across a ladder-then-stop sequence

## 8. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary; record the 2.0 reserves finding either way
