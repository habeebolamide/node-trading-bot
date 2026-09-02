# Change: m6-limit-orders-perp

**Status:** COMPLETED — archived 2026-09-02
**Original status:** PROPOSED (scoping)

> **COMPLETED.** Perp LIMIT support end-to-end. New ScoringConfig fields
> (`entryType`, `limitPullbackAtr`), planner LIMIT branch with a
> `LIMIT_TOO_FAR` guard, paper-engine primitives (`openPendingPosition`,
> `activatePendingPosition`, `expirePendingPosition`), `evalPendingTick`
> decision helper (`ACTIVATE_LIMIT` / `EXPIRE_LIMIT`), and outcome-sweep skip
> for EXPIRED/PENDING_ENTRY positions.
>
> **Also in this change (operator preference):** perp `maxConcurrentPositions`
> is now fixed at 1 — one coin at a time per agent. Same rationale as §32
> memecoin: users wanting more concurrent exposure create more TradingAgents.
> `openPositionCount` counts OPEN + PENDING_ENTRY so a queue of unfilled LIMITs
> can't blow through the cap when they all cross.
>
> **Also (dashboard UX):** memecoin Create-Agent form now hides Universe +
> Style (defaults to `SOLANA` scope + `day`, with an inline note explaining
> memecoin agents react to watched wallets, not a pre-declared mint list).
> Style meaning documented inline for perp too (5m/1h/4h primary TF).
>
> **Verified:** typecheck + dashboard build green. 640/643 tests, 2 clean runs.
**Follow-up to M6.** Not part of a numbered milestone — one of the open scope items called out
in m6-trade-planner and m6-paper-engine (§8: "LIMIT entry types are part of the initial
version"; §36: `PENDING_ENTRY` state; §8 style→LIMIT-expiry mapping).

## What's changing

Perp gets LIMIT entry support end-to-end. Memecoin is STRUCTURALLY UNREACHABLE — Part II §10
verbatim: "no LIMIT, no `PENDING_ENTRY`."

1. **ScoringConfig gains `entryType`** — `'MARKET' | 'LIMIT'` (default `MARKET`, preserves
   every existing agent's behaviour). Optional `limitPullbackAtr` (default 0.3) controls how
   far the LIMIT price sits from the signal-time close.
2. **Perp planner** — when `config.entryType === 'LIMIT'`, sets
   - LONG:  `entry = close - limitPullbackAtr × ATR`
   - SHORT: `entry = close + limitPullbackAtr × ATR`
   Same SL/TP derivation from swing pivots; R:R still gates.
3. **Paper position gains `PENDING_ENTRY` state** — a LIMIT prediction opens a position with
   `state='PENDING_ENTRY'`, no cash committed yet. §36 keeps its states unchanged; the pending
   status lives on the position because Signal state already transitions to CONSUMED when the
   Prediction is created.
4. **Tick monitor's `evalTick`** — new decision `ACTIVATE_LIMIT` when price crosses the limit
   in the trade's direction (LONG: `low ≤ entry`; SHORT: `high ≥ entry`). Transitions the
   position from `PENDING_ENTRY` → `OPEN` at the limit price, records the fill with reason
   `LIMIT_FILL`.
5. **Expiry** — §8's `LIMIT expiry` (6 × primary TF): scalp 30m · day 6h · swing 24h.
   Positions still in `PENDING_ENTRY` past that window transition to `EXPIRED` with
   `close_reason='LIMIT_EXPIRY'`, no P&L booked. Sweep-driven so it doesn't depend on the tick
   monitor being connected.
6. **NO_TRADE reason** — LIMIT beyond a hard cap (say 5× ATR from close, defensive) → NO_TRADE
   with a new `LIMIT_TOO_FAR` reason. Guards against a degenerate ATR read producing an
   unreachable limit.

## Consequences, stated up front

- **maxConcurrentPositions counting** — a `PENDING_ENTRY` position occupies a slot exactly like
  an OPEN one. Otherwise a burst of LIMIT signals could stack a queue that all activates at
  once. Same discipline `openPositionCount` already applies to OPEN; extended to
  `state IN ('OPEN', 'PENDING_ENTRY')`.
- **T1 for the Outcome Engine** — §21's "T1 = fill." For a LIMIT that filled 40 minutes into
  the horizon, the horizon window measures from the fill, not from signal creation. That is
  already how m6-outcome-engine's `t1For` reads `openedAtProcessing`; a LIMIT fill updates that
  field on activation, so the outcome resolver stays honest by construction.
- **Brain feeding** — a LIMIT that EXPIRED without filling gets no `prediction_outcome` and no
  Brain occurrence. That is correct — the setup was never actually taken, so it doesn't teach
  the Brain anything. The `signal_no_trade` mechanism is for pre-entry vetoes; expired LIMITs
  are a *post-entry-attempt* outcome and are recorded on the position's `close_reason` only.

## Not in scope

- **Post-only / GTC / IOC** — MVP is a simple resting limit that fills on crossing or expires.
- **Memecoin LIMIT** — Part II §10 forbids it structurally.
- **Adaptive limit repricing** — no chase-fill; the LIMIT sits still at its signal-time price.
