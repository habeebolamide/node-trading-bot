# Tasks: m3-watchlist

`[ ]` todo · `[x]` done  (SCOPING — not yet started)

## 1. Package + schema
- [ ] `packages/watchlist` (`@tip/watchlist`, deps domain/database/ingestion/wallets) + tsconfig
      + root ref + vitest alias
- [ ] migration 0004: `watched_wallet` (address PK, note, watched_at, unwatched_at)
- [ ] add config var `HELIUS_WEBHOOK_URL` (optional; required for subscription reconcile)

## 2. Watchlist service
- [ ] `store.ts` — `Watchlist.add(address, note?)`: backfillWallet → scoreAllWallets →
      upsert watched_wallet (unwatched_at=null resurrects) → subscription.reconcile
- [ ] `store.ts` — `Watchlist.list()` / `remove(address)` / `get(address)`
- [ ] `subscription.ts` — `HeliusSubscriptionManager.reconcile()` calls registerOrUpdate;
      throws on >100 active (free-tier cap); `reconcileAll()` for boot drift-fix
- [ ] `buy-detector.ts` — consumer on wallet-analysis queue: watched + BUY + rated-at-T →
      publish `memecoin.wallet.buy.detected` on memecoin-ingestion queue (or new queue if needed)
- [ ] index barrel

## 3. API endpoints
- [ ] `apps/api/src/wallets.ts` — routes POST/GET/DELETE `/wallets`
- [ ] wire routes into `createApp`; extend `ApiDeps` with `watchlist`
- [ ] `apps/api/src/main.ts` — construct Watchlist + subscription manager, pass to createApp

## 4. Worker wiring
- [ ] `apps/worker/src/main.ts` — register BuyDetector; call subscription.reconcileAll() on boot

## 5. Tests
- [ ] unit: Watchlist.add (backfill+score+reconcile called, re-add idempotent, resurrect)
- [ ] unit: SubscriptionManager (correct list, >100 throws)
- [ ] unit: BuyDetector (drop unwatched/non-BUY/UNRATED-at-T, emit for rated)
- [ ] integration (live DB): end-to-end add → watched_wallet + wallet_score_event
- [ ] API (supertest): 201/200/400 for POST, GET list, DELETE
- [ ] integration (live DB + fake bus): BuyDetector emits memecoin.wallet.buy.detected

## 6. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + summary
