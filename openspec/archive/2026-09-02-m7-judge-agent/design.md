# Design: m7-judge-agent

## Where it lives

Grows `packages/agents/perp/`. Adds `@tip/llm` as a dependency (only place other than change 5).
Judge is a normal `AnalysisAgent` — same interface every M4 agent uses — but does not
participate in the composite (§40.14 weight N/A).

## Evidence assembly

The Judge sees ONLY what the deterministic pipeline saw, structured:

```json
{
  "symbol": "BTCUSDT",
  "domain": "perp",
  "deterministic": {
    "direction": "LONG",
    "compositeScore": 0.62,
    "confidence": 0.71
  },
  "agents": [
    { "key": "perp.momentum",       "score": 0.85, "confidence": 0.90 },
    { "key": "perp.open_interest",  "score": 0.55, "confidence": 0.72 },
    ...
  ],
  "historicalEdge": {
    "evidence": "SUFFICIENT",
    "winRate": 0.62,
    "wilsonWidth": 0.14
  },
  "risk": { "level": "MEDIUM", "flags": ["FUNDING_ELEVATED"] }
}
```

**Rule 14 enforcement — the LLM cannot invent market data.** Raw OHLCV, orderbooks and funding
rates are deliberately NOT in the prompt; if the Judge's thesis mentions a price level it did
not receive as evidence, that mention is hallucination the caller should ignore. Because the
prompt input is bounded and structured, the Judge cannot cite anything we did not hand it.

## Prompt versioning

```ts
const JUDGE_PROMPTS = {
  1: { system: '...', userTemplate: (evidence) => `Evidence:\n${JSON.stringify(evidence, null, 2)}\n\n...` },
} as const;
export const JUDGE_VERSION_CURRENT = 1;
```

A prompt change bumps `JUDGE_VERSION_CURRENT`. The bump propagates into `llm_call_log.agent_version`,
into `signal_feature.agentVersion` (for the Judge's row), and into `LearningHypothesis`
attribution (change 6) — so blending judgeV1 and judgeV2 track records cannot happen silently
(same "do not blend versions" rule M5's Agent Memory uses).

## Response schema (Zod)

```ts
const JudgeOutput = z.object({
  direction: z.enum(['LONG', 'SHORT', 'NEUTRAL']),
  confidence: z.number().min(0).max(1),
  thesis: z.string().min(1).max(1000),
  keyRisks: z.array(z.string()).max(6),
  invalidators: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('price_above'), value: z.number() }),
    z.object({ type: z.literal('price_below'), value: z.number() }),
    z.object({ type: z.literal('ttl_expired'), horizon: z.string() }),
    z.object({ type: z.literal('funding_extreme'), threshold: z.number() }),
    z.object({ type: z.literal('stop_moved'), price: z.number() }),
  ])).max(4),
  confidenceTag: z.enum(['weak', 'moderate', 'strong']),
});
```

Every field's cap is a defence against a runaway response — Zod fails the whole payload if any
cap trips, `callWithLog` logs INVALID_JSON, and change 3 defers.

## `signal_feature` row for the Judge

The Judge writes a `signal_feature` row for its own contribution:

```
agentKey       : 'judge'
agentVersion   : JUDGE_VERSION_CURRENT
score          : signed direction × confidence (SHORT confidence 0.75 → -0.75)
confidence     : 0.75
features       : { thesis, keyRisks, invalidators, confidenceTag, judgeAction: null (change 3 stamps) }
```

This gives §22 attribution a row to read without special-casing the Judge, and it gives §16
Agent Memory (M5) a lean to score once M7's outcomes accumulate.

## Perp-only enforcement

```
if (ctx.domain !== 'perp') throw new ValidationError('Judge is perp-only in MVP (§40.14 memecoin scope)');
```

Silent skip would let a memecoin caller degrade to deterministic and never notice the mismatch.
Called out as an ambiguity in the proposal because §40.14 says "registered but disabled" for
memecoin; interpreting "disabled" as "throws on use" is the safe reading.

## Testing

- Evidence assembly is pure and deterministic — same inputs → same JSON.
- Prompt version constant is exported; a bump changes it, tests break, review catches it.
- Zod schema rejects out-of-range confidence, unknown invalidator type, empty thesis.
- Live-DB integration (`agents/perp/judge.integration.test.ts`) — with a MOCK LLM client fed
  a canned JSON response, the agent writes the right `signal_feature` row.
- LLM failure paths: mock client returns `{ value: null, log: ... }` → agent produces no output
  and no signal_feature row (the gate defers to deterministic in change 3).
- Memecoin domain refused with a §40.14 citation in the error message.
