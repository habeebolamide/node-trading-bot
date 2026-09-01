# Tasks: m3-funder-clustering

`[ ]` todo · `[x]` done  (SCOPING — not yet started; depends on m3-watchlist)

## 1. Schema (migration 0005)
- [ ] `wallet_funder`, `cluster_run`, `wallet_cluster` per design

## 2. Fetch + store
- [ ] `funder-fetch.ts` — `findFirstFunder(rest, wallet)` (page-to-oldest with 20-page cap,
      first significant native inbound ≥ 0.05 SOL, `inferred_at_cap` flag)
- [ ] `funder-store.ts` — upsert wallet_funder (skip if already present); read APIs

## 3. Clustering
- [ ] `cluster.ts` — pure `cluster(rows, windowHours)` (sliding window per funder, ≥2 members)
- [ ] `recompute.ts` — full pass: fetch missing funders → cluster → insert run + members →
      flip prior active to superseded (all in one txn)
- [ ] `scripts/src/recompute-clusters.ts` CLI

## 4. Tests
- [ ] unit: `cluster` — same-funder-in-window, out-of-window, ≥3 wallets, disjoint funders,
      exact boundary
- [ ] integration (live DB): recompute end-to-end + versioning (new active, old superseded)
- [ ] opt-in live Helius: `findFirstFunder(BTf4A2)` returns a funder

## 5. Wrap-up
- [ ] typecheck + suite green; ARCHIVE + summary
