# Tasks: m2-trade-reconstruction

`[ ]` todo · `[x]` done  (SCOPING — not yet started)

## 1. Package + schema
- [ ] `packages/wallets` (`@tip/wallets`, deps domain/database/ingestion) + tsconfig + root ref + alias
- [ ] migration 0002: `wallet_trade` table (see design.md)

## 2. Reconstruction
- [ ] `reconstruct.ts` — pure average-cost round-trip reconstruction (open/close/re-entry/oversell)
- [ ] persist side: recompute a (wallet, mint)'s trades transactionally (delete-then-insert)

## 3. Backfill
- [ ] `backfill.ts` — page HeliusRestClient.getAddressTransactions → upsert wallet_transaction →
      reconstruct
- [ ] `scripts/src/backfill-wallet.ts` CLI (--addresses / --file); `backfill-wallet` npm script

## 4. Tests
- [ ] unit: reconstruction (single, partial→close, re-entry=2 trades, OPEN, oversell clamp+flag,
      all-loss, zero-cost guard)
- [ ] integration (live DB): seed swaps → reconstruct → correct realized returns; re-run idempotent
- [ ] opt-in (HELIUS_LIVE=1): backfill one real address end-to-end

## 5. Wrap-up
- [ ] typecheck + test green
- [ ] ARCHIVE + summary

## Blocked / gates
- Nothing blocks THIS change. It gates nothing on the early-entry decision.
- change 2 (m2-wallet-scoring) is BLOCKED on the early-entry data-source decision (review ask).
