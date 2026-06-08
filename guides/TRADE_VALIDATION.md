# AI-Powered Trade Validation — Design & Build Plan

> **Status:** designed, not yet built (design dates 2026-06-08).
> **One-liner:** ingest an external trade signal (`pair / entry / SL / TP`), gather live context, ask an LLM to score it **0–100** with a per-dimension breakdown, persist an audit row, and push a Telegram scorecard. **It judges signals — it never executes them.**

This feature is deliberately *distinct* from the existing entry pipeline. The entry pipeline **generates** signals from market data; this feature **evaluates** a signal someone else generated. It reuses the same data-gathering modules but a different prompt, a different LLM output schema, and a separate, execution-free code path.

---

## 1. Core design decisions (locked)

| Topic | Decision | Why |
|---|---|---|
| **Intake** | Bot exposes `POST /validate` (new `api/server.ts`). Telegram-channel reading stays **outside** the bot (userbot / n8n / curl posts the JSON). | Channel scraping needs a user session (MTProto), which is a separate concern with its own auth/ToS surface. Keeping it external keeps the bot a clean, testable scoring service. |
| **Action** | **Score + notify only.** No execution coupling. Cannot open/close/adjust trades. | Validation is advisory. Wiring it to execution would turn a scoring bug into a money-losing bug. |
| **Scoring model** | **DeepSeek** via existing `claude/client.ts` (new `validation` entry in `MODELS_BY_TYPE`). | No new API key, reuses fallback/cost/parse plumbing already proven in prod. |
| **Veto gates** | LLM scores **freely** — all computed flags are passed in as context, no hard score caps. **Only** hard reject: SL on the wrong side of entry → `INVALID_SIGNAL` at the geometry stage (a validity guard, not a score cap). | Trust the LLM with full context; the one exception is a structurally impossible signal that isn't worth a token. |
| **Counter-trend** | Penalized **moderately** — lowers the `trendAlignment` dimension, but strong structure + R/R can still score well. | Counter-trend ≠ always bad; let the rubric weigh it. |
| **Rubric** | Style-weighted (scalp vs swing, inferred from R/R distance & TP spacing). R/R **anchors on TP1**; all TPs are passed to the LLM. | A scalp and a swing should not be judged on the same dimension weights. |

---

## 2. System architecture

```
┌─────────────────────────┐
│ Telegram channel reader  │  (EXTERNAL — userbot / n8n / curl)
│ parses: pair, entry,     │
│ SL, TP[]                 │
└────────────┬─────────────┘
             │ HTTP POST /validate  { pair, direction?, entry, sl, tp[] }
             ▼
┌──────────────────────────────────────────────────────────────┐
│ api/server.ts            (NEW — thin HTTP layer)               │
│  • zod-validate body        • rate-limit / shared-secret auth  │
│  • call validateSignal()    • return { score, breakdown }      │
└────────────┬───────────────────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────────────────┐
│ validation/index.ts      (NEW — orchestrator)                  │
│  1. Geometry guard  → reject INVALID_SIGNAL (SL wrong side)    │
│  2. Compute R/R, style, direction (if not supplied)            │
│  3. Gather context (parallel):                                 │
│        markets/mtf.ts        → MultiTimeframeData              │
│        markets/regime.ts     → RegimeAnalysis (from 1h candles)│
│        markets/keys.ts       → key S/R levels                  │
│        markets/news.ts       → getNewsContextForPrompt(pair)   │
│        markets/sentiment.ts  → funding/OI/LS ratio + F&G  (NEW)│
│        learning/index.ts     → getRelevantLessons(...)         │
│  4. Build payload (§4) → prompts.buildValidationPrompt()       │
│  5. client.getValidationScore() → ValidationResult            │
│  6. Persist SignalValidation row (prisma)                      │
│  7. notifications.sendValidationScorecard()                    │
└────────────┬───────────────────────────────────────────────────┘
             ▼
   Telegram scorecard  +  DB audit row  +  HTTP JSON response
```

### Modules reused (already in the repo)
- `markets/mtf.ts` — `buildMtfData(pair)` → `MultiTimeframeData` (4h/1h/15m/5m candles + indicators + regime).
- `markets/regime.ts` — `detectRegime(candles)`, `formatRegimeForPrompt(analysis)`.
- `markets/keys.ts` — `findKeyLevels(candles)`, `formatKeyLevelsForPrompt(levels)`.
- `markets/news.ts` — `getNewsContextForPrompt(pair)`, `hasRecentHighImpactNews(pair)`, `getUpcomingEventWarning()`.
- `markets/indicators.ts` — `calculateIndicators(candles)`.
- `learning/index.ts` — `getRelevantLessons(agentId, regime, signal, rsi, volumeRatio, pair, dayOfWeek)`.
- `claude/client.ts` — DeepSeek wrapper, `callWithFallback`, pricing/cost tracking, JSON-mode parsing.
- `claude/prompts.ts` — pattern for `buildSystemPrompt` / `buildEntryPrompt`.
- `utils/notifications.ts` — `notifications.*` Telegram sender (`safeSend`, HTML parse mode).

### New modules to build
| File | Responsibility |
|---|---|
| `types/validation.types.ts` | `IncomingSignal`, `ValidationPayload`, `ValidationResult`, dimension enums. |
| `markets/sentiment.ts` | Funding rate, open interest, long/short ratio (via `ccxt`/Bybit) + Fear & Greed (alternative.me). |
| `validation/index.ts` | The orchestrator above (`validateSignal()`). |
| `api/server.ts` | HTTP `POST /validate` (+ `GET /health`), zod body validation, shared-secret auth. |
| `prompts.buildValidationPrompt()` + `VALIDATION_SYSTEM` | New prompt builder + system prompt in `claude/prompts.ts`. |
| `client.getValidationScore()` | New export in `claude/client.ts`; add `validation` to `MODELS_BY_TYPE`. |
| `notifications.sendValidationScorecard()` | New method on the `notifications` object. |
| `prisma` `SignalValidation` model | Audit row. |

---

## 3. Data flow & derived fields (computed before the LLM call)

The orchestrator computes these from the raw signal so the LLM doesn't have to do arithmetic (and can't get it wrong):

- **direction** — if not supplied: `entry > sl` ⇒ `LONG`, else `SHORT`.
- **Geometry guard** — `LONG` requires `sl < entry < tp1`; `SHORT` requires `tp1 < entry < sl`. Violation ⇒ `INVALID_SIGNAL`, short-circuit, no LLM call.
- **riskDistancePct** = `|entry - sl| / entry * 100`.
- **rewardDistancePct** (to TP1) = `|tp1 - entry| / entry * 100`.
- **rrRatio** = `rewardDistancePct / riskDistancePct` (anchored on TP1).
- **style** — `scalp` if `riskDistancePct < ~0.6%` and tight TP spacing; else `swing`. Drives rubric weighting.
- **entryVsCurrentPct** = how far live price sits from the proposed entry (stale-signal detector).
- **Computed flags** (passed as context, never as hard caps): `counterTrend` (direction vs 1h+4h regime), `entryIntoResistance`/`entryIntoSupport` (entry within X% of a key level in the wrong direction), `overextendedRsi`, `lowVolume`, `nearHighImpactNews`, `staleEntry`.

---

## 4. ★ Data payload passed to the LLM (the core spec)

The single most important thing for scoring accuracy is **giving the LLM pre-digested, labeled context** — not raw candle dumps. Pass a structured JSON object embedded in the user prompt. Shape:

```jsonc
{
  "signal": {
    "pair": "BTCUSDT",
    "direction": "LONG",          // supplied or derived
    "entry": 67250,
    "stopLoss": 66800,
    "takeProfits": [67900, 68600, 69500],   // ALL TPs passed
    "leverage": 10                // optional, if the channel provided it
  },

  "geometry": {                   // server-computed, authoritative
    "riskDistancePct": 0.67,
    "rewardDistancePctTp1": 0.97,
    "rrRatioTp1": 1.45,
    "style": "scalp",             // scalp | swing — drives rubric weights
    "entryVsCurrentPricePct": 0.12,  // signal freshness
    "currentPrice": 67330
  },

  "marketContext": {
    "regime1h": "TRENDING_BULL",  // formatRegimeForPrompt output
    "regime4h": "RANGING",
    "regimeConfidence": 0.72,
    "trendAlignment": "WITH_TREND",  // WITH_TREND | COUNTER_TREND | NEUTRAL

    "timeframes": {               // condensed per TF — NOT raw 50-candle arrays
      "4h":  { "rsi": 58, "ema20": ..., "ema50": ..., "ema200": ...,
               "adx": 27, "atr": ..., "macdHist": 0.4, "volumeRatio": 1.1,
               "bias": "bullish", "structure": "higher highs/higher lows" },
      "1h":  { ... },
      "15m": { ... },
      "5m":  { ... }
    },

    "keyLevels": {                // from markets/keys.ts
      "nearestSupport": 66950,
      "nearestResistance": 67800,
      "entrySitsInside": "mid-range",   // near-support | near-resistance | mid-range
      "tpsVsLevels": "TP1 just below resistance @67800"  // clustering warning
    }
  },

  "sentiment": {                  // markets/sentiment.ts (NEW)
    "fundingRate": 0.012,         // % — crowded long if high positive
    "openInterestTrend": "rising",
    "longShortRatio": 1.8,        // >1 = crowd long
    "fearGreedIndex": 72,         // alternative.me — "Greed"
    "fearGreedLabel": "Greed"
  },

  "news": "<getNewsContextForPrompt(pair) text>",   // headlines + impact + event warnings

  "computedFlags": {              // context only — LLM weighs these, no hard caps
    "counterTrend": false,
    "entryIntoResistance": false,
    "overextendedRsi": false,
    "lowVolume": false,
    "nearHighImpactNews": false,
    "staleEntry": false
  },

  "lessons": [                    // getRelevantLessons() — past mistakes for THIS pattern
    "COUNTER_TREND_ENTRY: avoid longs when 4h EMA50 slopes down (lost 3/4 times)"
  ]
}
```

### Payload design principles
1. **Condense, don't dump.** Per-timeframe send the *digested* indicator readings + a one-word bias + structure label, not the raw 50-candle arrays. This is what makes scoring accurate and cheap — the LLM reasons over signal, not noise.
2. **Server does the math.** R/R, distances, direction, freshness, and all flags are computed in code. The LLM never recomputes geometry.
3. **Flags as evidence, not verdicts.** Every flag is informational. The LLM decides how much each matters given style + regime (per the locked "score freely" decision).
4. **All TPs, R/R on TP1.** Pass the full TP ladder; anchor the headline R/R on TP1 so partial-TP strategies are scored fairly.
5. **Lessons close the loop.** Reusing `getRelevantLessons` injects the bot's own historical mistakes for the active pattern, so validation improves as the trade journal grows.

---

## 5. LLM output schema (`ValidationResult`)

DeepSeek is called in JSON mode (`response_format: { type: 'json_object' }`), matching the existing client. Target schema:

```jsonc
{
  "score": 73,                    // 0-100 overall confidence
  "verdict": "TAKE",              // TAKE | TAKE_WITH_CAUTION | SKIP
  "dimensions": {                 // each 0-100, with a one-line reason
    "trendAlignment":   { "score": 80, "reason": "..." },
    "structureQuality": { "score": 70, "reason": "..." },  // entry vs S/R, level confluence
    "riskReward":       { "score": 65, "reason": "..." },  // R/R anchored on TP1
    "momentum":         { "score": 75, "reason": "..." },  // RSI/MACD/ADX across TFs
    "sentiment":        { "score": 60, "reason": "..." },  // funding/OI/LS/F&G crowding
    "newsRisk":         { "score": 90, "reason": "..." }   // higher = safer
  },
  "weightedBy": "scalp",          // which rubric profile was applied
  "keyRisks": ["TP1 sits just under 67.8k resistance", "funding crowded long"],
  "summary": "Trend-aligned scalp with clean R/R; main risk is TP1 clustering into resistance."
}
```

The overall `score` is the **style-weighted** blend of the dimensions; the LLM is told the weights for `scalp` vs `swing` in the system prompt (e.g. scalp weights momentum + structure higher; swing weights trendAlignment + R/R higher).

`verdict` thresholds (tunable, set in code post-parse, not by the LLM): `>=70 TAKE`, `50–69 TAKE_WITH_CAUTION`, `<50 SKIP`. Plus the hard `INVALID_SIGNAL` from the geometry guard.

---

## 6. Prisma model

```prisma
model SignalValidation {
  id            String   @id @default(cuid())
  pair          String
  direction     String
  entry         Float
  stopLoss      Float
  takeProfits   Float[]
  rrRatioTp1    Float
  style         String

  score         Int
  verdict       String          // TAKE | TAKE_WITH_CAUTION | SKIP | INVALID_SIGNAL
  dimensions    Json            // the per-dimension breakdown
  keyRisks      String[]
  summary       String

  regime1h      String?
  sentiment     Json?
  rawResponse   String?         // for audit / prompt-tuning
  source        String?         // e.g. "telegram:whales-vip"
  createdAt     DateTime @default(now())

  @@index([pair, createdAt])
}
```

---

## 7. Telegram scorecard (output)

`notifications.sendValidationScorecard(result, signal)` posts something like:

```
🎯 SIGNAL VALIDATION — BTCUSDT LONG
Score: 73/100  →  TAKE WITH CAUTION
Entry 67,250 · SL 66,800 · TP 67,900/68,600/69,500 · R/R 1.45 (scalp)

✅ Trend 80  ✅ Structure 70  ⚠️ R/R 65
✅ Momentum 75  ⚠️ Sentiment 60  ✅ News 90

⚠️ Key risks: TP1 just under 67.8k resistance; funding crowded long
"Trend-aligned scalp with clean R/R; main risk is TP1 clustering into resistance."
```

---

## 8. Build order

1. `types/validation.types.ts` — all interfaces/enums.
2. `markets/sentiment.ts` — funding/OI/LS (ccxt/Bybit) + Fear & Greed (alternative.me). New env: none required (public endpoints) — confirm Bybit derivatives endpoints are reachable.
3. `claude/prompts.ts` — `VALIDATION_SYSTEM` + `buildValidationPrompt(payload)`.
4. `claude/client.ts` — add `validation` to `MODELS_BY_TYPE` + `PromptType`; export `getValidationScore()`.
5. `validation/index.ts` — `validateSignal(signal, source?)` orchestrator (geometry guard → gather → prompt → score → persist → notify).
6. `api/server.ts` — `POST /validate`, `GET /health`, zod validation, shared-secret header auth, basic rate limit.
7. `utils/notifications.ts` — `sendValidationScorecard()`.
8. `prisma/schema.prisma` — `SignalValidation` model → `prisma generate` + migrate.
9. Wire `api/server.ts` startup into `index.ts` (behind an env flag, e.g. `VALIDATION_API_ENABLED=true`).

---

## 9. Open items / to confirm before coding

- **Auth on `/validate`** — shared-secret header is the minimum. Confirm whether the endpoint is localhost-only or exposed; if exposed, require the secret + rate limit.
- **`PromptType` is duplicated** — it's declared in both `types/claude.types.ts` and inline in `claude/client.ts`. Adding `validation` means editing **both** (or unifying them — worth doing as part of this).
- **Sentiment source reliability** — `markets/sentiment.ts` should degrade gracefully (null sentiment block) if Bybit/alternative.me are unreachable, rather than failing the whole validation.
- **`agentId` for `getRelevantLessons`** — validation isn't tied to a trading agent. Decide whether to pass a synthetic `"validator"` agent id or the default agent's lessons.
- **Rubric weights** — finalize the exact scalp vs swing dimension weights to put in `VALIDATION_SYSTEM`.

---

### Env additions
```
VALIDATION_API_ENABLED=true
VALIDATION_API_PORT=8787
VALIDATION_API_SECRET=<shared secret for POST /validate>
```
(No new LLM key — reuses `DEEPSEEK_API_KEY`.)
