# Design: m6-outcome-engine

## Where it lives

Grows `packages/evaluation` (`@tip/evaluation`) — it already owns `AsOfMarketData`,
`HistoricalMarketReader`, `ReplayEngine` and the backfill, and §28 lists "outcome resolution,
metrics" as that package's job. No new package (CLAUDE.md: "prefer growing an existing one").

## Ambiguity 1 — measured from the position, or from market data?

The plan uses both vocabularies: §20 gives positions realized P&L; §21 gives predictions
per-horizon returns. They are genuinely different numbers — a position stopped out at 40 minutes
has one realized P&L, while its prediction still has a 4h horizon that may have finished green.

**Resolution: both, and they answer different questions.**

| | Source | Question |
|---|---|---|
| `paper_position.realized_pnl` (change 3) | the actual fill sequence | "What would we have made?" |
| `prediction_outcome` (this change) | market data over the window from T1 | "Was the *call* right?" |

`prediction_outcome` is computed from candles, independent of when the position closed, because
§32's metrics (calibration, per-horizon performance, alpha) are about **predictive accuracy**, and
letting an early stop truncate the 4h measurement would conflate "our exit rules" with "our
direction call." The exit rules are judged by the position's P&L instead. Documented in both
tables because reading either number as the other is an easy and expensive mistake.

## Ambiguity 2 — which horizon defines `won` for the Brain

§41's `TradeOutcome` takes one `won: boolean`; four horizons can disagree.

**Resolution: the prediction's own PLANNING horizon** — the one the TradeSetup targeted (change 1:
the middle of the style's three). The trade was constructed with that horizon's TP/SL; scoring the
Brain on a horizon the setup was never built for would teach it about a trade nobody planned.

`returnPct` fed to the Brain likewise comes from the planning horizon. The other three horizons
are recorded in `prediction_outcome` for §32 reporting and are not fed to Setup Memory — one
prediction contributes exactly one occurrence per fingerprint, or the effective-n arithmetic
inflates 4× and every Wilson interval becomes a lie.

## Ambiguity 3 — `realizedDirection` for Agent Memory

M5's `recordAgentOutcome` needs "which direction actually paid over the horizon," deliberately
**not** "did the composite win" — crediting a dissenter on a losing composite is the whole point
of §16's mechanism.

**Resolution:** `realizedDirection = sign(closePrice(T1 + horizon) − entryPrice)`, on the planning
horizon. A LONG lean is right when price rose. Ties (exactly flat, vanishingly rare) resolve to
the direction the *benchmark* did not favour, so a flat tape does not systematically credit longs.

## Outcome rules (Task 7)

```
WIN            = hit TP before SL within the horizon
hitTarget      = price touched TP at any point in the window
hitInvalidation= price touched SL at any point in the window
MFE / MAE      = max favourable / adverse excursion from T1, in the trade's direction
return         = (close(T1+h) − entry) / entry, signed by direction
benchmark      = perp: the underlying's own buy-and-hold over the same window (plus BTC beta)
                 memecoin: SOL return over the same window — read from market_candle SOLUSDT,
                 which M1's Bybit backfill already stores. No new provider.
alpha          = return − benchmark
fees/slippage  = perp 5.5bps taker + 1 tick; memecoin the AMM depth model + DEX fee (change 3)
holdingPeriod  = from T1
```

**Both TP and SL touched inside one bar** → resolve **SL first** (pessimistic, §25's tie-break).
Applies to `CANDLE_1M_CONSERVATIVE` resolution; `TICK` resolution knows the true order and uses it.
§25: "a Brain that slightly under-rates a seeded fingerprint costs a missed trade, one that
over-rates it costs a taken loss" — the correct direction to be wrong in.

## Scheduling

Horizons elapse at different times, so resolution is a **scheduled sweep**, not a single event
handler: find predictions whose horizon `h` has elapsed and lack a `prediction_outcome` row for it,
resolve, insert. Idempotent by the `(prediction_id, horizon)` primary key (rule 12) — a re-run
inserts nothing.

The Brain write fires **once**, when the *planning* horizon resolves — not once per horizon. A
`brain_written_at` marker on the prediction makes that at-most-once even under concurrent sweeps.

## No look-ahead, even here (rules 11/21/22)

Resolution legitimately reads data *after* T1 — that is what resolution is. The discipline that
still applies: the resolver may never read anything that would change the *prediction*, and it
writes to the Brain with `closedAt` = the true horizon end, so M5's decay math (which uses
`now = outcome.closedAt`) stays replay-deterministic. Seeded outcomes carry their real historical
dates for exactly this reason (§25).

## Testing

- T1 anchoring: a prediction that filled 3 candles after T0 measures its horizon from the fill,
  not from signal creation.
- One prediction → exactly one Brain occurrence per fingerprint, even with four horizons resolved
  and the sweep run twice.
- Pessimistic tie-break: a bar spanning both TP and SL resolves as a loss under
  `CANDLE_1M_CONSERVATIVE`.
- `outcomeResolution` recorded on every row; live and seeded rows are separable by query.
- Benchmark/alpha: a flat tape gives ≈0 alpha; a prediction that merely matched SOL's move gives
  ≈0 alpha despite a positive return.
- MFE/MAE signed correctly for SHORT as well as LONG.
- Idempotency: the sweep run twice inserts no duplicate outcomes and no duplicate Brain rows.
- **End-to-end (CLAUDE.md's named integration test):** raw Bybit fixture → ingestion →
  normalization → event → agent → signal → prediction → paper fill → outcome →
  `BrainSetupMemory` update. If this passes, the seams work.
