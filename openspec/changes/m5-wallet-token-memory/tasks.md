# Tasks: m5-wallet-token-memory

## 1. Schema (migration 0010)
- [ ] `brain_wallet_memory` — add `behavior jsonb`
- [ ] `brain_token_memory` — new (mint PK, domain, profile, score, outcomes, evidence, updated_at)
- [ ] generate + apply

## 2. Wallet Memory (`packages/brain/src/wallet-memory.ts`)
- [ ] `recomputeWalletBehavior(db, walletId, asOf)` — median hold, avg size, trades/day,
      specialization fractions, cluster affiliations; 60d half-life (Task 6), effective-n
- [ ] unrated below effective-n 10 — explicit state, not thin aggregates
- [ ] `walletMemoryAsOf(db, walletId, asOf)` — no `current` variant (rules 21/22)

## 3. Token Memory (`packages/brain/src/token-memory.ts`)
- [ ] `tokenProfile` from Part II §6 inputs (liquidity, age, top-10 holder %, 24h volume)
- [ ] percentile normalization across the observed universe at `asOf`; null score when the
      universe has <10 peers or inputs are missing — never fabricate
- [ ] `outcomes` via change 1's shared `wilsonInterval` + recency weighting (30d)
- [ ] `tokenMemoryAsOf(db, mint, asOf)`

## 4. Market Memory (`packages/brain/src/market-memory.ts`)
- [ ] `marketMemory(db, domain, asOf)` — group `brain_setup_memory` by regime dimension
- [ ] docstring explaining why this is a query and not a table (§16 vs Part II §8)

## 5. Brain facade (`packages/brain/src/brain.ts`)
- [ ] `createBrain(db, domain)` returning the `Brain` interface; every method takes `asOf`
- [ ] domain-inappropriate methods throw `ValidationError`
- [ ] export from `packages/brain/src/index.ts`

## 6. Tests
- [ ] wallet: unrated below 10; recency weighting; `asOf` excludes later trades
- [ ] token: null score on missing inputs / thin universe; Wilson matches shared helper
- [ ] market: regime grouping; one setup → one bucket
- [ ] facade: perp `.wallet()` throws; type-level test that `asOf` is required
- [ ] typecheck + full suite green

## 7. Wrap-up
- [ ] plan sync: `BrainTokenMemory` field list is a build-time derivation — record it in the
      archived proposal so §13's entity list and the schema stay reconcilable
- [ ] ARCHIVE + completion summary
