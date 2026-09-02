# Tasks: m7-llm-client

## 1. Package scaffold
- [ ] `packages/llm` (`@tip/llm`) + tsconfig + package.json + install
- [ ] Root tsconfig reference + vitest alias

## 2. Schema (migration 0015)
- [ ] `llm_call_log` — id PK · prediction_id NULL · signal_id NULL · agent · agent_version ·
      model · prompt_tokens · completion_tokens · cost · latency_ms · success · error_kind ·
      called_at
- [ ] indexes (prediction_id), (called_at, agent)

## 3. Cost table (`cost.ts`)
- [ ] `DEEPSEEK_V4_FLASH_PRICE = { promptPerMTok, completionPerMTok }` (constants; code, not env)
- [ ] `estimateCost({ model, promptTokens, completionTokens })`

## 4. Client (`client.ts`)
- [ ] `createDeepSeekClient(cfg)` — key validated at startup via loadConfig
- [ ] `complete(input)` — POST to DeepSeek chat completions with `response_format: json_object`,
      temperature 0, Zod validation, retry policy, timeout
- [ ] 3 retries on network/5xx with exponential backoff; NEVER on schema failure

## 5. `callWithLog` (`log.ts`)
- [ ] wraps client.complete + writes llm_call_log inside the SAME db txn boundary as the caller
      when a tx is supplied, else a bare insert
- [ ] returns `{ value: T | null; log: LogRow }` — never throws for LLM failures

## 6. Tests
- [ ] unit: cost math against a hand-computed table
- [ ] unit: retry (5xx→5xx→200), no-retry on schema failure, timeout errorKind
- [ ] live-DB integration: callWithLog writes one row per call (success + failure)
- [ ] a missing DEEPSEEK_API_KEY at startup fails loadConfig — never at first call

## 7. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary
