# Design: m6-paper-engine

## Package

`packages/paper-engine` → `@tip/paper-engine` (§28). Depends on `@tip/database`, `@tip/domain`,
`@tip/planner`, `@tip/predictions`, `@tip/events`. Not on `@tip/brain` — the Brain is written by
the Outcome Engine (change 4), keeping "what happened" and "what we learned from it" separate.

## Schema (migration 0013)

```
paper_portfolio        (id, trading_agent_id, starting_cash, cash, equity, peak_equity,
                        max_drawdown, realized_pnl, created_at, updated_at)
paper_position         (id, portfolio_id, prediction_id UNIQUE, symbol, domain, direction,
                        state OPEN|CLOSED, entry_price, size, remaining_size, current_stop,
                        take_profit, ladder_state jsonb, opened_at_event, opened_at_processing,
                        closed_at, close_reason, realized_pnl, mfe, mae)
paper_position_fill    (id, position_id, fill_at_event, fill_at_processing, size_fraction,
                        price, reason, is_final)      -- Part II §10 field list
paper_position_originating_wallet
                       (position_id, wallet_id, cluster_id, entry_usd, entry_weight,
                        entry_score, current_held_fraction)   -- Part II §10
```

`paper_position_originating_wallet.entry_score` is the **point-in-time** wallet score at entry
(rule 21) — read via `walletScoreAsOf`, never live. `current_held_fraction` decrements as each
wallet sells; the exit accumulator sums `(1 − current_held_fraction) × entry_weight` across rows.
Rows are **retained after close** for autopsy and attribution, per Part II §10.

`opened_at_event` / `opened_at_processing` are §20's "record both clocks" mandate. Every fill row
carries both too, so reaction lag is queryable rather than inferred.

## Fill models

### Perp — flat bps
```
fill = last ± (last × slippageBps / 10_000)     // sign against the trade direction
```
Config-driven (`slippageBps`, default 5.5 per Task 7's "flat 5.5bps taker + 1 tick"), plus one
tick of spread. §20 explicitly blesses this for major perp books.

### Memecoin — constant-product AMM, or no fill
```
given reserves (x = token, y = SOL) at DETECTION time:
  buy  Δy:  tokensOut = (x · Δy·(1−fee)) / (y + Δy·(1−fee))
  sell Δx:  solOut    = (y · Δx·(1−fee)) / (x + Δx·(1−fee))
  effectivePrice = notional / tokensOut     // includes price impact by construction
  → if reserves are unknown at that instant: NO FILL. Not last price, not mid, not an estimate.
```

Rule 25 is absolute here: "Memecoin: no last-price fallback, no assumed TP on ambiguous candles.
Resolve pessimistically and record how resolved." The function's return type is
`Fill | { kind: 'NO_FILL'; reason: 'RESERVES_UNAVAILABLE' }` so a caller cannot ignore the case —
there is no overload that returns a number.

**Open question this change must answer empirically (task 2.0):** does the Helius free tier expose
pool reserves at (or near) a given transaction? Enhanced transactions carry token balance changes
for the accounts involved, which for an AMM swap includes the pool's own token accounts — so
reserves may be *derivable* from the swap that triggered detection, at exactly the right instant.
If that holds, the fill model works on data already ingested. **If it does not**, the fallback is
NOT a price approximation — it is: memecoin positions do not fill, the reason is recorded, and the
gap is reported to the human as a provider decision (§20 makes depth data a hard requirement, so
this becomes a scope question, not a code question).

## Detection-lag pricing (§20)

The two exit paths run at genuinely different latencies and the engine must price each honestly:

```
SL / TP / LADDER  → tick monitor, live price feed → fires on the crossing tick, ~zero added lag
WALLET EXIT       → Helius webhook → carries seconds of detection lag → priced at DETECTION time,
                    i.e. at whatever the price already is once the sell was seen (in a dump,
                    worse than where the wallet actually got out)
```

§20: "the paper engine must price the lagged one honestly or the sell-side P&L flatters itself in
exactly the scenario that hurts most in real trading." Implemented by always pricing a
webhook-driven close from the pool state at `processingTime`, never `eventTime` — and a test
asserts a falling-price scenario closes *worse* than the on-chain price would have given.

## The exit engine — precedence is not a preference

Part II §10's order, evaluated per position on every trigger:

```
1. STOP LOSS      price ≤ current_stop            [tick]     — above wallet exit because a rug
                                                               can outrun webhook latency
2. WALLET EXIT    accumulator ≥ walletExitThresh   [webhook]  — thesis death; close everything,
                                                               no moon bag nobody is watching
3. PROFIT LADDER  price crosses next unfired rung  [tick]     — partial, may adjust stop
4. TAKE PROFIT    price ≥ fill × (1+takeProfitPct) [tick]     — only when profitLadder is null
5. HORIZON EXPIRY style horizon elapsed            [scheduler]
```

**"Full close" means 100% of what is CURRENTLY HELD, not of the original notional.** Part II §10
demands this be explicit in the engine code "to prevent negative-size fills" — after ladder rungs
have taken 75%, a stop closes the remaining 25%. Enforced by a single `closeRemaining()` primitive
that reads `remaining_size`; no call site computes a size from `entry_size`.

**Ladder mechanics:** rungs fire in order, each at most once (`ladder_state` records fired rungs);
a gap-up across two rungs fires **only the rungs actually crossed**, in order, at the crossing
price — not all rungs at the final price. `postTakeAction`: `move_stop_to_breakeven` raises the
stop to entry; `trail_stop_pct: X` trails by X% and **follows up, never down**.

**Wallet-exit accumulator:** `Σ (1 − currentHeldFraction) × entryWeight` over the position's
originating-wallet rows, where weights are per funder-cluster (§5 dedup). A partial sell
contributes proportionally — a wallet that sold 40% of its position contributes `0.4 × weight`.

## Tick monitor (§10)

A separate lightweight consumer, "never runs the full pipeline." Subscribes to the per-tick feed,
holds open positions in memory keyed by symbol, and checks only: stop crossed, TP crossed, next
ladder rung crossed. Emits `paper_trade.sl_hit` / `paper_trade.tp_hit` / ladder events.

**Memecoin has no tick feed** — Helius delivers swaps, not a price stream. Resolution: for
memecoin the "tick" is **each observed swap on that mint**, which the M1 Helius ingestion already
produces. This is honest about granularity (between swaps the price is genuinely unobserved) and
requires no new provider. Flagged because Part II §10 labels these paths `[tick monitor]` without
saying what a memecoin tick is.

## Testing

CLAUDE.md's mandatory list covers most of this:

- **Profit-ladder rung firing** — rungs fire in order, each once; a gap-up hits only crossed rungs;
  cumulative `sellFraction` ≤ 1.0 validated at config-write.
- **`walletExitThreshold` accumulator** — partial-sell contribution correctness; cluster dedup
  (one funder through five addresses = one exit).
- **Rule 25** — memecoin never fills without reserves; the no-fill path is exercised and returns a
  typed refusal, not a number.
- Exit precedence: with several conditions true at once, the higher-precedence one wins; SL beats
  wallet exit; wallet exit beats ladder.
- "Full close" after partial ladder fills closes exactly `remaining_size` — and a property test
  that no fill sequence can produce a negative remaining size.
- Detection-lag: a webhook close in a falling market prices worse than the on-chain-time price.
- Both clocks recorded on every fill; lag is computable.
- Risk constraints: `maxConcurrentPositions` (1 for memecoin) is enforced against a real
  concurrent open attempt, not a sequential loop.
- Drawdown and realized/unrealized P&L across a full ladder + close sequence.
