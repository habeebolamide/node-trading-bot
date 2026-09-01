# Tasks: m4-risk-agent

`[ ]` todo · `[x]` done (SCOPING — final change of M4; depends on 1, 2, 3, 4)

## 1. Schema (migration 0008)
- [ ] `signal_risk` (signal_id PK/FK, risk_level, risk_flags text[], evaluated_at, agent_version)

## 2. Modules
- [ ] `common/risk-agent.ts` — EVENT on signal.created; runs domain-appropriate check set;
      writes signal_risk; transitions signal to INVALIDATED when threshold hit

## 3. Worker wiring
- [ ] register Risk Agent processor on SIGNAL_PROCESSING

## 4. Tests
- [ ] unit: perp checks — each triggers correctly; direction-aware S/R; multi-flag aggregation
- [ ] unit: memecoin checks — freshness boundary, pool-share cap, wallet quality
- [ ] unit: risk_level aggregation (LOW/MEDIUM/MEDIUM_HIGH/HIGH/INVALIDATED)
- [ ] integration (live DB): signal → signal_risk written; INVALIDATED → signal state flip

## 5. Wrap-up
- [ ] typecheck + suite green; ARCHIVE + summary. **M4 (all 5 changes) complete.**
