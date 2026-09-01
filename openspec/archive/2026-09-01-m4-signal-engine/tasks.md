# Tasks: m4-signal-engine

`[x]` done

## 1. Schema (migration 0007) — applied
- [x] `signal` (PK, config_version FK, unique fingerprint, state, ACTIVE default) +
      `signal_feature` (composite PK on signal_id + agent_key + agent_version)

## 2. Modules
- [x] `scoring.ts` — deterministic composeSignal (weight renormalization per §7 rule 1,
      directionFromComposite for perp 6-bucket + memecoin 4-bucket long-only, agentAgreement math,
      absent-key=disabled, CONDITIONAL-skip exclusion, [-1,+1] clamp)
- [x] `confidence.ts` — Task-6 formula, defensive weight renormalization, historicalEvidence
      stub default 0.5, dataQuality = clamp(1 - penalties), |compositeScore| for signalStrength
- [x] `fingerprint.ts` — sha256(agentId|symbol|direction|minute) hex prefix
- [x] `feature-aggregator.ts` — per-bucket collection, per-(agent,version) newer-wins dedup,
      debounce close, forceFlushBucket, drainAll
- [x] `signal-lifecycle.ts` — pure state machine + canTransition/assertTransition
- [x] `signal-store.ts` — createSignal (Signal + signal_feature rows in one txn, unique
      fingerprint deduped via onConflictDoNothing → returns {created: false}); transitionSignal
- [x] `signal-engine.ts` — orchestrator (SignalEngine): admit → aggregator → performFlush →
      compose → confidence → fingerprint → createSignal → publish SIGNAL_CREATED + domain event

## 3. Tests
- [x] unit: scoring (8) — bucket mapping, memecoin long-only, weight renorm across rosters,
      absent-key disabled, CONDITIONAL skip, agentAgreement 100%/50%, [-1,+1] clamp
- [x] unit: confidence (6) — all-1 → 1, all-0 → 0, historicalEvidence stub, weight renorm,
      |compositeScore| symmetry, dataQuality clamp
- [x] unit: fingerprint (3) — same-minute dedup, different-minute unique, per-axis uniqueness
- [x] unit: lifecycle (3) — ACTIVE → all 3 terminals; terminals frozen; assertTransition throws
- [x] unit: aggregator (5) — bucket collect + debounce close, per-(agent,version) newer-wins,
      version-bump distinct, multi-bucket independence, drainAll
- [x] integration (live DB): 2 agent outputs → forceFlushBucket → signal + 2 signal_feature rows
      + both SIGNAL_CREATED and PERP_SIGNAL_CREATED events published; re-arrival same fingerprint
      → still one row (DB unique dedups)

## 4. Wrap-up
- [x] typecheck + full suite green (181/184 tests pass, 3 opt-in live skipped)
- [x] ARCHIVE + summary
