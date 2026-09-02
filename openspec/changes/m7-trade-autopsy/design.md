# Design: m7-trade-autopsy

## Schema (migration 0018)

```
trade_autopsy
  id text PK
  prediction_id text NOT NULL UNIQUE   -- one autopsy per resolved prediction (idempotent)
  setup_id text NOT NULL               -- the fingerprint — change 6 aggregates by this
  outcome text NOT NULL                -- 'WIN' | 'LOSS' (hard fact from prediction_outcome)
  root_cause text                      -- LLM-generated
  failure_category text                -- LOSS-only (nullable on WIN)
  success_factor text                  -- WIN-only (nullable on LOSS)
  explanation text
  contributing_factors jsonb           -- array<string>
  agent_failures jsonb                 -- array<{ agent, assessment, impact }>
  lesson text
  recommendation text
  autopsy_version integer NOT NULL     -- prompt version — never blend
  llm_call_log_id text                 -- FK back to the log row for cost joining
  created_at timestamptz NOT NULL
  CONSTRAINT autopsy_win_xor_loss CHECK (
    (outcome = 'WIN'  AND failure_category IS NULL AND success_factor IS NOT NULL) OR
    (outcome = 'LOSS' AND failure_category IS NOT NULL AND success_factor IS NULL) OR
    (outcome = 'LOSS' AND failure_category IS NULL AND success_factor IS NULL)  -- LLM-failure row
  )
```

`prediction_id` UNIQUE makes a re-run of the autopsy subscriber a DB-level no-op — same rule 12
pattern used for setup occurrences. The XOR constraint enforces §24's "always exactly one of
the two populated" verbatim; the third clause allows a null-null row for the LLM-failure case,
so a retry can UPDATE it later (wait — trigger blocks UPDATE. Use INSERT-only + a separate
`autopsy_status text` column instead. See below.)

**Revision:** since predictions carry a rule-10 trigger but `trade_autopsy` doesn't, autopsy
rows CAN be updated. A `status` column (`SUCCESS | FAILED_LLM | REDACTED`) lets the runner
retry a `FAILED_LLM` row by UPDATE without violating any rule; only the aggregate hypothesis
pipeline reads only `SUCCESS` rows.

## The three-part evidence package (§24)

```
{
  systemBelief: {
    at: T0,
    agents: [{ key, score, confidence }],
    composite: { direction, score, confidence },
    setup: { entry, stopLoss, takeProfit }
  },
  marketEvolution: [
    { t: '+0m',  price, oi, funding, longShortRatio },
    { t: '+5m',  ... },
    ...
    { t: 'T1 fill', ... },
    { t: 'T2 exit', ... }
  ],
  agentEvolution: [
    { t: '+5m', agents: [{ key, score }] },
    ...
  ],
  surroundingRaw: {
    ohlcv: [...],   // 1m or 5m depending on style; range T0..T2
    funding: [...],
    oi: [...],
    liquidations: [...]
  }
}
```

Bounded: the raw window is `T0 → T2` only. §24's no-look-ahead paragraph forbids anything in
the autopsy window leaking back into the ORIGINAL prediction — enforced structurally: the
autopsy runner reads via `AsOfMarketData(T2)`, and the ORIGINAL prediction was made from
`AsOfMarketData(T0)`; the two views cannot cross-contaminate because they're separate objects
with separate cursors, and there is no writer from autopsy back to any pre-T0 table.

## Response schema (Zod)

```ts
const AutopsyOutput = z.object({
  rootCause: z.string().min(1).max(200),
  failureCategory: z.string().optional(),     // present on LOSS
  successFactor:   z.string().optional(),     // present on WIN
  explanation: z.string().min(1).max(2000),
  contributingFactors: z.array(z.string().max(200)).max(10),
  agentFailures: z.array(z.object({
    agent: z.string(),
    assessment: z.string().max(200),
    impact: z.enum(['high','medium','low']),
  })).max(15),
  lesson: z.string().max(500),
  recommendation: z.string().max(500),
});
// Runtime check: on WIN, successFactor required and failureCategory forbidden; mirror on LOSS.
```

Capped strings + arrays like the Judge — a runaway response fails validation, `callWithLog`
logs `INVALID_JSON`, autopsy row is inserted as `status=FAILED_LLM` with root_cause/etc null.

## Runner

Subscribes `prediction.resolved`. Per event: guards on `domain='perp'`, calls `autopsyOne(db,
predictionId)`.

`autopsyOne`:
1. Load Prediction, Signal, its features (T0 snapshot).
2. Load `prediction_outcome` for the planning horizon (T1..T2 span).
3. Build the three-part evidence package via `AsOfMarketData(T2)`.
4. `callWithLog(client, { system, user, schema }, { agent: 'autopsy', ...})`.
5. Insert `trade_autopsy` row (status=SUCCESS or FAILED_LLM per outcome).

`unique(prediction_id)` prevents double-write; a retry of a FAILED_LLM row explicitly UPDATEs
by prediction_id.

## Testing

- Evidence-package assembly is pure over an `AsOfMarketData`-shaped seam — no LLM in the test.
  Bounded to T0..T2; a fixture with data beyond T2 verifies nothing beyond leaks in.
- Response Zod: WIN with failureCategory rejected; LOSS with successFactor rejected; empty
  explanation rejected.
- LLM success path: writes a SUCCESS row and one llm_call_log row with `agent='autopsy'`.
- LLM failure: writes a FAILED_LLM row (null diagnostic fields); a retry updates the row (not
  a duplicate insert).
- Memecoin refused with §24 citation.
- Same prediction resolved twice → one trade_autopsy row, one llm_call_log row.
