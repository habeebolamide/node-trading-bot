# Change: m7-llm-client

**Status:** COMPLETED — archived 2026-09-02
**Original status:** PROPOSED (scoping)

> **COMPLETED.** New `packages/llm` (`@tip/llm`), the ONLY place that talks to DeepSeek.
> - `cost.ts` — `MODEL_PRICES` table in CODE (not env); `estimateCost` throws on unknown model.
> - `client.ts` — `createDeepSeekClient({apiKey, ...})`, `complete()` with Zod validation,
>   temperature 0, retries on network/5xx/429 with exponential backoff (200/800/3200ms), NEVER
>   on schema failure (§33 rule 14). Injectable `fetchImpl` + `wait` for testability. Refuses
>   to construct without an API key.
> - `log.ts` — `callWithLog(db, client, input, meta)` writes one `llm_call_log` row per call,
>   success or failure. Signal id / prediction id captured per meta.
>
> Migration 0015: `llm_call_log` (id · prediction_id · signal_id · agent · agent_version · model
> · prompt_tokens · completion_tokens · cost · latency_ms · success · error_kind · called_at).
>
> **Verified:** typecheck green; **536/539 tests pass** (3 opt-in live) across 2 consecutive
> runs, 17 new — pure cost (4), pure client (8 incl. no-retry-on-schema-failure and abort/
> TIMEOUT), live-DB callWithLog (5 incl. SUCCESS + HTTP_5XX + INVALID_JSON logging paths).
**Milestone:** M7 — LLM/Judge (change 1 of 6)
**Implements:** §18 (model choice: DeepSeek V4-Flash for every LLM call) · §23 `LLMCallLog` ·
§13 (`LLMCallLog` entity) · §33 rules 13 (LLM does not calculate), 14 (LLM does not invent
market data)

## What's changing

A new package `@tip/llm` — the ONLY place in the codebase that talks to DeepSeek — plus the
`llm_call_log` table every other M7 change writes to.

1. **`packages/llm`** (new workspace, `@tip/llm`). Named in §28's repo layout. Depends downward
   only on `@tip/database` + `@tip/domain`; nothing imports the SDK anywhere else.
2. **`DeepSeekClient`** — a thin, testable HTTP client with:
   - Structured-JSON completion (temperature 0 for reproducibility).
   - **Zod validation on every response** (§18: "structured output").
   - Retries with exponential backoff on 5xx / network only; a `ValidationError` on schema
     failure is **never retried** — rule 14 says invalid JSON is a failure to surface, not to
     paper over.
   - Timeout (default 30s) — the Judge sits in the hot path (§18) and cannot block forever.
3. **`llm_call_log` table** (§13) — one row per call: `predictionId?`, `agent`, `model`,
   `promptTokens`, `completionTokens`, `cost`, `latencyMs`, `success`, `errorKind`. Migration
   0015. This is the ledger §23's cost-vs-value questions read from.
4. **`callWithLog(client, input, meta)`** — the single call helper every M7 module uses. Always
   logs (even on failure), always tags the `predictionId` when there is one, always records
   cost. If you call the SDK anywhere else without going through this, you skip the ledger and
   §23 collapses — a lint-visible convention plus a docstring make it obvious.
5. **`cost.ts`** — DeepSeek V4-Flash pricing table + `estimateCost(promptTokens, completionTokens)`.
   Table lives in code, not env, so a price change is a code change that shows up in review.

## Why first in M7

Every other M7 change is a *caller* — Judge, override gate persistence, autopsy, hypothesis
pipeline. If the client is shared and the log is the same table for every caller, §23's headline
"is the LLM adding value" question becomes a single SQL query. If not, every caller invents its
own cost tracking and the question gets un-askable.

## What this change does NOT do

- **No Judge yet.** The client is a substrate; the Judge (change 2) uses it.
- **No LLM-driven scoring.** Rule 13 stays absolute — this package emits nothing that reaches
  the deterministic composite.
- **No streaming.** The Judge's response is a small JSON object; streaming adds complexity for
  no win here. Autopsy responses are also bounded, same reasoning.
- **No prompt caching / vendor-side prompt features.** DeepSeek V4-Flash currently exposes them
  differently across regions; deferring until the Judge is real and we can measure whether the
  reduced-cost variant preserves the calibration properties Task 6 asks for.
