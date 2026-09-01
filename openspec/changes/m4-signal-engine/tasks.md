# Tasks: m4-signal-engine

`[ ]` todo · `[x]` done (SCOPING — depends on m4-tradingagent)

## 1. Schema (migration 0007)
- [ ] `signal` (PK, config_version FK, unique fingerprint, state) + `signal_feature` (composite PK)

## 2. Modules
- [ ] `feature-aggregator.ts` — per-(tradingAgentId, symbol, tfClose) bucket + debounce close
      + per-agent dedup
- [ ] `scoring.ts` — deterministic weighted composite, weight renormalization, threshold mapping
      (per domain: perp 6 buckets, memecoin 4 long-only)
- [ ] `confidence.ts` — Task-6 formula (config.confidenceWeights), historicalEvidence stub 0.5,
      dataQuality penalty hooks
- [ ] `signal-lifecycle.ts` — state machine + tick-monitor integration for TTL / invalidators
- [ ] `signal-store.ts` — persist Signal + signal_feature rows in one txn, unique fingerprint

## 3. Worker wiring
- [ ] register a SIGNAL_PROCESSING processor: consume agent.analysis.completed → aggregate →
      score → persist → publish signal.created (+ domain event)

## 4. Tests
- [ ] unit: scoring composite (renormalization, thresholds, all-neutral no-signal)
- [ ] unit: confidence (weight sum, boundaries, dataQuality penalties)
- [ ] unit: fingerprint (same-candle dedupe, different-candle unique)
- [ ] unit: state machine (ACTIVE → EXPIRED / INVALIDATED / CONSUMED)
- [ ] integration (live DB): fake outputs → signal + signal_feature rows; re-arrival deduped

## 5. Wrap-up
- [ ] typecheck + suite green; ARCHIVE + summary
