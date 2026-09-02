# Change: m5-historical-edge

**Status:** PROPOSED (scoping)
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
