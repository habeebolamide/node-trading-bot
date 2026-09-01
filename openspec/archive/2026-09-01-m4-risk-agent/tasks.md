# Tasks: m4-risk-agent

`[x]` done — **M4 (all 5) complete.**

## 1. Schema (migration 0008) — applied
- [x] `signal_risk` (signal_id PK, risk_level, risk_flags text[], evaluated_at, agent_version)

## 2. Modules
- [x] `common/risk-checks.ts` — pure `evaluatePerpRisk` / `evaluateMemecoinRisk` +
      `levelFor(flagCount)` (0→LOW, 1→MEDIUM, 2→MEDIUM_HIGH, 3→HIGH, 4+→INVALIDATED)
- [x] `common/risk-agent.ts` — `createRiskAgent(deps)` wraps loaders + persist + state
      transition; publishes `signal.invalidated` on INVALIDATED; skips non-ACTIVE signals

## 3. Tests
- [x] unit: risk-checks (12) — clean LOW; each perp check (SR proximity LONG+SHORT, funding
      extreme LONG+SHORT, OI extreme, price extended, aggregate → MEDIUM_HIGH, 4+ →
      INVALIDATED); memecoin (freshness, thin-pool, wallet-below-median, aggregate)
- [x] integration (live DB): LOW verdict writes signal_risk + signal stays ACTIVE;
      INVALIDATED verdict flips state + publishes signal.invalidated; non-ACTIVE signal
      is skipped idempotently

## 4. Wrap-up
- [x] typecheck + full suite green (239/242 tests pass, 3 opt-in live skipped)
- [x] ARCHIVE + summary
- [x] **M4 (all 5 changes) complete.**
