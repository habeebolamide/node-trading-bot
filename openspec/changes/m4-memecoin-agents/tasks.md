# Tasks: m4-memecoin-agents

`[ ]` todo · `[x]` done (SCOPING — depends on changes 1 & 2)

## 1. Package
- [ ] `packages/agents` (`@tip/agents`) + tsconfig + root ref + vitest alias

## 2. Common infrastructure
- [ ] `common/trigger-router.ts` — routes DomainEvents to matching AnalysisAgents
- [ ] `common/token-candle.ts` — on-demand OHLCV from wallet_transaction per mint/tf, cached

## 3. Memecoin agents (5) + hard veto
- [ ] `memecoin/smart-money.ts` (§40.7)
- [ ] `memecoin/convergence.ts` (§40.8)
- [ ] `memecoin/momentum.ts` (§40.9)
- [ ] `memecoin/token-quality.ts` (§40.10)
- [ ] `memecoin/market-regime.ts` (§40.11)
- [ ] `memecoin/token-risk.ts` (§40.13 hard veto → publishes token.risk.vetoed)

## 4. Features
- [ ] `memecoin/features/early-entry.ts` (§40.17 — reads BrainWalletMemory.earlyEntry)
- [ ] `memecoin/features/freshness.ts` (§40.18 — exp(-Δt/τ))

## 5. Registration
- [ ] `memecoin/index.ts` — registers all 5 agents + Token Risk + features with the trigger router

## 6. Tests
- [ ] unit per agent (5 agents × ≥3 cases + Token Risk 5 veto cases)
- [ ] unit: features (early-entry null-on-gap, freshness τ default)
- [ ] integration (live DB): buy event → agents fire → aggregator flushes → signal row created

## 7. Wrap-up
- [ ] typecheck + suite green; ARCHIVE + summary
