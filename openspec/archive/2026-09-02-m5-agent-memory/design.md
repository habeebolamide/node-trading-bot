# Design: m5-agent-memory

## The counterfactual

For a resolved prediction P with realized direction outcome (did price move the way a LONG
would have wanted, over P's horizon):

```
for each agent A that contributed to P:
    lean_A = sign(A.score)                        -- from signal_feature, stored at M4
    if lean_A == 0            → not counted       -- no opinion, no credit either way
    counterfactualWin_A = (lean_A == realizedDirection)
```

Note this is deliberately **not** "did the composite win." An agent that dissented from a
losing composite should be credited, and one that agreed with a winning composite for the wrong
reason should not be shielded — that separation is the entire point of §16's mechanism.

`signal_feature` (M4, `(signalId, agentKey, agentVersion) → score, confidence, features`)
already stores every contribution, so the counterfactual is recoverable at outcome-resolution
time without re-running any agent. No new capture is needed — this is why M4's decision to
persist per-agent features rather than only the composite pays off here.

## Non-directional agents (the flagged ambiguity)

| Agent | Lean | How scored |
|---|---|---|
| Perp Momentum / OI / Liquidation / Funding / Positioning | signed [-1,+1] | `sign(score)` |
| Perp / Memecoin Market Regime | enum + bias | **bias sign only** (§7: Agent Memory tracks the bias, not the enum) |
| Memecoin Smart Money / Convergence / Momentum | long-only, [0,+1] | counted only on predictions where `score > 0`; a 0 is "no opinion", not a SHORT lean |
| Memecoin Token Quality | [0,+1] soft quality | same long-only treatment |
| Token Risk (§40.13) | hard veto, no score | **excluded** — a veto has no direction |
| Risk Agent (§40.12) | post-aggregation veto | separate metric, below |

The long-only rule matters: scoring a memecoin agent's `score = 0` as a bearish lean would
manufacture a track record out of silence, and since memecoin is spot/long-only (§18) there is
no short a "bearish lean" could even have expressed.

**Risk Agent veto accuracy** — a different question ("when we invalidated a signal, would it
have lost?"), answerable only against M7 shadow predictions, which do not exist yet. This
change stores the row shape (`vetoedCount`, `vetoedWouldHaveLost`, `evidence: INSUFFICIENT`)
and leaves it unpopulated with a comment naming M7 as the call site. Recording the shape now
keeps M4's `signal_risk` rows meaningful rather than write-only.

## Storage

`brain_agent_memory` exists from M4 with `(id, domain, agent_key, agent_version,
standalone_accuracy, updated_at)` and a unique on `(domain, agent_key, agent_version)`.
Extend with the same statistical fields every other memory carries:

```
+ effective_n        numeric
+ effective_wins     numeric
+ wilson_lower       numeric
+ wilson_upper       numeric
+ evidence           text        -- SUFFICIENT | INSUFFICIENT (effective-n ≥ 10)
+ occurrence_count   integer
+ sample_since       timestamptz
```

plus an append-only `brain_agent_occurrence` (agent_key, agent_version, domain, prediction_id,
closed_at, lean, won) — same shape and rationale as change 1's occurrence table, same
`unique(prediction_id, agent_key, agent_version)` idempotency guard (rule 12).

**Versions never blend.** `(agentKey, agentVersion)` is the key, per CLAUDE.md's explicit rule.
A v1→v2 bump starts a fresh track record; the read returns INSUFFICIENT until v2 has its own
effective-n 10, and the facade does **not** offer a "roll up all versions" convenience — that
convenience is exactly how a regression gets hidden behind an old version's good numbers.

## Statistics — shared, not reimplemented

Same `wilsonInterval`, same `recencyWeight`, same half-lives, same effective-n ≥ 10 trust bar
as change 1. §41's instruction — one tested function, both domains — extends to all four
memories; a second decay implementation here would be the exact drift §41 exists to prevent.

## Read

```ts
brain.agent(agentKey, version, asOf)
  → { standaloneAccuracy, effectiveN, wilson: {lower, upper} | null,
      evidence, occurrenceCount, sampleSince } | null
```

`asOf`-filtered like every other Brain read. Returns null for an agent with no occurrences —
distinct from INSUFFICIENT, which means "we have some data and it isn't enough."

## Testing

- Counterfactual: a dissenting agent is credited when the composite loses and the dissent was
  right; an agreeing agent on a losing composite is debited.
- Zero-lean agents are excluded, not scored as bearish (long-only case).
- Market Regime scored on bias, not enum.
- Token Risk excluded entirely.
- Version isolation: v1 and v2 rows never merge; v2 reads INSUFFICIENT while thin even when v1
  has hundreds of occurrences.
- Idempotency: replaying a resolved prediction does not double-count.
- Wilson/decay match the shared helpers exactly (same-input equality test against change 1).
