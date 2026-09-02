# Change: m5-agent-memory

**Status:** PROPOSED (scoping)
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
