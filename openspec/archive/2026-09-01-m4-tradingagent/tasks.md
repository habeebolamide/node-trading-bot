# Tasks: m4-tradingagent

`[x]` done

## 1. Package + schema
- [x] `packages/trading-agents` (`@tip/trading-agents`) + tsconfig + root ref + vitest alias
- [x] migration 0006: `trading_agent`, `scoring_config` (append-only, unique on
      (trading_agent_id, version)), `agent_performance` (skeleton), `brain_agent_memory` (skeleton)

## 2. Types + validation
- [x] `identity.ts` — TradingAgentIdentity, Domain, TradingStyle, PRIMARY_TF / SIGNAL_TTL_MS maps (§8)
- [x] `config.ts` — Zod schema + domain-aware validation (memecoin maxConc=1, ladder cumulative,
      minRR/riskPercent bounds, perp rejects memecoin fields)

## 3. Store + interface
- [x] `store.ts` — createTradingAgent (agent + v1 in one txn), getTradingAgent, listTradingAgents,
      updateTradingAgentConfig (atomic new version + flip active), setTradingAgentStatus
- [x] `agent-interface.ts` — AnalysisAgent, AgentOutput, AgentContext, Trigger, WalletScoreAsOfLookup
      (as-of readers preserve rule 21; no `latest()` exposed)

## 4. API endpoints
- [x] `apps/api/src/trading-agents.ts` — POST/GET/GET-one/PATCH routes; ValidationError → 400
- [x] wired into `createApp` (always mounted — needs only DB)

## 5. Tests
- [x] unit: config validation (7 tests — defaults, memecoin §32, ladder cumulative + ordering,
      perp-rejects-memecoin-fields, riskPercent bounds)
- [x] integration (live DB): create → v1 → PATCH → v2, both rows exist, only v2 active
- [x] API (supertest live DB): POST 201 + GET round-trip + PATCH v2; 400 on bad body;
      400 on §32 violation; 404 on unknown id

## 6. Wrap-up
- [x] typecheck + full suite green (153/156 tests pass, 3 opt-in live skipped)
- [x] ARCHIVE + summary
