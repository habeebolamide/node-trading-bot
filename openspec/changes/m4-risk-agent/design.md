# Design: m4-risk-agent

Read §40.12, §36 alongside.

## Flow

```
signal.created (from change 2) → Risk Agent runs per domain
    → aggregate flags → risk_level ∈ {LOW | MEDIUM | MEDIUM_HIGH | HIGH | INVALIDATED}
    → INVALIDATED  →  signal transitions to INVALIDATED, publish signal.invalidated
    → other levels →  attach signal_risk row (narrative context, no state change)
```

Risk sits *outside* the composite (no weight — §7 rule); it runs after scoring but before
downstream consumers (M6 Trade Planner, M7 Judge).

## Domain-specific checks

Perp (§40.12):
| Check | Trigger |
|---|---|
| S/R proximity | entry within 0.3 × ATR(14) of a rolling-30-candle major level *against* trade direction |
| Funding extremity | funding percentile > 95 against direction |
| OI extremity | OI at rolling 90th percentile |
| Volatility extremity | ATR ratio > 2.0 (HIGH_VOL context) |
| Price extension | price > 2 × ATR from EMA(50) |

Memecoin:
| Check | Trigger |
|---|---|
| Extreme freshness | token < 5 min old |
| Pool-share proximity | position notional > 50% of `maxPoolShare` limit |
| Wallet quality below median | triggering wallet score < universe median |

Aggregation: sum flag weights (1 each) → `risk_level`:
- 0 → LOW
- 1 → MEDIUM
- 2 → MEDIUM_HIGH
- 3 → HIGH
- 4+ → INVALIDATED

## Schema (migration 0008)

```
signal_risk {
  signal_id PK / FK signal(id),
  risk_level text NOT NULL,
  risk_flags text[] NOT NULL,
  evaluated_at timestamptz NOT NULL,
  agent_version integer NOT NULL
}
```

Insert on every scored signal — even LOW gets a row (dashboards want the full breakdown).

## Worker wiring

New processor on SIGNAL_PROCESSING consuming `signal.created`. Reads the signal row + its
signal_feature rows + fresh MarketBuffer state to run the checks; writes signal_risk;
transitions signal to INVALIDATED via the change-2 lifecycle module if applicable.

## Testing

Unit per check:
- perp: each check triggers under expected input; multi-flag → correct risk_level; INVALIDATED
  threshold; direction-aware S/R (near resistance is bad for LONG, fine for SHORT)
- memecoin: freshness under/over 5m boundary; pool-share cap threshold; wallet-quality gate

Integration (live DB): seed a signal + its features → Risk Agent handler → signal_risk row
written; INVALIDATED case → signal.state = INVALIDATED; LOW case → state stays ACTIVE.

## Post-change: M4 wrap

All 14 agents live, framework composes them, Risk Agent gates. Ready for M5 (BrainSetupMemory
starts populating from resolved signals once M6 lands) and M6 (Predictions/Paper Engine).
