# Change: m7-trade-autopsy

**Status:** COMPLETED — archived 2026-09-02
**Original status:** PROPOSED (scoping)

> **COMPLETED.** New `packages/agents/perp/autopsy/`:
> - `schema.ts` — Zod `AutopsyOutput` with capped strings/arrays; `validateOutcomeFields`
>   enforces §24's "WIN → successFactor / LOSS → failureCategory" rule at the Zod boundary.
> - `prompts.ts` — `AUTOPSY_PROMPTS[AUTOPSY_VERSION_CURRENT]`; prompt change bumps version.
> - `evidence.ts` — three-part evidence package bounded to `[T0, T2]` via `AsOfMarketData(T2)`.
>   Candles + OI downsampled to ~40 points to guard the prompt against runaway token usage.
> - `runner.ts` — `autopsyOne({db,llm}, event)`: perp-only (memecoin throws §24 citation);
>   idempotent by `unique(prediction_id)`; UPSERT so a FAILED_LLM row can be retried in place.
>
> Migration 0019: `trade_autopsy` with CHECK
> `(WIN → successFactor NOT NULL) OR (LOSS → failureCategory NOT NULL) OR (FAILED_LLM → both null)`.
>
> **Verified:** typecheck green; **584/587 tests pass** (3 opt-in live). 12 new — schema (6 incl.
> caps + WIN/LOSS invariant), integration (6 incl. memecoin refused, SUCCESS WIN/LOSS with the
> right field populated, invariant violation → FAILED_LLM instead of a bad row, retry of
> FAILED_LLM upserts the same row, idempotent replay).
**Milestone:** M7 (change 5 of 6)
**Implements:** §24 Trade Autopsy · §24 evidence-package structure · §23 (autopsy in the LLM
value question) · §33 rules 13, 14 · §13 (`TradeAutopsy` entity)

## What's changing

The post-outcome LLM call, one per resolved PERP prediction, symmetric WIN + LOSS. NOT the
hypothesis pipeline — that is change 6. This change writes autopsy ROWS; change 6 aggregates
them into hypotheses.

1. **`trade_autopsy` table** (§13) — one row per resolved perp prediction. Fields per §24's
   structured output: `outcome (WIN|LOSS)`, `rootCause`, `failureCategory` (LOSS-only),
   `successFactor` (WIN-only), `explanation`, `contributingFactors[]`, `agentFailures[]`,
   `lesson`, `recommendation`. Plus `setupId` (the fingerprint) so change 6 aggregates cleanly.
   Constraint: exactly one of `failureCategory` / `successFactor` populated (CHECK).
2. **Autopsy runner** — subscribes `prediction.resolved` (planning horizon). PERP ONLY —
   §24 explicitly defers memecoin autopsy until memecoin has a backtest. Refuses memecoin with
   the §24 citation.
3. **Evidence package (§24 verbatim, three parts):**
   - What the system believed (immutable T0 snapshot: agent scores, composite, direction,
     entry, SL, TP)
   - What actually happened (timestamped market evolution over the T0→T2 window + how agent
     outputs evolved)
   - Surrounding raw market data (OHLCV + funding + OI + long/short + regime over the window)
4. **No-look-ahead boundary (§24 last paragraph)** — the ORIGINAL prediction may only use data
   ≤ T0; the AUTOPSY may use T0→T2; nothing the autopsy learns feeds back into the original
   prediction or its backtest. Rule 21 for autopsies.
5. **Prompt versioning** — `AUTOPSY_VERSION_CURRENT` parallel to Judge; version bump on any
   prompt change (rule against blending track records).
6. **LLM failure ≠ silent skip.** A failed autopsy call writes a `trade_autopsy` row with
   `outcome` populated and every other field null + `errorKind` on the log; a re-run picks it
   up. §23's autopsy cost/promotion metric would be silently biased downward otherwise.

## Why symmetric (WIN + LOSS), and why perp only

§24 verbatim: "symmetric (WIN + LOSS), PERP ONLY in MVP." Rationale for symmetric: `successFactor`
(e.g. `MOMENTUM_CONFIRMED_EARLY`, `REGIME_ALIGNED`) is as valuable as `failureCategory` to the
hypothesis pipeline — Setup Memory learns not just what a setup does wrong, but what it does
right, at roughly 2× the LLM cost of loss-only. Memecoin deferred structurally: §25 gives it no
backtest, so a hypothesis has no promotion path — the autopsy tag would sit forever in
`PROPOSED` (§24 memecoin deferral paragraph). Explicit refusal with the §24 citation, not silent
skip.

## What this change does NOT do

- **No aggregation, no hypothesis proposal.** Change 6.
- **No weight edits.** §24 verbatim: "Hard rule — no direct weight changes from a single autopsy,
  or even from an LLM's aggregate opinion." §16 descriptive-not-prescriptive applies here too.
- **No memecoin autopsy** — refused with §24 citation.
