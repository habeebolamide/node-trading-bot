# Tasks: m2-trade-reconstruction

`[x]` done

## 1. Package + schema
- [x] `packages/wallets` (`@tip/wallets`, deps domain/database/ingestion) + tsconfig + root ref + alias
- [x] migration 0002: `wallet_trade` table (applied to local DB)

## 2. Reconstruction
- [x] `reconstruct.ts` — pure average-cost round-trip reconstruction (open/close/re-entry/oversell/
      dust-close/zero-cost guard); zero-import pure module
- [x] `persist.ts` — recompute a (wallet, mint)'s trades transactionally (delete-then-insert);
      `reconstructWallet` recomputes every mint a wallet touched

## 3. Backfill
- [x] added `HeliusRestClient.getAddressTransactionsPage` (raw cursor+count for reliable paging)
- [x] `backfill.ts` — page Helius history → upsert wallet_transaction (tx_hash idempotent) →
      reconstruct
- [x] `scripts/src/backfill-wallet.ts` CLI (--addresses / --file) + `backfill-wallet` npm script

## 4. Tests
- [x] unit: reconstruction — 9 cases (single, partial→close, re-entry=2, OPEN, dust-close,
      oversell clamp+flag, no-position sell skipped, zero-cost guard, unordered-input sort)
- [x] integration (live DB): seed swaps → 2 closed trades w/ correct realized returns; re-run
      idempotent (still 2)
- [x] live smoke: full backfill chain ran against real Helius (paged→parsed→persisted→
      reconstructed) with no error (canary is a program acct → 0 swaps, correct); real trader
      wallets exercised in change 3's seed run

## 5. Wrap-up
- [x] typecheck + full suite green (80 pass, 3 opt-in skipped)
- [x] ARCHIVE → `openspec/archive/2026-09-01-m2-trade-reconstruction/` + summary
