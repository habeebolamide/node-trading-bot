# Tasks: m5-historical-edge

`[x]` done — **45 new tests, 336/339 suite green.**

## 1. Backoff ladder (`packages/brain/src/backoff.ts`)
- [x] `MEMECOIN_LADDER` (6 rungs) / `PERP_LADDER` (9 rungs) derived from the dimension lists in
      ascending composite-weight order, alphabetical tiebreak — with a comment naming the
      Part II §9 / Part III §3 tables the order comes from
- [x] `laddersFor(domain)` + `rungFingerprints(domain, features)` → ordered setupIds
- [x] dropped dimensions are OMITTED from the hash (arity encoded), never bucketed to MED
- [x] reserved global-base-rate setupId per domain (`__global__:<domain>`)

## 2. Materialized rung writes (extends change 1's write path)
- [x] `updateSetupMemory` also upserts each coarser rung + the global row for the same
      occurrence (one occurrence row per rung, sharing prediction_id + rung depth in the
      unique key so idempotency still holds)
- [x] no migration needed — m5-brain-core already keyed the occurrence unique index on
      `(prediction_id, setup_id)`, so each rung inserts cleanly and replay stays idempotent

## 3. Read path (`packages/brain/src/historical-edge.ts`)
- [x] `historicalEdge(db, domain, features, asOf)` → the `HistoricalEdge` contract in design.md
- [x] walks the ladder, stops at first rung with effectiveN ≥ 10, records `backoffDepth`
- [x] `evidence: SUFFICIENT` only when RUNG 0 cleared (§8 explicit-state semantics)
- [x] score = `sign(winRate−0.5) × min(1,|winRate−0.5|×2) × (1−ciWidth) × 0.5^backoffDepth`,
      with the amplify-not-counter sign convention documented inline (§40.16 step 4)
- [x] **no** `current…()` / `latest()` accessor — `asOf` is required (rules 11/21/22)

## 4. Replace the M4 stubs
- [x] `packages/agents/src/perp/features/historical-edge.ts` (§40.16) replaces
      `historical-edge-stub.ts`; delete the stub, keep the exported type name stable
- [x] `packages/agents/src/memecoin/features/historical-edge.ts` (§40.19) — new
- [x] `confidence.ts` — `historicalEvidence` becomes `f(effectiveN, ciWidth)`, 0.25 when
      INSUFFICIENT; remove the `M4 stub` comment and the 0.5 default

## 5. Composite wiring
- [x] Feature Aggregator accepts the `historical_edge` feature contribution
- [x] default ScoringConfig for both domains carries `historical_edge: 0.05` (Part II §9 /
      Part III §3); confirm weights still sum to 1.00 in `validateScoringConfig`
- [x] Signal Engine passes `asOf = the primary-TF close time`, not wall clock

## 6. Tests
- [x] `backoff.test.ts` — ladder order; arity collision; global rung reachable
- [x] `historical-edge.test.ts` — first-clearing rung wins; §8's 7-occurrence/86% worked
      example reports INSUFFICIENT + parent rate; sign follows winRate−0.5; narrow CI beats
      wide at equal win rate; each rung halves contribution; global ≈ 0
- [x] `confidence.test.ts` extended — 0.25 on INSUFFICIENT, rises with effective-n, falls
      with CI width
- [x] point-in-time: occurrence closed after `asOf` cannot influence the answer
- [x] empty-Brain regression: composite output numerically unchanged vs M4 when the Brain has
      no occurrences
- [x] typecheck + full suite green

## 7. Wrap-up
- [x] plan sync: no plan amendment needed — `agentWeights` is already spec'd in §8 as a
      free-form `Record<agentKey, number>` with "absent key = disabled", and §40 already
      establishes that Features carry weights in that same map. `DEFAULT_AGENT_WEIGHTS`
      transcribes Part II §9 / Part III §3 verbatim rather than adding a new config field.
- [x] design.md updated in-PR: perp drop order changed to surrender `volatility` first
- [x] ARCHIVE + completion summary
