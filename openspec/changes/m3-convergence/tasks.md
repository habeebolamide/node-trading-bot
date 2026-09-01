# Tasks: m3-convergence

`[ ]` todo · `[x]` done  (SCOPING — not yet started; depends on m3-watchlist + m3-funder-clustering)

## 1. Modules
- [ ] `batching.ts` — per-mint pen, opens on first buy, closes at batchingWindowMs
- [ ] `aggregator.ts` — pure aggregate(batch, clusters, config) → { score, perCluster, independentCount }
- [ ] `emitter.ts` — publish `memecoin.wallet.convergence.detected` with evidence package
- [ ] `claim.ts` — token-claim pre-filter stub (M4 wires the real check)

## 2. Worker wiring
- [ ] Consumer on memecoin buy queue → Batcher → Aggregator → Emitter
- [ ] Shutdown drains pending batches

## 3. Tests
- [ ] unit: aggregate — cluster dedup, timeCompression, independentCount, cap on clusterQuality
- [ ] unit: Batcher — window open/close, per-mint independence
- [ ] integration (live DB + in-memory bus): 3-cluster buys → event with independentCount=3;
      5 wallets same funder → event with independentCount=1

## 4. Wrap-up
- [ ] typecheck + suite green; ARCHIVE + summary. **M3 (all 3) complete.**
