# Tasks: m3-watchlist

`[x]` done

## 1. Package + schema
- [x] `packages/watchlist` (`@tip/watchlist`, deps domain/database/events/ingestion/wallets) +
      tsconfig + root ref + vitest alias
- [x] migration 0004: `watched_wallet` (applied)
- [x] added `HELIUS_WEBHOOK_URL` optional config var + `.env.example` note

## 2. Watchlist service
- [x] `store.ts` — `Watchlist.add` (backfill → scoreAllWallets → upsert watched_wallet with
      unwatched_at=null resurrect → subscription.reconcile); `remove` (soft-delete + reconcile);
      `list` (join wallet + liveWalletScore); `isWatched`; basic base58 address validation
- [x] `subscription.ts` — `HeliusSubscriptionManager.reconcile` (registerOrUpdate w/ active list;
      100-cap FatalError); `reconcileAll` for boot drift-fix
- [x] `buy-detector.ts` — consumer on WALLET_ANALYSIS: drop non-watched / non-BUY /
      UNRATED-at-blockTime → publish `memecoin.wallet.buy.detected` on SIGNAL_PROCESSING with
      point-in-time score
- [x] index barrel

## 3. API endpoints
- [x] `apps/api/src/wallets.ts` — POST (201 new / 200 resurrect / 400 validation) / GET /
      DELETE (204 / 404) routes; wired into `createApp` (mount only when watchlist provided)
- [x] `apps/api/src/main.ts` — construct Watchlist + SubscriptionManager when the Helius trio
      is set; log "watchlist enabled/disabled" clearly at boot

## 4. Worker wiring
- [x] `apps/worker/src/main.ts` — register BuyDetector + call `subscription.reconcileAll()`
      on boot when the Helius trio is set; graceful degradation otherwise

## 5. Tests
- [x] unit: BuyDetector (drop unwatched/SELL/UNRATED-at-T, emit for rated) — 5 tests
- [x] unit: SubscriptionManager (correct list, empty, >100 throws) — 3 tests
- [x] API (supertest): POST 201/200/400 + ValidationError, GET list, DELETE 204/404, disabled — 8 tests

## 6. Wrap-up
- [x] typecheck + full suite green (118/121 tests pass, 3 opt-in skipped)
- [x] ARCHIVE → `openspec/archive/2026-09-01-m3-watchlist/` + summary
