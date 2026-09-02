# Change: m5-historical-edge

> **COMPLETED 2026-09-02.** The read side of Setup Memory, and the wiring that makes it reach
> the composite:
> - `backoff.ts` — the §8 staircase. `dropOrder` = ascending composite weight (Part II §9 /
>   Part III §3), alphabetical tiebreak. `ladder()` returns 6 rungs for memecoin, 9 for perp,
>   ending at a reserved global-base-rate setupId per domain.
> - `recordSetupOutcome` — ladder-aware write; materializes every rung on write so a read is a
>   keyed lookup rather than an on-demand aggregation whose answer would depend on when it ran
>   (rule 11). No migration needed: the occurrence unique key was already
>   `(prediction_id, setup_id)`.
> - `historical-edge.ts` — `historicalEdge(db, domain, features, asOf)` returning §8's explicit
>   state; `edgeScore` (sign from winRate−0.5, magnitude × (1−ciWidth) × 0.5^depth);
>   `historicalEvidenceFrom` (Task 6). **Recomputes from the occurrence log filtered to
>   `closed_at <= asOf`** rather than reading the materialized aggregate row, which reflects
>   whenever it was last written and would leak future outcomes into a historical read.
> - Stubs killed: `perp/features/historical-edge-stub.ts` deleted and replaced by a real read;
>   `memecoin/features/historical-edge.ts` added (§40.19); `confidence.ts`'s hardcoded 0.5
>   replaced by the passed-in Brain value with a `NO_BRAIN_EVIDENCE = 0.25` floor.
> - `SignalEngine` gained an injectable `FeatureProvider` seam — Features (§40) have no trigger,
>   so they are computed FROM the assembled bucket at flush. A provider throwing degrades to
>   no-Brain-evidence rather than dropping the signal.
> - `DEFAULT_AGENT_WEIGHTS` transcribes both weight tables verbatim, Historical Edge at 5%.
>
> **Verified:** typecheck green; **336/339 tests pass** (3 opt-in live), 45 new — backoff (12),
> edgeScore + historicalEvidence (13), historical-edge live-DB integration (8, including §8's
> 7-occurrence/86% worked example and a point-in-time guard proving post-`asOf` occurrences
> cannot influence the answer), confidence (4 + 1 rewritten), default weights (5), signal-engine
> feature seam (3).
>
> **Deviation from the scoped design — one, corrected in `design.md` in this PR:** the perp drop
> order now surrenders `volatility` FIRST rather than giving it market_regime's 15%. Volatility
> is the dimension m5-brain-core added to reach the stated cell count; the plan's weight table
> does not rank it, so any plan weight was arbitrary. Dropping it first makes rung 1 onward
> degrade through exactly the plan-specified 7-feature set.
>
> **Corrections made during the build** (both were bad tests, not bad code): a point-in-time test
> fed 11 occurrences 9 days old and expected them to clear the trust bar — with a 30d half-life
> that is effective-n 8.94, so the test was accidentally asserting the threshold rather than the
> `asOf` filter; and a signal-engine assertion located "its" signal by `createdAt`, which is
> wall-clock for every signal and matched an earlier test's row. Both now assert exactly what
> they claim to.
>
> **The Brain is still empty** until M6 resolves outcomes — every read returns INSUFFICIENT,
> score 0, and an explicit regression test asserts the composite is numerically unchanged from
> its M4 behaviour in that state.

**Status:** COMPLETED — archived
**Original status:** PROPOSED (scoping)
**Milestone:** M5 — Brain (change 2 of 4)
**Implements:** §40.16 Perp Historical Edge Feature · §40.19 Memecoin Historical Edge Feature ·
Part II §8 hierarchical backoff + explicit INSUFFICIENT state · Task 6 (§34) "historical setup
edge" + `historicalEvidence` confidence sub-metric · Part II §9 / Part III §3 composite weights
(5% both domains) · §33 rules 11/21/22

## What's changing

The **read side** of Setup Memory, and the wiring that makes it actually reach the composite.

1. **Hierarchical backoff** (`packages/brain/src/backoff.ts`) — Part II §8's discrete
   staircase: exact fingerprint → drop least-informative dimension → drop next → … → global
   base rate. Each rung is tried only when the one below it has `effectiveN < 10`. This is the
   *only* similarity mechanism (§8 explicitly rejects k-NN and weighted-similarity scoring).
2. **`historicalEdge(db, domain, features)`** — returns the §8 explicit-state object:
   `{ evidence, exactOccurrences, observedWinRate, fallback, fallbackWinRate, score,
   ciWidth, backoffDepth }`. Never surfaces a thin cell's win rate as if it were confident.
3. **Signed contribution** (§40.16 step 4): sign from `sign(winRate − 0.5)` — win rate above
   50% *amplifies* the trade's direction rather than countering it — magnitude scaled by
   Wilson CI width (narrow = strong, wide = weak), further attenuated per backoff rung so a
   global-base-rate fallback contributes ≈ 0.
4. **Replaces `packages/agents/src/perp/features/historical-edge-stub.ts`** with the real
   read, and adds the memecoin counterpart (§40.19) which does not exist yet.
5. **Un-stubs `computeConfidence`'s `historicalEvidence`** — currently hardcoded 0.5 in
   `packages/trading-agents/src/confidence.ts`. Becomes `f(effectiveN, wilsonWidth)`, low when
   INSUFFICIENT, per Task 6.
6. **Wires Historical Edge into both composites** at its 5% weight, closing the last gap
   between the weight tables in Part II §9 / Part III §3 and what the Signal Engine actually
   sums.

## Why now

This is the change that turns M5 from "tables that will matter later" into working
intelligence. After change 1 the Brain can *record*; after this one the Signal Engine can
*use* what it recorded, and two M4 stubs (`historical-edge-stub.ts`, `historicalEvidence: 0.5`)
disappear. It is also the read path M6's evaluation and M7's Judge both consume.

## Why the split from change 1 is not arbitrary

§41's implementer note is explicit: *"Parent-bucket backoff is a READ-side concern, not a
write-side one. This function never dips into the parent bucket, never recurses, and never
writes fallback stats to the exact-fingerprint row."* The rationale given is that keeping the
split means cached reads stay consistent and future backtest replays produce the same numbers.
Splitting the changes along the same seam keeps that boundary visible in the repo history.

## What this change does NOT do

- **No new similarity mechanism.** §8 rejected k-NN and weighted-similarity explicitly. Backoff
  is a discrete staircase, nothing more.
- **No "current" reads in replay paths.** The read takes an explicit `asOf` and is built on the
  `@tip/evaluation` `AsOfMarketData` discipline (rules 11/21/22) — there is no
  `currentSetupEdge()` for backtest code to call by mistake.
- **Does not populate anything.** Until M6 resolves outcomes, every read legitimately returns
  `INSUFFICIENT` → global base rate → ≈0 contribution. That is correct behaviour, not a stub,
  and the tests assert it.

## Ambiguity resolved (needs sign-off)

**Part II §8 says backoff should "drop the least-informative feature" but never defines which
feature that is.** Resolution: drop in **ascending composite weight order** — the plan already
ranks these dimensions by how much they matter, in the Part II §9 / Part III §3 weight tables,
so reusing that ranking avoids inventing a second, unvalidated informativeness ordering. Ties
break alphabetically for determinism. Full ladders in `design.md`.
