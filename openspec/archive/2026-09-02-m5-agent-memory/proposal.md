# Change: m5-agent-memory

> **COMPLETED 2026-09-02 — M5 (all 4 changes) is done.**
> - `agent-memory.ts` — `agentLean` (signed lean; null for no-opinion; Token Risk and the Risk
>   Agent excluded outright; long-only memecoin agents at 0 read as silence, not a SHORT lean;
>   Market Regime scored on its bias per §7), `recordAgentOutcome` (one occurrence per
>   contributing agent, idempotent), `agentMemoryAsOf` / `persistAgentMemory`.
> - Facade gained `brain.agent(agentKey, agentVersion, asOf)`; the compile-time `asOf` guard now
>   covers all five reads.
>
> Migration 0011: `brain_agent_memory` populated shape (+ Risk-Agent veto columns, null until
> M7 supplies shadow predictions) and append-only `brain_agent_occurrence` with
> `unique(prediction_id, agent_key, agent_version)`.
>
> **Verified:** typecheck green; **395/398 tests pass** (3 opt-in live) across **6 consecutive
> full-suite runs**, 18 new — `agentLean` (6) and live-DB integration (12), including the core
> mechanism (a dissenter is credited when the composite loses and the dissent was right; an
> agreeing agent on a loser is debited), version isolation (v2 reads INSUFFICIENT while v1 has 30
> wins), idempotent replay, exact equality with the shared Wilson helper, and a structural test
> that the module has no path to `ScoringConfig`.
>
> **A flaky test was fixed at its cause, not papered over.** `market()` compared two `asOf` values
> one second apart. Two effects fight across such a comparison: the later read gains occurrences
> that closed in between, and it loses a little weight on everything older (one more second of
> decay). On a large pre-existing bucket the drift (~1e-5) can exceed the gain and invert the
> comparison — which is why the run failed roughly one time in four. The gap is now one day, so
> the fixtures dominate by six orders of magnitude, and the delta is a lower bound because vitest
> runs files in parallel against one database.
>
> **M5 wrap-up — what M6 must call, and from where.** Both write paths are built, tested, and
> unwired by design (§30 build order); their call site is the outcome-resolution event handler in
> the paper engine (§41):
> - `recordSetupOutcome(db, { predictionId, domain, features, closedAt, won, returnPct })` —
>   ladder-aware, writes every backoff rung.
> - `recordAgentOutcome(db, prediction, contributions)` — contributions come straight off the
>   `signal_feature` rows M4 already persists, so nothing new needs capturing.
>
> **Stubs that died in M5:** `perp/features/historical-edge-stub.ts` (deleted) and
> `confidence.ts`'s hardcoded `historicalEvidence = 0.5`. Both now read the Brain.
>
> **Still deferred, deliberately:** the Risk Agent's veto accuracy needs M7 shadow predictions;
> `categoryOf(mint)` in the wallet profile returns the mint until token classification exists, so
> "specialization" is per-token rather than per-category (the field shape is final).

**Status:** COMPLETED — archived
**Original status:** PROPOSED (scoping)
**Milestone:** M5 — Brain (change 4 of 4) — completes M5
**Implements:** §16 Agent Memory (concrete mechanism, resolved) · §22 Attribution boundary ·
§24 hypothesis-pipeline boundary · Task 6 (§34) recency decay · §33 rules 8, 23, and the
"do not blend versions" rule

## What's changing

The last Brain memory: **each Analysis Agent's standalone counterfactual accuracy**.

§16 resolves what this is, precisely because it otherwise collapses into Attribution or
hypothesis promotion and adds nothing:

> if a hypothetical TradingAgent had followed *only* this one agent's lean,
> direction-for-direction, ignoring every other agent, what would its win rate have been?

1. **Counterfactual scoring** — for every resolved prediction, record whether each contributing
   agent's *own* lean would have been right, independent of what the composite decided. An
   agent that leaned SHORT on a prediction the composite took LONG and lost gets a
   counterfactual win; the composite's outcome and the agent's are scored separately.
2. **`brain_agent_memory`** (skeleton table exists from M4, empty) — populated per
   `(domain, agentKey, agentVersion)`, recency-decayed on the same half-life as Setup Memory
   (perp 90d / memecoin 30d), with Wilson CI on effective-n. Never blended across versions
   (CLAUDE.md "do not blend versions").
3. **Read** — `brain.agent(agentKey, version, asOf)` on the change-3 facade, returning
   `{ standaloneAccuracy, effectiveN, wilson, evidence, sampleSince }`.
4. **`agent_performance` vs `brain_agent_memory`** — the former (M4, per-TradingAgent
   win/loss counters) stays as-is. This change adds the **domain-wide** counterfactual, which
   is a different question with a different key. Docstrings on both tables will state which
   answers what, since having two agent-scoreboards invites exactly the confusion §16 warns of.

## Why this is descriptive, not prescriptive

§16 is emphatic: Agent Memory **does not change any weight by itself**. It is a continuously
updated, ungated read — the diagnostic that would *motivate* someone to propose a hypothesis
(§24), and the number that would justify deprecating an agent whose standalone accuracy sat at
chance for long enough. The implementation must have no path from this table to a
`ScoringConfig` write. That is the §24 backtest-guarded pipeline's job, at M7, and the
"do not let LLM output flow into the deterministic path unchecked" discipline applies equally
to statistics flowing into weights unchecked.

## What this change does NOT do

- **No weight changes, no auto-tuning, no agent deprecation.** Read-only diagnostic.
- **Does not implement Attribution (§22)** — per-prediction numeric factor scoring, M6.
- **Does not implement the hypothesis pipeline (§24)** — M7, and it uses the *higher*
  effective-n ≥ 20 bar, not this change's ≥ 10 (§41 implementer note: do not conflate).
- **Does not populate anything yet.** Like changes 1–2, the write path exists and M6's
  outcome resolution supplies the call site.

## Ambiguity resolved (needs sign-off)

**§16 does not say what "direction-for-direction" means for a non-directional agent.** Market
Regime emits an enum plus a bias (§7: "its Agent Memory tracks the bias, not the enum"),
Token Quality is bounded `[0, +1]` and never bearish, and the Risk Agent sits outside the
composite entirely. Resolution in `design.md`: agents are scored on their **signed lean** where
they have one, long-only agents are scored only on the predictions where they leaned at all,
and the Risk Agent gets a separate veto-accuracy metric rather than being forced into a
direction-shaped hole.
