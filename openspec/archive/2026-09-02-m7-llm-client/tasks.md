# Tasks: m7-llm-client

`[x]` done — **17 new tests, 536/539 suite green.**

## 1. Package scaffold
- [x] `packages/llm` (`@tip/llm`) + tsconfig + package.json + install
- [x] Root tsconfig reference + vitest alias

## 2. Schema (migration 0015)
- [x] `llm_call_log` — id PK · prediction_id NULL · signal_id NULL · agent · agent_version ·
      model · prompt_tokens · completion_tokens · cost · latency_ms · success · error_kind ·
      called_at
- [x] indexes (prediction_id), (called_at, agent)

## 3. Cost table (`cost.ts`)
- [x] `DEEPSEEK_V4_FLASH_PRICE = { promptPerMTok, completionPerMTok }` (constants; code, not env)
- [x] `estimateCost({ model, promptTokens, completionTokens })`

## 4. Client (`client.ts`)
- [x] `createDeepSeekClient(cfg)` — key validated at startup via loadConfig
- [x] `complete(input)` — POST to DeepSeek chat completions with `response_format: json_object`,
      temperature 0, Zod validation, retry policy, timeout
- [x] 3 retries on network/5xx with exponential backoff; NEVER on schema failure

## 5. `callWithLog` (`log.ts`)
- [x] wraps client.complete + writes llm_call_log inside the SAME db txn boundary as the caller
      when a tx is supplied, else a bare insert
- [x] returns `{ value: T | null; log: LogRow }` — never throws for LLM failures

## 6. Tests
- [x] unit: cost math against a hand-computed table
- [x] unit: retry (5xx→5xx→200), no-retry on schema failure, timeout errorKind
- [x] live-DB integration: callWithLog writes one row per call (success + failure)
- [x] a missing DEEPSEEK_API_KEY at startup fails loadConfig — never at first call

## 7. Wrap-up
- [x] typecheck + full suite green
- [x] ARCHIVE + completion summary
