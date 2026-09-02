# Tasks: m7-shadow-predictions

## 1. Schema (migration 0017)
- [ ] `paper_position.is_shadow boolean NOT NULL DEFAULT false`; `openPositionCount` excludes shadows

## 2. Handlers (`packages/predictions/src/shadow.ts`)
- [ ] `handleSignalFlipped(event)` — insert shadow prediction (INSERT, not update) + open shadow position
- [ ] `handleSignalStoodAside(event)` — insert shadow prediction (shadowOf=null); no real position
- [ ] both rerun `planTrade` for the shadow direction; NO_TRADE → no shadow (parity)

## 3. Brain isolation
- [ ] `feedBrainOnce` (M6 change 4) — SKIP when `prediction.isShadow=true`
- [ ] unit test: recordSetupOutcome + recordAgentOutcome NOT called for shadows

## 4. Reporting (`packages/evaluation/src/metrics/shadow.ts`)
- [ ] `compareShadowVsReal(db, configVersion, asOf)` — FLIP group vs shadow group
- [ ] `compareShadowVsBaseline(db, configVersion, asOf)` — STAND_ASIDE shadow vs deterministic baseline
- [ ] group by `judge_decision.judgeAction`; NO Brain reads

## 5. Tests
- [ ] pure: shadow-position insert path with mock planner + db seams
- [ ] live-DB: FLIP → real+shadow pair; both resolve; compareShadowVsReal reads both
- [ ] live-DB: STAND_ASIDE → shadow only; compareShadowVsBaseline reads it
- [ ] shadows do NOT feed the Brain (asserted structurally + integration)
- [ ] openPositionCount excludes shadows

## 6. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary
