# Design: m6-predictions

## Where it lives

`packages/predictions` → `@tip/predictions`. Named in §28's repo layout, so not a discretionary
package. Depends on `@tip/database`, `@tip/domain`, `@tip/planner`, `@tip/trading-agents`.

## Schema

```
prediction                                    -- INSERT-only (rule 10)
  id PK
  trading_agent_id, signal_id (unique)        -- one signal → at most one prediction
  domain, symbol
  created_at                                  -- T0
  horizon                                     -- the planning horizon (change 1)
  direction, score, confidence
  entry_ref, stop_loss, take_profit           -- the TradeSetup, denormalized and frozen
  position_size, leverage, required_margin
  risk_reward
  thesis text NULL                            -- M7 (Judge) fills; null is valid
  features jsonb                              -- the agent contributions that produced it (§22 input)
  invalidators jsonb                          -- what would falsify this
  config_version  NOT NULL REFERENCES scoring_config(...)   -- §19, rule 16
  is_shadow boolean NOT NULL DEFAULT false
  shadow_of text NULL REFERENCES prediction(id)             -- §13, §18 — M7 populates

prediction_outcome                            -- one row per (prediction × horizon)
  prediction_id, horizon  PK
  resolved_at
  return_pct, benchmark_return_pct, alpha
  mfe, mae
  hit_target boolean, hit_invalidation boolean
  holding_period_sec
  won boolean
  outcome_resolution  TICK | CANDLE_1M_CONSERVATIVE          -- §21
```

## Enforcing immutability structurally (rule 10)

Rule 10 says Predictions are `INSERT`-only and "if a schema field seems to want `UPDATE`, you're
modelling it wrong." CLAUDE.md also says correctness constraints belong in the DB, not the
application (rule 12).

**Resolution: a Postgres trigger that raises on `UPDATE` or `DELETE` of `prediction`.** Drizzle
has no first-class trigger support, so this ships as raw SQL appended to the generated migration —
flagged here because a hand-edited migration is unusual in this repo and a reviewer should see it
called out rather than discover it.

Why a trigger rather than convention or a repository-pattern guard:
- A convention is invisible at 2am, and the whole point of rule 10 is that a retroactively-edited
  prediction destroys the audit trail *silently*.
- An application guard is bypassed by any script, migration, or psql session — and this repo has a
  `scripts` workspace that talks to the DB directly.
- The trigger costs nothing and fails loudly with a named error.

`prediction_outcome` is deliberately NOT trigger-locked: change 4 fills a row per horizon as each
horizon elapses, so it is written over time by design. Its immutability guarantee is weaker and
that is correct — the *claim* is frozen, the *measurement* accrues.

## Ambiguity — what happens on `NO_TRADE`

The plan never says. Two readings:

| | Prediction created? | Consequence |
|---|---|---|
| A — only TRADE setups become predictions | no | Metrics measure only trades taken. The R:R gate's own quality is invisible: we never learn whether vetoed setups would have won. |
| B — every scored signal becomes a prediction, `NO_TRADE` ones flagged | yes | Denominators include declined trades. Every §32 metric needs a "taken only" filter or it silently reports on a mixed population. |

**Chosen: A, with the veto recorded on the Signal, not as a Prediction.** §19 defines a Prediction
as carrying `entry reference`, `direction/stance`, `horizon` — a `NO_TRADE` has no entry and no
horizon, so B would mean storing rows with null in the fields that define the entity. §36 already
gives the Signal an `INVALIDATED` state and M4's `signal_risk` already records *why* a signal died;
a `NO_TRADE` veto extends that same mechanism with a `no_trade_reason`, which is where a
"we declined and here's why" record belongs.

Consequence, stated plainly so it is not discovered later: **the R:R gate's own accuracy is not
measurable in MVP.** Answering "would the trades we vetoed have won?" requires shadow-evaluating
declined setups, which is precisely the §18/§24 shadow-prediction machinery scheduled for M7. The
`isShadow` column landing in this change is what makes that a later *caller*, not a later
migration.

## Creation path

```ts
createPrediction(db, { signalId, setup, agentSnapshot, features, invalidators })
```

One transaction:
1. `SELECT ... FOR UPDATE` the signal; abort unless `state = 'ACTIVE'` (expired/invalidated
   signals cannot be acted on — §36).
2. Insert the prediction (`unique(signal_id)` makes a double-act a DB-level failure, rule 12).
3. Transition the signal to `CONSUMED`.

All three or none. A prediction whose signal stayed ACTIVE, or a consumed signal with no
prediction, are both states that would quietly corrupt the M6 denominators.

## Testing

- `configVersion` is required: no code path creates a prediction without one; a bad FK is rejected.
- **The immutability trigger actually fires** — an `UPDATE` and a `DELETE` against a real row both
  raise. Asserted against live Postgres, not mocked; a trigger nobody tested is a trigger that
  does not exist.
- One signal → at most one prediction, proved by a real concurrent double-insert (the §29 pattern
  M1 already uses for token claims), not a sequential loop.
- Acting on an EXPIRED or INVALIDATED signal is refused.
- Signal reaches `CONSUMED` exactly when a prediction is created, and the whole thing rolls back
  together on failure.
- Shadow columns: `shadowOf` FK resolves; a shadow row is creatable and distinguishable.
