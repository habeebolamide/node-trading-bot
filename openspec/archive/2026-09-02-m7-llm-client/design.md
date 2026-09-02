# Design: m7-llm-client

## Package

`packages/llm` → `@tip/llm`. Depends on `@tip/database`, `@tip/domain`. Nothing else imports the
DeepSeek SDK anywhere — a `grep -r 'deepseek'` in review is the check.

## Client surface

```ts
interface DeepSeekClient {
  complete<T>(input: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<{ value: T; usage: TokenUsage; latencyMs: number }>;
}
```

Temperature 0, no penalties, `response_format: { type: 'json_object' }`. Deterministic-as-
possible so replays of the SAME prompt yield the SAME output (the reproducibility rule in §32
extends to LLM calls to the extent the vendor allows).

**Retries:** 3 attempts on network / 5xx / abort-signal timeouts, exponential backoff
(200ms, 800ms, 3200ms). **Never on schema failure** — invalid JSON is data the LLM was asked
to shape and got wrong; retrying without changing the input hides the failure. The caller
handles it as "Judge failed, degrade gracefully" (§18 LLM-failure paragraph).

**Timeout default 30s.** §18: "the Judge sits inline in Signal → Prediction. If the call times
out or fails, the prediction must still be created, deterministic-only." A 30s budget errs on
the side of getting the Judge's input rather than dropping calls; adjustable per callsite.

## `llm_call_log`

```
llm_call_log
  id text PK
  prediction_id text NULL              -- populated when the call supported a prediction (Judge, autopsy)
  agent text NOT NULL                  -- 'judge' | 'autopsy' | future
  agent_version integer NOT NULL
  model text NOT NULL                  -- 'deepseek-v4-flash' today; a future model bump doesn't need a schema change
  prompt_tokens integer NOT NULL
  completion_tokens integer NOT NULL
  cost numeric NOT NULL                -- USD, computed via cost.ts at call time — model price at THAT time is frozen
  latency_ms integer NOT NULL
  success boolean NOT NULL             -- false on any failure kind
  error_kind text NULL                 -- 'TIMEOUT' | 'HTTP_5XX' | 'INVALID_JSON' | 'RATE_LIMIT' | 'OTHER'
  called_at timestamptz NOT NULL DEFAULT now()
  indexes on (prediction_id) and (called_at, agent)
```

Cost is computed at call time, not derived from tokens at read time — a price change months
later must not silently rewrite historical costs. Same reasoning M5 uses for `configVersion`
on Predictions.

## `callWithLog`

```
callWithLog(client, { system, user, schema }, meta): Promise<{ value: T | null; log: LogRow }>
```

- Always inserts the log row, even when the call fails (success=false, errorKind populated).
- Returns `value: null` on failure — callers pattern-match, they don't throw-and-catch.
- Meta carries `predictionId`, `agent`, `agentVersion`. No `predictionId` for the Judge's initial
  call because the Prediction hasn't been created yet — the Judge call runs against a `signal`
  and its `signalId` is captured on the row too (add column, small extension).

## Testing

- Retry: 5xx → 5xx → 200 succeeds after 2 waits.
- No retry on schema failure — an INVALID_JSON is logged and returned as failure with `value: null`.
- Timeout: an unresponsive server aborts within the budget and logs errorKind=TIMEOUT.
- Cost math: prompt+completion tokens map to the correct USD via the table.
- Log-always: every call (success or failure) writes exactly one `llm_call_log` row.
- The client refuses to be constructed without a valid API key — a missing key is a config
  failure surfaced at startup, not at first call (loadConfig already validates env).
