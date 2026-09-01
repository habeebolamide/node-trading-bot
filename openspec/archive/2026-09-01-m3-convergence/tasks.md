# Tasks: m3-convergence

`[x]` done

## 1. Modules
- [x] `convergence/aggregator.ts` — pure aggregate(batch, clusters, opts) → { convergenceScore,
      independentClusterCount, timeCompression, batchSpanMs, perCluster[] }; solo-wallet fallback;
      Task-6 cap on clusterQuality; (wallet, signature) dedup
- [x] `convergence/batching.ts` — per-mint Batcher with injectable timers; drainAll for shutdown
- [x] `convergence/emitter.ts` — createConvergenceEmitter (handler + batcher); registerConvergenceEmitter
      (consumer on SIGNAL_PROCESSING for MEMECOIN_WALLET_BUY_DETECTED); loads active clusters via
      activeClusterMap; publishes MEMECOIN_WALLET_CONVERGENCE_DETECTED with the full evidence package

## 2. Worker wiring
- [x] `apps/worker/src/main.ts` — registerConvergenceEmitter alongside BuyDetector when the
      Helius trio is set; shutdown calls `batcher.drainAll()` so pending pens fire before exit

## 3. Tests
- [x] unit: aggregator — timeCompressionFor (boundary), 3-distinct → count=3, shared-funder→count=1,
      solo fallback, quality cap, tight-vs-loose score, (wallet,sig) dedup (6+1 = 7 assertions across 6 tests)
- [x] unit: batcher — pen open/close per mint, multi-mint independence, drainAll (3)
- [x] unit-ish: emitter with fake bus + fake timers + injected cluster map — 3-cluster, shared-funder,
      per-mint independence, ignore-unrelated (4)

## 4. Wrap-up
- [x] typecheck + full suite green (140/143 tests pass, 3 opt-in live skipped)
- [x] ARCHIVE + summary. **M3 (all 3) complete.**
