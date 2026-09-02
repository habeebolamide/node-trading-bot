# Change: m6-brain-seeding

> **COMPLETED 2026-09-02 — M6 (all 6 changes) is done.** New `packages/seeding` (`@tip/seeding`),
> a leaf package that composes M1–M6 without introducing dependency cycles.
>
> - `checkpoint.ts` — resumability marker stored in `domain_event` (no new table). Reads and
>   writes a `{ symbol, style, agentId, cursor, writtenAt }` per run.
> - `seed.ts` — `seedSymbol(opts)` drives the M1 ReplayEngine over the backfilled range. On every
>   primary-TF bar close: synthesize `perp.kline.closed` → run every canHandle-matching perp
>   agent against the AsOfMarketData view → `composeSignal` → `createSignal` (dedup by
>   fingerprint) → `planTrade` (NO_TRADE recorded) → `createPrediction` (isShadow=false — seeded
>   rows are REAL predictions about the past) → `resolvePrediction(mode='CANDLE_1M_CONSERVATIVE')`
>   which fires §41's `recordSetupOutcome` + `recordAgentOutcome` on the planning horizon.
>   Checkpoint advances BEFORE per-step continues so a bar that produced no signal still counts
>   toward resume.
> - `gate.ts` — `buildGateReport` + `formatGateReport`. Fingerprints encountered / at trust /
>   trust fraction, seeded win rate, per-symbol stats. Reports, doesn't assert: §32 asks for
>   "an explicit minimum-maturity bar per domain" and leaves the number to judgement.
>   **Prominent WARNING when the seeded win rate exceeds `PLAUSIBLE_MAX_WIN_RATE = 0.72`** — §25
>   flags this pattern as look-ahead, not edge; the temptation to celebrate a 78% seeded win
>   rate is exactly how such a bug survives review.
> - `scripts/src/seed-brain.ts` — CLI: `--agent --symbols --from --to [--dry-run] [--max-steps]`.
>
> **`memecoin` is refused outright** (§25 scope). `loadAgentSnapshot` throws with the §25
> citation on a memecoin agent — silent skip would hide the mismatch and could ship an unseeded
> memecoin path to production.
>
> **Verified:** typecheck green; **519/522 tests pass** (3 opt-in live) across 3 consecutive
> full-suite runs, 8 new — pure gate report (2), live-DB seeding (6 incl. memecoin refusal,
> empty-range no-op, dry-run writes-nothing, CHECKPOINT resumability, IDEMPOTENT re-run of a
> completed range writes zero new predictions, gate WARNING when fingerprints=0).
>
> **One implementation bug I caught in test:** the checkpoint advance was originally at the END
> of each loop iteration, AFTER a bunch of `continue`s that fired on "no output," "no plan," or
> "fingerprint dedup." That meant an interrupted run whose recent bars were all silent had no
> checkpoint written — resume would redo them. Moved the advance to the TOP of the loop
> (immediately after `stepsWalked++`) so every bar we saw counts toward resume, even silent ones.
>
> **Composition, not new machinery.** Every piece existed by the end of change 4:
> `ReplayEngine` (M1), perp agents (M4), `composeSignal` + `createSignal` (M4),
> `planTrade` (change 1), `createPrediction` (change 2), `resolvePrediction` (change 4). This
> change is a DRIVER + a GATE REPORT + memecoin refusal, exactly matching §25's roadmap
> correction that moved the replay engine to M1 so seeding could be an assembly job.
>
> **What actually runs pre-launch** (once the operator points this at the backfilled range):
> ```
> npm run seed-brain --workspace @tip/scripts -- >   --agent <tradingAgentId> --symbols BTCUSDT,ETHUSDT,SOLUSDT >   --from 2026-01-01 --to 2026-07-01
> ```
> The report ends with a fingerprints-at-trust count and (optional) look-ahead warning; §30
> requires the system not go live with an empty perp Brain; the human uses the report to decide.
>
> **M6 wrap-up — what M7 (Judge, §24 hypothesis pipeline) picks up:**
> - Structured evidence prompts, LLM synthesis, thesis narration on top of the deterministic
>   Prediction.
> - The Judge-override machinery (§18) — this is what fills `prediction.isShadow` and
>   `prediction.shadowOf`, already-schema'd at change 2.
> - The §24 hypothesis pipeline, gated on effective-n ≥ 20 (change 5 supplies the walk-forward
>   folds at the reporting bar of ≥ 10 — the two bars are deliberately different).
> - Memecoin autopsy — deferred to when memecoin gets a backtest, which §25 scopes out of MVP.

**Status:** COMPLETED — archived — **M6 COMPLETE**
**Original status:** PROPOSED (scoping)
**Milestone:** M6 (change 6 of 6) — **the §30 pre-launch gate, not a numbered milestone**
**Implements:** §25 Brain Seeding · §25 "historical data lives in local Postgres" · §21
(`CANDLE_1M_CONSERVATIVE`) · §30 pre-launch gate · §32 bootstrap window · §33 rules 11, 21, 22

## What's changing

The cold-start solution. §25 is blunt about the problem: with ~6,500 perp fingerprint cells and
an effective-n ≥ 10 trust bar, "starting from zero live trades means most cells stay `INSUFFICIENT`
for a long stretch — the system's headline 'historical edge' feature runs essentially silent for
months if left to fill in purely from live paper trading."

The fix, run **before the system ever trades live**:

```
local Postgres history (M1 backfill)
        ↓  ReplayEngine (M1)
replay chronologically, no look-ahead
        ↓  perp agents (M4)
signals → TradeSetups (change 1) → synthetic predictions (change 2)
        ↓  resolve against 1m klines, pessimistically
outcomes (change 4, mode = CANDLE_1M_CONSERVATIVE)
        ↓  §41
BrainSetupMemory + BrainAgentMemory
```

On day one of live trading, a meaningful fraction of fingerprints already carry real historical
statistics instead of `INSUFFICIENT`.

1. **Seeding runner** — a script driving the M1 replay engine across the backfilled range for
   BTC/ETH/SOL, generating synthetic predictions and resolving them.
2. **1m-kline resolution** — §25 requires seeding resolve from **1m klines**, not the primary
   timeframe: "resolving a 4h trade on 4h candles is far too coarse to be honest about
   intra-candle exits."
3. **Pessimistic tie-break** — a 1m candle whose range spans both TP and SL records **SL first**.
   This biases seeded stats downward, which §25 argues is the correct direction to be wrong in:
   "a Brain that slightly under-rates a seeded fingerprint costs a missed trade, one that
   over-rates it costs a taken loss."
4. **`outcomeResolution = CANDLE_1M_CONSERVATIVE`** on every seeded row, so the two populations
   stay separable in reporting forever (§21) even though the Brain aggregates them together.
5. **No "seeded" flag needed.** §25 is explicit: seeded occurrences carry their **true historical
   dates**, so M5's recency decay fades them naturally as live data accumulates. No special-case
   logic — and M5's `updateSetupMemory` already uses `now = outcome.closedAt` rather than wall
   clock, which is precisely what makes this work.

## Scope: perp only

§25 resolves this twice, deliberately. **Memecoin gets no Brain Seeding and no historical backtest
in MVP** — not blocked on a provider, a scope decision. The memecoin Brain builds purely from live
paper trading, with a correspondingly longer bootstrap window (§32), and that is expected
behaviour rather than a problem to fix.

The distinction §25 warns is "easy to misread" and which this change must not blur:
- **IN** — wallet-scoring backfill ("is THIS WALLET any good?"), per-address, already done in M2.
- **OUT** — Setup Memory replay ("when a SETUP LIKE THIS happened before, what was the outcome?"),
  which needs chain-wide bulk history the Helius free tier does not provide.

Both are true at once: on day one memecoin wallet scores are fully populated *and* memecoin
Setup Memory reads `INSUFFICIENT`.

## The gate

§30: "The system does not go live with an empty perp Brain, and does not attempt to seed the
memecoin Brain at all." This change ends with a **measured, reported** gate check — what fraction
of encountered perp fingerprints cleared effective-n ≥ 10 — not an assumption that seeding worked.

## Prerequisite that is not yet met

M1's full backfill was built but **never run at scale** — the archived m1-replay-engine notes a
small smoke range only. CLAUDE.md's M1 exit criterion stands: **≥ 6 months of 1m/5m/15m/1h/4h/1d
klines + funding + OI for BTC, ETH, SOL** must be loaded before this change can produce anything
meaningful. That is an operational step for the human, not code, and it is the first task here.
