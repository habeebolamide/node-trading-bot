# Tasks: m5-wallet-token-memory

`[x]` done — **41 new tests, 377/380 suite green.**

## 1. Schema (migration 0010)
- [x] `brain_wallet_memory` — add `behavior jsonb`
- [x] `brain_token_memory` — new (mint PK, domain, profile, score, outcomes, evidence, updated_at)
- [x] generate + apply

## 2. Wallet Memory (`packages/brain/src/wallet-memory.ts`)
- [x] `recomputeWalletBehavior(db, walletId, asOf)` — median hold, avg size, trades/day,
      specialization fractions, cluster affiliations; 60d half-life (Task 6), effective-n
- [x] unrated below effective-n 10 — explicit state, not thin aggregates
- [x] `walletMemoryAsOf(db, walletId, asOf)` — no `current` variant (rules 21/22)

## 3. Token Memory (`packages/brain/src/token-memory.ts`)
- [x] `tokenProfile` from Part II §6 inputs (liquidity, age, top-10 holder %, 24h volume)
- [x] percentile normalization across the observed universe at `asOf`; null score when the
      universe has <10 peers or inputs are missing — never fabricate
- [x] `outcomes` via change 1's shared `wilsonInterval` + recency weighting (30d)
- [x] `tokenMemoryAsOf(db, mint, asOf)`

## 4. Market Memory (`packages/brain/src/market-memory.ts`)
- [x] `marketMemory(db, domain, asOf)` — group `brain_setup_memory` by regime dimension
- [x] docstring explaining why this is a query and not a table (§16 vs Part II §8)

## 5. Brain facade (`packages/brain/src/brain.ts`)
- [x] `createBrain(db, domain)` returning the `Brain` interface; every method takes `asOf`
- [x] domain-inappropriate methods throw `ValidationError`
- [x] export from `packages/brain/src/index.ts`

## 6. Tests
- [x] wallet: unrated below 10; recency weighting; `asOf` excludes later trades
- [x] token: null score on missing inputs / thin universe; Wilson matches shared helper
- [x] market: regime grouping; one setup → one bucket
- [x] facade: perp `.wallet()` throws; `asOf` requirement enforced by a COMPILE-TIME guard in
      brain.ts (verified to actually fail `tsc --build` when a signature is loosened), with a
      runtime assertion that the guard is still wired
- [x] pure partition test: regime buckets are disjoint AND cover the whole cell space — the
      "exactly one bucket" invariant, asserted where concurrency cannot reach it
- [x] typecheck + full suite green

## 7. Wrap-up
- [x] plan sync: `BrainTokenMemory` field list is a build-time derivation — record it in the
      archived proposal so §13's entity list and the schema stay reconcilable
- [x] ARCHIVE + completion summary
