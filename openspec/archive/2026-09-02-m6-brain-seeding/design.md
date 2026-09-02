# Design: m6-brain-seeding

## Composition, not new machinery

Every piece exists. This change is a **runner** that composes them, plus one genuinely new thing
(1m-kline pessimistic resolution). That is the point of §25's roadmap correction moving the replay
engine to M1: seeding should be an assembly job by the time it is needed.

```
M1  ReplayEngine + AsOfMarketData + HistoricalMarketReader + backfill
M4  perp agents + SignalEngine + Risk Agent
M6c1 planTrade → TradeSetup
M6c2 createPrediction (synthetic; isShadow = false — these are real predictions about the past)
M6c4 resolveOutcome(mode = CANDLE_1M_CONSERVATIVE) + the Brain wiring
M5  updateSetupMemory / recordSetupOutcome / recordAgentOutcome
```

New here: `seed.ts` (the driver), `resolve-1m.ts` (candle-level resolution), and a
`scripts/seed-brain.ts` CLI.

## Why the seeded predictions are real predictions, not shadows

`isShadow` marks §18's Judge-override counterfactuals — "what if we had gone the other way."
A seeded prediction is not a counterfactual: it is a genuine prediction the system would have made
had it been running, resolved against what genuinely happened. Storing them as shadows would
corrupt the meaning of that column before M7 ever uses it. They are distinguishable by
`outcomeResolution = CANDLE_1M_CONSERVATIVE` on their outcomes, which §21 requires anyway.

## 1m-kline resolution with pessimistic tie-break

```
for each 1m bar from T1 to T1 + horizon:
    if bar.low  ≤ SL and bar.high ≥ TP:  → SL FIRST. Pessimistic (§25).
    else if crosses SL only:             → SL
    else if crosses TP only:             → TP
    else continue
if neither by horizon end:               → resolve at close(T1 + horizon)
MFE/MAE track bar extremes throughout
```

The ambiguous-bar rule is the whole methodological point. A 1m bar spanning both levels genuinely
cannot say which came first, and the alternatives are worse: assuming TP manufactures wins (rule
25's "no assumed TP on ambiguous candles"), and discarding the occurrence silently biases the
sample toward calm bars, which is a subtler and more damaging distortion.

**A test asserts the tie-break is actually reached** on a constructed spanning bar — an
"unreachable" pessimistic branch would quietly turn seeding optimistic.

## Look-ahead is the whole risk here (rules 11/21/22)

Seeding is where look-ahead would do the most damage and be hardest to notice: a seeded Brain that
peeked would make live trading look brilliant for entirely fake reasons, and the error would be
baked into `brain_setup_memory` rows that outlive any code fix.

Structural defences, all pre-existing:
- The replay step exposes only `AsOfMarketData`, which has no `latest()` (M1).
- Wallet scores are read `AsOfT` with no current accessor (M2) — not used in perp seeding, but the
  discipline is uniform.
- Every Brain read requires `asOf`, enforced at **compile time** (M5 change 3).
- Resolution reads *forward* from T1 by design, and is a separate function from anything the
  prediction path can call.

Plus one new check specific to seeding: a **replay determinism test** — the same historical range
seeded twice into a scratch schema produces byte-identical `brain_setup_memory` rows. CLAUDE.md
names this ("same historical fixture in twice, byte-identical Setup Memory rows out"), and M5's
`now = outcome.closedAt` decision is what makes it achievable.

## Cost and shape of a run

6 months × 3 symbols on a 1h primary TF ≈ 4,300 steps/symbol ≈ 13k agent evaluations, each
resolving against up to 240 1m bars. Minutes, not hours, entirely local (§25: never call Bybit at
replay time — reproducibility, rate limits, speed).

**Resumability matters more than speed.** The runner checkpoints per (symbol, cursor) so an
interrupted run resumes instead of restarting, and the whole thing is idempotent anyway:
`unique(prediction_id, setup_id)` on occurrences means a replayed range double-counts nothing.

## The gate check

§30 requires the system not go live with an empty perp Brain. The runner ends by reporting:

```
fingerprints encountered            N
fingerprints at effective-n ≥ 10    M   (M/N — the actual gate number)
occurrences written                 …
seeded win rate (all) / by regime   …   — sanity: a wildly implausible rate means a bug,
                                          not an edge
date range · symbols · config version
```

Reported, not asserted — the human decides whether coverage is sufficient to launch. §32 asks for
"an explicit minimum-maturity bar per domain" and deliberately leaves the number to judgement.

**A seeded win rate far above plausible is a red flag for look-ahead, not a discovery.** Stated
here because the temptation to celebrate a 78% seeded win rate is exactly how a look-ahead bug
survives review.

## Testing

- Pessimistic tie-break reached and applied on a constructed spanning bar.
- `outcomeResolution = CANDLE_1M_CONSERVATIVE` on every seeded outcome; queryably separable from
  live rows.
- Seeded occurrences carry **true historical dates**, and decay accordingly when read at a later
  `asOf` (proving §25's "no seeded flag needed" claim rather than assuming it).
- **Determinism:** the same range twice → byte-identical Setup Memory rows.
- Resumability: an interrupted run resumes and produces the same result as an uninterrupted one.
- Idempotency: re-running a completed range writes zero new occurrences.
- No look-ahead: a prediction at T is unchanged when data after T is added to the DB and the range
  is re-seeded.
- Memecoin is refused outright — calling the seeder with `domain: 'memecoin'` throws (§25 scope),
  rather than silently producing a partial seed.
