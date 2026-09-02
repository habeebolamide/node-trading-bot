# Design: m5-wallet-token-memory

## Wallet Memory — what it holds beyond the score

M2 already produces the *score* (`wallet_score_event`, append-only, `walletScoreAsOf(T)`).
Part II §8's Wallet Memory is the **behavioral profile** that explains the score and feeds the
Judge's evidence package. Derived from Part II §2's wallet-intelligence dimensions:

```
brain_wallet_memory  (extends the existing table)
  wallet_id PK
  early_entry            jsonb   -- M2, unchanged
  behavior               jsonb   -- NEW
    { medianHoldMinutes, avgPositionSol, tradesPerDay,
      specialization: { <category>: fraction },   -- token-category concentration
      clusterAffiliations: [clusterId],           -- funder clusters seen in (Part II §5)
      effectiveN }                                -- 60d half-life, Task 6 wallet metric
  updated_at
```

`effectiveN` on the profile is the same recency-weighted unit as everywhere else (rule 23) —
raw trade counts appear nowhere. Below effective-n 10 the wallet is **unrated** (Task 6) and
the profile reports so explicitly rather than surfacing thin aggregates.

**Point-in-time:** the profile is recomputed from `wallet_trade` / `trade_outcome` filtered to
`<= asOf`. The read is `walletMemoryAsOf(db, walletId, asOf)`. As with change 2, there is no
`current` variant for replay code to reach for (rules 21/22).

## Token Memory

Task 6 fixes the token score inputs: **liquidity / age / holder-concentration / volume,
percentile-normalized**, with safety explicitly *not* a soft input (Token Risk §40.13 is a hard
gate — already built at M4 and untouched here).

```
brain_token_memory  (new)
  mint PK
  domain              -- 'memecoin' (perp has no token memory; kept for symmetry + future use)
  profile   jsonb     -- { liquidityUsd, ageMinutes, top10HolderPct, volume24hUsd } at last obs
  score     numeric   -- percentile-normalized composite, null when inputs are missing
  outcomes  jsonb     -- { effectiveN, winRate, medianReturn, wilsonLower, wilsonUpper }
  evidence  text      -- SUFFICIENT | INSUFFICIENT, same effective-n ≥ 10 bar
  updated_at
```

`outcomes` reuses change 1's `wilsonInterval` + recency weighting verbatim — same 30d memecoin
half-life. Not a second statistics implementation; §41's "both domains call the same function"
instruction generalizes to "every memory calls the same function."

**Percentile normalization** is across the *observed token universe* at `asOf`, matching how
M2 normalizes wallet sub-metrics. A token with fewer than 10 observed peers reports its raw
profile and a null score rather than a percentile computed against nothing.

## Market Memory — a query, not a table

§16: "how setups behave under different market regimes." Part II §8 already resolved that
regime is a fingerprint dimension, so a bull-market setup and its bear-market twin are
*already different `setupId`s*. Market Memory is therefore:

```ts
marketMemory(db, domain, asOf)
  → per regime bucket: { effectiveN, winRate, wilson, medianReturn, topSetups[] }
```

grouped over `brain_setup_memory` rows by their regime dimension. Adding a table would
duplicate data change 1 already stores and create a second thing to keep in sync. Flagged
because "Market Memory" reads like a noun that wants a table, and the next person to read §16
will reasonably wonder where it went.

## The Brain facade

```ts
interface Brain {
  readonly domain: Domain;
  wallet(walletId: string, asOf: Date): Promise<WalletMemory | null>;   // memecoin only
  token(mint: string, asOf: Date): Promise<TokenMemory | null>;         // memecoin only
  setup(features: FeatureTuple, asOf: Date): Promise<HistoricalEdge>;   // change 2
  market(asOf: Date): Promise<MarketMemory>;
  agent(agentKey: string, version: number, asOf: Date): Promise<AgentMemory | null>; // change 4
}
createBrain(db, domain): Brain
```

One instance per domain (§15: shared, not per-TradingAgent). **Every method takes `asOf`** —
that uniformity is the structural enforcement of rule 21, not a convention: there is no
overload without it, so replay code cannot accidentally call a live variant.

Domain-inappropriate methods (`wallet`/`token` on a perp Brain) throw `ValidationError` rather
than returning null — a perp code path asking for wallet memory is a bug, not an empty result.

## Testing

- Wallet profile: unrated below effective-n 10; recency weighting matches the shared helper;
  `asOf` excludes later trades.
- Token score: null when inputs missing (never a fabricated percentile); percentile against a
  universe of <10 peers returns raw profile + null score.
- Market memory: regime grouping matches the fingerprint dimension; a setup appears in exactly
  one regime bucket.
- Facade: perp Brain `.wallet()` throws; every method rejects a missing `asOf` at the type
  level (compile-time, asserted by a type test).
