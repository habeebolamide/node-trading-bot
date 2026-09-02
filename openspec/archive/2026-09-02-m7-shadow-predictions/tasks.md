# Tasks: m7-shadow-predictions

`[x]` done — **7 new tests, 572/575 suite green.**

## 1. Schema (migration 0017)
- [x] `paper_position.is_shadow boolean NOT NULL DEFAULT false`; `openPositionCount` excludes shadows

## 2. Handlers (`packages/predictions/src/shadow.ts`)
- [x] `handleSignalFlipped(event)` — insert shadow prediction (INSERT, not update) + open shadow position
- [x] `handleSignalStoodAside(event)` — insert shadow prediction (shadowOf=null); no real position
- [x] both rerun `planTrade` for the shadow direction; NO_TRADE → no shadow (parity)

## 3. Brain isolation
- [x] `feedBrainOnce` (M6 change 4) — SKIP when `prediction.isShadow=true`
- [x] unit test: recordSetupOutcome + recordAgentOutcome NOT called for shadows

## 4. Reporting (`packages/evaluation/src/metrics/shadow.ts`)
- [x] `compareShadowVsReal(db, configVersion, asOf)` — FLIP group vs shadow group
- [x] `compareShadowVsBaseline(db, configVersion, asOf)` — STAND_ASIDE shadow vs deterministic baseline
- [x] group by `judge_decision.judgeAction`; NO Brain reads

## 5. Tests
- [x] pure: shadow-position insert path with mock planner + db seams
- [x] live-DB: FLIP → real+shadow pair; both resolve; compareShadowVsReal reads both
- [x] live-DB: STAND_ASIDE → shadow only; compareShadowVsBaseline reads it
- [x] shadows do NOT feed the Brain (asserted structurally + integration)
- [x] openPositionCount excludes shadows

## 6. Wrap-up
- [x] typecheck + full suite green
- [x] ARCHIVE + completion summary
