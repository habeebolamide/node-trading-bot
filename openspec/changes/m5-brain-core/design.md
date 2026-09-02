# Design: m5-brain-core

## Package

`packages/brain` → `@tip/brain`. Named in §28's repo layout. Depends on `@tip/database`,
`@tip/domain`. Deliberately does **not** depend on `@tip/agents` or `@tip/trading-agents` —
the Brain holds shared domain facts (§15), so the dependency arrow points *toward* it, never
out of it. Agents read the Brain; the Brain never reads an agent.

## Setup fingerprint (Part II §8, rule 24)

### Bucketing

Every dimension is a signed `[-1, +1]` score bucketed to a tertile:

```
LOW   : x < -1/3
MED   : -1/3 ≤ x ≤ +1/3
HIGH  : x > +1/3
```

Fixed cut-points, not empirical tertiles of observed data — empirical cuts would make a
fingerprint's meaning drift as the sample grows, and old occurrences would silently re-bucket.
Deterministic and replay-stable (rule 11/21) matters more here than balanced cell occupancy.

`setupId = sha256(domain + '|' + dimensions.map(name:bucket).join('|')).slice(0, 32)`.
Dimensions are emitted in a **fixed canonical order** (below), so the hash is deterministic and
order-independent at the call site — a caller passing an object gets the same hash regardless of
key insertion order. This is on CLAUDE.md's mandatory-test list.

### Memecoin tuple — 5 dimensions, 3⁵ = 243 cells

Part II §8 names these explicitly: smart-money quality, convergence, momentum, token quality,
market regime. Early-Entry Edge, Signal Freshness and Historical Edge stay in the Opportunity
Score composite (Part II §9) but are **dropped from the fingerprint** — §8's stated reason is
that 243 cells with an effective-n ≥ 10 floor is reachable given one position at a time (§32)
and a 30-day half-life, where ~6,500 cells is not.

Canonical order: `smart_money, convergence, momentum, token_quality, market_regime`.

### Perp tuple — 8 dimensions, 3⁸ = 6,561 cells

**This is the ambiguity flagged in `proposal.md`.** Part II §8 says only "Perp keeps its full
tuple," and Part III §3's weight table has 8 rows:

```
Momentum 20% · Open Interest 20% · Market Regime 15% · Liquidations 15%
Funding 10% · Positioning 10% · Volume 5% · Historical Edge 5%
```

Taking "full tuple" literally means fingerprinting on Historical Edge — but Historical Edge
(§40.16) *is* the Setup Memory read, so you would need the answer to compute the key. Circular;
cannot be what was meant. Two candidate resolutions:

| Option | Dimensions | Cells | Matches CLAUDE.md's "6,500 for perp"? |
|---|---|---|---|
| A — drop Historical Edge, keep 7 | 7 | 2,187 | No |
| B — drop Historical Edge, add Volatility | 8 | **6,561** | **Yes (≈6,500)** |

**Chosen: B.** It is the only reading consistent with the cell count CLAUDE.md's mandatory-test
list states, and Volatility is not invented for convenience — the plan already treats it as a
first-class, separately-named axis: Market Regime (§40.3) computes an ATR ratio and can emit
`HIGH_VOL`, and the Risk Agent (§40.12) checks "volatility extremity" as a distinct check from
regime. Making it its own tertile means an otherwise-identical setup in a calm tape and in a
violent one hash differently, which is the same "regime falls out for free" argument Part II §8
makes for direction.

Canonical order:
`momentum, open_interest, market_regime, liquidation, funding, positioning, volume, volatility`

Volatility feeds in as ATR(14) / rolling-avg-ATR, mapped to signed `[-1,+1]` by
`clamp((ratio − 1), −1, +1)` so ratio 1.0 → MED, ≥ 2.0 → HIGH, ≤ 0.0 → LOW.

**If the human disagrees with B, the change is one constant** — the dimension list is a single
exported array per domain, and the backoff ladder (change 2) derives its drop order from it.

## `brain_setup_memory` storage shape

§41's reference code models occurrences as an in-row array (`row.occurrences.push(...)`,
`upsert(row)`). §13's note says the final Drizzle schema is derived at build time, so the
storage shape is a build-time decision; the **math and function signature are not** and follow
§41 exactly.

**Chosen: two tables.**

```
brain_setup_occurrence   append-only, one row per closed prediction
  (setup_id, prediction_id PK-unique, domain, closed_at, won, return_pct)

brain_setup_memory       derived live aggregate, upserted
  (setup_id PK, domain, effective_n, effective_wins, win_rate, median_return,
   wilson_lower, wilson_upper, evidence, occurrence_count, last_updated_at)
```

Rationale over a JSONB array:
- **Rule 8 / rule 10.** Occurrences are outcome facts. Append-only child rows are exactly the
  shape rule 8 mandates; a JSONB array rewritten on every close is in-place mutation of history.
- **Idempotency (rule 12).** `unique(prediction_id)` makes a replayed outcome event a DB-level
  no-op. With an in-row array, double-counting is prevented only by application-side
  check-then-write — the precise pattern §29 forbids.
- **"The full history stays queryable"** (Part II §8) is literally true of a table and
  awkwardly true of a JSONB blob.
- Row-rewrite cost: perp with a 90d half-life on a hot fingerprint accumulates unboundedly in
  one row.

The aggregate row is *derived* and upserted — that is not a rule-8 violation, it is a
recomputed live estimate, which is exactly how §41 describes it ("only its influence on the
current live estimate decays").

## `updateSetupMemory` — per §41, unchanged math

```
halflifeDays = { perp: 90, memecoin: 30 }        // Task 6
TRUST_THRESHOLD_EFFECTIVE_N = 10                 // §8/§25 — NOT §24's 20
now = outcome.closedAt                           // "as of newest outcome" — deterministic,
                                                 // NOT Date.now(); makes replay reproducible
weight_i     = 0.5 ^ (ageDays_i / halflifeDays)
effectiveN   = Σ weight_i
effectiveWins= Σ weight_i where won
winRate      = effectiveWins / effectiveN
medianReturn = weightedMedian(returns, weights)
evidence     = effectiveN ≥ 10 ? SUFFICIENT : INSUFFICIENT
wilson       = evidence === SUFFICIENT ? wilsonInterval(effectiveWins, effectiveN, 0.95) : null
```

`now = outcome.closedAt` (not wall-clock) is load-bearing for rule 11/21: a backtest replaying
the same fixture twice must produce byte-identical rows, which wall-clock decay would break.

Both domains call the **same function** — §41's explicit instruction, differing only via the
half-life lookup. Do not fork per domain.

## Testing

CLAUDE.md's mandatory list, in full:

- `wilsonInterval()` — `n=0` (→ `{0,1,0.5}`), `n<threshold`, `n=threshold`, all-wins
  (upper bound 1, lower < 1), all-losses, fractional n, unknown confidence level throws.
- `updateSetupMemory()` — first close on a new fingerprint; decay across a half-life boundary
  (an occurrence exactly one half-life old contributes exactly 0.5); recency-weighted result
  equals the unweighted result when all occurrences are simultaneous; INSUFFICIENT → SUFFICIENT
  transition at exactly effective-n 10; Wilson stays null while INSUFFICIENT; replay
  idempotency (same prediction_id twice → one occurrence, unchanged aggregates).
- `weightedMedian()` — empty → null, zero total weight → null, single item, weight skew moves
  the median away from the unweighted one.
- Fingerprint — deterministic; **order-independent within each dimension set**; 243 distinct
  ids over the memecoin bucket space; 6,561 over perp; boundary values (exactly −1/3, +1/3)
  land in MED.
