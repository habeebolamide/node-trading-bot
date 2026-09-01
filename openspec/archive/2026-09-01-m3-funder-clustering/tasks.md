# Tasks: m3-funder-clustering

`[x]` done

## 1. Schema (migration 0005) — applied
- [x] `wallet_funder` (unique on walletId, indexed by funder), `cluster_run` (versioned by
      status='active'|'superseded'), `wallet_cluster` (membership)

## 2. Fetch + store
- [x] `funder-fetch.ts` — `findFirstFunder` (page-to-oldest with 20-page cap, first inbound
      native ≥ 0.05 SOL, `inferredAtCap` flag on cap-truncated results)

## 3. Clustering + recompute
- [x] `cluster.ts` — pure sliding-window `cluster(rows, windowHours=48)`; ≥2 members,
      injectable id factory, dedups walletId within a session
- [x] `recompute.ts` — `recomputeClusters`: rated wallets → fetch missing funders → cluster →
      insert cluster_run + wallet_cluster + supersede prior active (all in one txn);
      `activeClusterMap` helper for change 3
- [x] `scripts/src/recompute-clusters.ts` + `recompute-clusters` npm script

## 4. Tests
- [x] unit: cluster — one shared funder→one cluster; window-split; singleton drop; disjoint
      funders→separate; boundary exactness at 48h; wallet-dup dedup (6 tests)
- [x] integration (live DB): 3 wallets same funder w/in 48h → 1 cluster; re-run supersedes
      prior active atomically; activeClusterMap reflects the active run (2 tests)

## 5. Wrap-up
- [x] typecheck + full suite green (126/129 tests pass, 3 opt-in skipped)
- [x] refactored BuyDetector to inject ScoreLookup (removed cross-test vi.mock bleed)
- [x] ARCHIVE + summary
