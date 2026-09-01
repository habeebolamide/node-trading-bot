# Design: m3-funder-clustering

Read Part II §5 alongside.

## Fetching a wallet's funder

Helius returns a wallet's parsed transactions; walk them oldest-first, finding the earliest
`nativeTransfers` entry to the wallet whose amount >= threshold (default 0.05 SOL). Record the
sender as the wallet's first-hop funder.

```
findFirstFunder(rest, wallet):
  before = undefined
  loop:                                          # page backwards to the oldest
    page = rest.getAddressTransactionsPage(wallet, {before, limit: 100})
    if page.rawCount == 0: return null
    before = page.lastSignature
    if page.rawCount < 100: break                # reached genesis
  # now walk the oldest page forward
  scan oldest→newest, first native transfer TO wallet with amount>=THRESHOLD_LAMPORTS:
    return { funder: sender, at: blockTime, sol: amount/1e9 }
```

Cached in `wallet_funder` — never re-fetched for a wallet that already has a row.

**Cost caveat:** paging to genesis on a very active wallet can be many pages. Cap at
`MAX_PAGES_TO_GENESIS = 20` (2,000 txns). If we hit the cap, take the oldest transfer we saw
and flag `funderInferredAtCap=true` (design cell on the row). MVP-acceptable — the funder for
a wallet with >2,000 txns is almost never in the same 48h window as a fresh wallet anyway, so
imprecision here doesn't affect clustering quality.

## Clustering (pure)

```
cluster([{wallet, funder, at}]) :
  # group by funder
  groups = group by funder
  clusters = []
  for group in groups:
    # sort by at, sliding 48h window
    sort group by at
    session = [first]
    for row in group[1:]:
      if row.at - session.last.at <= 48h: session.push(row)
      else:
        if session.length >= 2: clusters.push(session as cluster)
        session = [row]
    if session.length >= 2: clusters.push(session as cluster)
  return clusters
```

Deterministic, pure — unit-tested. Only clusters of size ≥ 2 are stored (a singleton isn't a
cluster).

## Schema (migration 0005)

```
wallet_funder {
  wallet_id text PK,
  funder_address text not null,
  funded_at timestamptz not null,
  funded_sol numeric not null,
  fetched_at timestamptz not null default now(),
  inferred_at_cap boolean not null default false,
  index (funder_address)
}

cluster_run {
  run_id text PK (uuid),
  run_at timestamptz not null default now(),
  window_hours integer not null,
  wallet_count integer not null,
  cluster_count integer not null,
  status text not null default 'active'   -- 'active' | 'superseded'
}

wallet_cluster {
  id text PK (uuid),
  cluster_id text not null,               -- shared across all members of one cluster
  wallet_id text not null,
  cluster_run_id text not null,
  clustered_at timestamptz not null default now(),
  index (cluster_run_id, cluster_id),
  index (wallet_id, cluster_run_id)
}
```

**Versioning:** every run gets its own `run_id`. On completion the new run flips `status =
active`, and any prior active run flips to `superseded`. Convergence readers (change 3) always
join to `cluster_run.status = 'active'`, so a mid-flight re-cluster never returns partial data.

## Recompute job

```
recomputeClusters(db, rest, opts):
  1. rated = wallets WHERE status='rated'
  2. for each rated wallet without a wallet_funder row: findFirstFunder + insert
  3. rows = SELECT wallet_id, funder_address, funded_at FROM wallet_funder
       WHERE wallet_id IN rated
  4. clusters = cluster(rows, window=opts.windowHours ?? 48)
  5. insert cluster_run + wallet_cluster rows
  6. mark prior active run as superseded
  → returns { runId, clusterCount, walletsClustered }
```

Runs on schedule (daily by default) or on demand via a CLI script. Idempotent per wallet
(the funder fetch caches), so a re-run only fetches funders for newly-rated wallets.

## Testing

Unit (pure):
- `cluster()` with fixtures — same-funder-within-48h → cluster; same-funder-outside-48h →
  no cluster; ≥3 wallets same funder → one cluster of all; disjoint funders → separate clusters.
- Sliding window at boundaries (exactly 48h, 48h+1s).

Integration (live Postgres):
- Seed a few wallets with a fake shared funder → recompute → cluster_run active + members
  present. Re-run → new active run, old marked superseded, active view returns the new one.

Opt-in live Helius (HELIUS_LIVE=1):
- `findFirstFunder(BTf4A2exGK9…)` returns a real funder without crashing on paging.
