# Tasks: m4-tradingagent

`[ ]` todo · `[x]` done (SCOPING — build not started)

## 1. Package + schema
- [ ] `packages/trading-agents` (`@tip/trading-agents`) + tsconfig + root ref + vitest alias
- [ ] migration 0006: `trading_agent`, `scoring_config` (append-only versioned),
      `agent_performance` (skeleton), `brain_agent_memory` (skeleton)

## 2. Types + validation
- [ ] `identity.ts` — TradingAgent, Domain, TradingStyle, config shape
- [ ] `config.ts` — Zod schema, domain-specific validation, ladder-write-time checks

## 3. Store + interface
- [ ] `store.ts` — TradingAgent CRUD (create writes v1 config in same txn; updateConfig writes
      new version + flips active atomically)
- [ ] `agent-interface.ts` — AnalysisAgent, AgentOutput, AgentContext, Trigger types

## 4. API endpoints
- [ ] `apps/api/src/trading-agents.ts` — POST/GET/GET-one/PATCH routes
- [ ] wire into createApp (mount only when `trading-agents` dep provided; graceful degrade)

## 5. Tests
- [ ] unit: config validation (memecoin maxConc=1, ladder cumulative, minRR bounds)
- [ ] unit: updateConfig atomic version-bump (fake db)
- [ ] integration (live DB): POST → GET, PATCH → GET returns v2
- [ ] API (supertest): 201 / 400 / 404, list + detail, PATCH

## 6. Wrap-up
- [ ] typecheck + suite green; ARCHIVE + summary
