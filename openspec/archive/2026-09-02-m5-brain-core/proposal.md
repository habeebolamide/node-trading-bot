# Change: m5-brain-core

> **COMPLETED 2026-09-02.** Created `packages/brain` (`@tip/brain`) and landed the Brain's
> statistical core:
> - `stats.ts` — `wilsonInterval` on fractional effective counts, `confidenceToZ` (throws
>   rather than approximating an untabulated level), `recencyWeight` = `0.5^(age/halflife)`,
>   `weightedMedian` (non-mutating).
> - `fingerprint.ts` — fixed-cut tertile bucketing at ∓1/3 (boundaries land MED), canonical
>   dimension orders, `setupFingerprint(domain, features, retain?)` with arity encoded in the
>   hashed string so a narrowed backoff tuple can never collide with a full one. Throws on a
>   missing dimension — never fingerprints a partial tuple (rule 24).
> - `setup-memory.ts` — `updateSetupMemory` per §41 exactly; `readSetupMemory` exact-cell only
>   (backoff is change 2). Half-lives perp 90d / memecoin 30d, trust bar effective-n 10.
>
> Migration 0009: `brain_setup_occurrence` (append-only, `unique(prediction_id, setup_id)`) +
> `brain_setup_memory` (derived aggregate).
>
> **Verified:** typecheck green; **291/294 tests pass** (3 opt-in live), 52 new —
> stats (22), fingerprint (18, including the mandated 243-cell memecoin and 6,561-cell perp
> coverage assertions), setup-memory live-DB integration (12).
>
> **Deviations from spec — two, both deliberate:**
> 1. **Occurrences are an append-only child table, not §41's in-row JSONB array.** Rule 8
>    (occurrences are immutable outcome facts) and rule 12 (`unique(prediction_id, setup_id)`
>    gives DB-level replay idempotency where an array needs the check-then-write §29 forbids).
>    §41's math and function signature are followed exactly; §13 notes the schema is a
>    build-time derivation.
> 2. **The occurrence read filters `closedAt <= now`**, which §41's reference code does not do.
>    Under §41's own assumption of chronological arrival the two are identical. They diverge
>    only when an old outcome arrives late, where unfiltered iteration would give newer
>    occurrences a negative age and therefore weight > 1, silently inflating effectiveN.
>    Covered by the "out-of-order arrival" integration test.
>
> **Correction made during the build:** the first draft of the Wilson test asserted a
> textbook-quoted `[0.3133, 0.8325]` for 6/10; the implementation returns `[0.3126695,
> 0.8318224]`, which is what §41's formula yields at z = 1.96. The test constant was wrong,
> not the code — the test now carries the hand-derivation inline.
>
> **What M6 must call:** `updateSetupMemory(db, outcome)` from the outcome-resolution event
> handler in the paper engine (§41). Until then the table is legitimately empty and every read
> returns INSUFFICIENT.

**Status:** COMPLETED — archived
**Original status:** PROPOSED (scoping)
**Milestone:** M5 — Brain (change 1 of 4)
**Implements:** §15 Brain Architecture · §16 Brain Memory Types · Part II §8 Memecoin Brain
Memory Types (fingerprinting, Wilson-on-effective-n, recency decay, INSUFFICIENT state) ·
Part III §6 Perp Brain Memory Types · **§41 Reference Function: BrainSetupMemory Update** ·
Task 6 (§34) statistical smoothing / minimum sample sizes · §33 rules 8, 16, 23, 24

## What's changing

Creates `packages/brain` — the shared per-domain Brain (§15: one Memecoin Brain, one Perp
Brain; **not** per-TradingAgent) — and lands its statistical core:

1. **`packages/brain`** (new workspace, `@tip/brain`). Justified by §28 repo layout, which
   names it explicitly; this is not a discretionary new package.
2. **Setup fingerprinting** (Part II §8, rule 24) — the discretized-hash `setupId` for both
   domains. Memecoin: 5-feature tuple → 3⁵ = 243 cells. Perp: 8-dimension tuple → 3⁸ = 6,561
   cells. Computed from the domain's **full** feature set, never a TradingAgent's enabled
   subset (rule 24).
3. **`wilsonInterval()`** (§41) — Wilson score interval on **fractional effective counts**,
   not integer raw counts. This is the single most bug-prone function in the system; §41
   exists specifically to preempt the "decay applied to wins but not n" corruption.
4. **`weightedMedian()`** (§41) — cumulative-weight-crosses-half algorithm.
5. **`updateSetupMemory()`** (§41) — exponential recency decay `0.5^(age/halflife)`,
   half-lives perp 90d / memecoin 30d (Task 6); recomputes `effectiveN`, `effectiveWins`,
   `winRate`, `medianReturn` across all occurrences; Wilson CI written only at
   `effectiveN ≥ 10`, else `evidence: INSUFFICIENT`. **Write-side never backs off** — that's
   the read-side's job (change 2).
6. **Schema:** `brain_setup_memory` (aggregate row, keyed `setupId`) +
   `brain_setup_occurrence` (append-only occurrence log). Migration 0009.

## Why now

§41 is the reference implementation CLAUDE.md names as the canonical code-style example, and
its unit tests are the largest single block on CLAUDE.md's "Mandatory unit tests" list. Every
other M5 change reads what this one writes. Nothing downstream (historical edge, agent memory,
M6 outcome resolution) can be correct if this is subtly wrong.

## What this change does NOT do

- **Does not wire the call site.** §41 states `updateSetupMemory` is called "on every closed
  prediction, from the outcome-resolution event handler in the paper engine." The paper engine
  is **M6**. M5 delivers the tested function; M6 calls it. This is the plan's own build order
  (§30), not a deferral.
- **Does not do read-side hierarchical backoff** — change 2 (`m5-historical-edge`).
- **Does not touch `signalFingerprint`** in `@tip/trading-agents`. That is the §9 *signal
  dedup* hash `(tradingAgentId, symbol, direction, tfCloseMinute)` — a different thing from
  `setupId`, which hashes the *bucketed feature tuple*. Both keep their names; the docstrings
  will cross-reference so the distinction can't erode.
- **Does not add hypothesis-eligibility gating** (§24, effective-n ≥ 20). Different bar,
  different call site, M7.

## Ambiguity resolved (needs sign-off)

**The perp fingerprint tuple is under-specified and the obvious reading is circular.** See
`design.md` § "Perp tuple" for the full argument. Short version: Part III §3's weight table has
8 rows, one of which is *Historical Edge itself* — including it in the fingerprint would mean
needing the Setup Memory read to compute the key for the Setup Memory read. Resolution: perp's
8 tertile dimensions are the 7 non-circular composite inputs **plus Volatility (ATR ratio)** as
its own dimension, giving 3⁸ = 6,561 — which matches CLAUDE.md's stated "6,500 for perp" test
target, whereas dropping to 7 dimensions would give 2,187 and miss it.
