# Tasks: m2-seed-analysis

`[ ]` todo  (SCOPING — not started; depends on changes 1 & 2; needs the seed wallet roster)

## 0. Input
- [ ] obtain ~100 seed wallet addresses from the user → `scripts/seed/wallets.txt`

## 1. Seed run
- [ ] `scripts/src/seed-wallets.ts` — backfill + reconstruct + score every roster wallet
      (reuses m2 changes 1 & 2); report per-wallet score + universe summary

## 2. Analysis pass
- [ ] `analysis/co-buy.ts` — naive same-token/same-window grouping of seed-wallet buys
      (analysis-only; NOT M3 funder clustering — flagged)
- [ ] measure `batchingWindowMs` distribution (last_buy − first_buy across 3+ co-buys)
- [ ] measure `walletExitThreshold` (partial cluster-sell → full dump frequency)
- [ ] measure `profitLadder` rung reach (fraction of ≥2× co-buys reaching 3×/5×/10× via
      observed-swap post-entry max)
- [ ] measure freshness `τ` (forward-return decay vs entry delay)
- [ ] `scripts/src/seed-analysis.ts` runner ties it together

## 3. Output
- [ ] `docs/research/seed-history-analysis.md` — distributions, recommended values, sample sizes
- [ ] record recommended values for the 4 tunables (to be wired into config at M4+, with a
      comment pointer back to the doc per CLAUDE.md Placeholders rule)

## 4. Wrap-up
- [ ] typecheck + any tests green; ARCHIVE + summary. **M2 (all 3) complete.**
