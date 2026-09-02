# Tasks: m5-historical-edge

## 1. Backoff ladder (`packages/brain/src/backoff.ts`)
- [ ] `MEMECOIN_LADDER` (6 rungs) / `PERP_LADDER` (9 rungs) derived from the dimension lists in
      ascending composite-weight order, alphabetical tiebreak — with a comment naming the
      Part II §9 / Part III §3 tables the order comes from
- [ ] `laddersFor(domain)` + `rungFingerprints(domain, features)` → ordered setupIds
- [ ] dropped dimensions are OMITTED from the hash (arity encoded), never bucketed to MED
- [ ] reserved global-base-rate setupId per domain (`__global__:<domain>`)

## 2. Materialized rung writes (extends change 1's write path)
- [ ] `updateSetupMemory` also upserts each coarser rung + the global row for the same
      occurrence (one occurrence row per rung, sharing prediction_id + rung depth in the
      unique key so idempotency still holds)
- [ ] migration if the occurrence unique key needs `(prediction_id, setup_id)` — check before
      generating; do not blindly add a migration

## 3. Read path (`packages/brain/src/historical-edge.ts`)
- [ ] `historicalEdge(db, domain, features, asOf)` → the `HistoricalEdge` contract in design.md
- [ ] walks the ladder, stops at first rung with effectiveN ≥ 10, records `backoffDepth`
- [ ] `evidence: SUFFICIENT` only when RUNG 0 cleared (§8 explicit-state semantics)
- [ ] score = `sign(winRate−0.5) × min(1,|winRate−0.5|×2) × (1−ciWidth) × 0.5^backoffDepth`,
      with the amplify-not-counter sign convention documented inline (§40.16 step 4)
- [ ] **no** `current…()` / `latest()` accessor — `asOf` is required (rules 11/21/22)

## 4. Replace the M4 stubs
- [ ] `packages/agents/src/perp/features/historical-edge.ts` (§40.16) replaces
      `historical-edge-stub.ts`; delete the stub, keep the exported type name stable
- [ ] `packages/agents/src/memecoin/features/historical-edge.ts` (§40.19) — new
- [ ] `confidence.ts` — `historicalEvidence` becomes `f(effectiveN, ciWidth)`, 0.25 when
      INSUFFICIENT; remove the `M4 stub` comment and the 0.5 default

## 5. Composite wiring
- [ ] Feature Aggregator accepts the `historical_edge` feature contribution
- [ ] default ScoringConfig for both domains carries `historical_edge: 0.05` (Part II §9 /
      Part III §3); confirm weights still sum to 1.00 in `validateScoringConfig`
- [ ] Signal Engine passes `asOf = the primary-TF close time`, not wall clock

## 6. Tests
- [ ] `backoff.test.ts` — ladder order; arity collision; global rung reachable
- [ ] `historical-edge.test.ts` — first-clearing rung wins; §8's 7-occurrence/86% worked
      example reports INSUFFICIENT + parent rate; sign follows winRate−0.5; narrow CI beats
      wide at equal win rate; each rung halves contribution; global ≈ 0
- [ ] `confidence.test.ts` extended — 0.25 on INSUFFICIENT, rises with effective-n, falls
      with CI width
- [ ] point-in-time: occurrence closed after `asOf` cannot influence the answer
- [ ] empty-Brain regression: composite output numerically unchanged vs M4 when the Brain has
      no occurrences
- [ ] typecheck + full suite green

## 7. Wrap-up
- [ ] plan sync: if the `historical_edge` weight key needs naming in §8's ScoringConfig block,
      amend the plan **in this PR** (CLAUDE.md "when a task is done")
- [ ] ARCHIVE + completion summary
