# Change: m5-brain-core

**Status:** PROPOSED (scoping)
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
