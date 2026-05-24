# Trading Bot

An autonomous crypto trading bot. LLMs (Claude for entries, DeepSeek for everything else, routed via OpenRouter) make the trading decisions; the bot handles execution, risk, persistence, and a learning loop on Bybit perpetual futures.

Each **agent** is bound to a pair (e.g. BTCUSDT), a trading style (scalp/swing/position/auto), a risk %, a leverage, and a mode (`paper` or `live`). The bot ingests candles + ticker from Bybit WebSocket, runs a multi-stage decision loop, persists everything to Postgres, and notifies via Telegram.

---

## Architecture

```
┌──────────────────────┐    ┌──────────────────────┐
│  Bybit Public WS     │    │  Bybit Private WS    │
│  kline + ticker      │    │  execution + position │
│  (markets/websocket) │    │  (execution/index)    │
└──────────┬───────────┘    └──────────┬────────────┘
           │                           │
           ▼                           ▼
  ┌────────────────┐         ┌──────────────────┐
  │ Candle buffers │         │  Live SL/TP hit  │
  │ (in-memory)    │         │  pushed by Bybit │
  └────────┬───────┘         └────────┬─────────┘
           │                          │
           ▼                          │
  ┌────────────────┐                  │
  │  index.ts      │                  │
  │  handleCandle  │                  │
  └────────┬───────┘                  │
           │                          │
           ▼                          │
  ┌────────────────────────────┐      │
  │  agentManager              │      │
  │  processSignificantCandle  │      │
  └────────┬───────────────────┘      │
           │                          │
   ┌───────┼────────┐                 │
   ▼       ▼        ▼                 │
 entry  triggers  management          │
 cycle  fired     cycle               │
   │       │        │                 │
   └───────┴────────┴───→ execution ──┘
                              │
                              ▼
                         closeTrade
                              │
                              ▼
                       (post-mortem)
```

### File map

| Layer | Path | Role |
|---|---|---|
| Entry point | [index.ts](index.ts) | Boot, candle gating, graceful shutdown |
| Agents | [agents/index.ts](agents/index.ts) | `AgentRuntime` state machine + `AgentManager` |
| Triggers | [agents/triggers.ts](agents/triggers.ts) | In-memory + DB triggers, timeout checker |
| Market data | [markets/websocket.ts](markets/websocket.ts) | Bybit public WS (kline + ticker), realtime trigger fire |
| | [markets/regime.ts](markets/regime.ts) | ADX / BB / EMA slope / volume regime detection |
| | [markets/mtf.ts](markets/mtf.ts) | Multi-timeframe snapshot builder |
| | [markets/indicators.ts](markets/indicators.ts) | RSI, MACD, EMA, ATR, etc. |
| | [markets/keys.ts](markets/keys.ts) | Swing / structural level detection |
| | [markets/news.ts](markets/news.ts) | CryptoPanic news monitor |
| | [markets/historical.ts](markets/historical.ts) | Historical kline fetch |
| LLM | [claude/client.ts](claude/client.ts) | OpenRouter — Claude (entry) + DeepSeek (mgmt/postmortem/synthesis), per-call-type routing + Anthropic prompt caching |
| | [claude/prompts.ts](claude/prompts.ts) | System / entry / management / postmortem / synthesis prompts |
| Risk | [risk/index.ts](risk/index.ts) | Drawdown caps, R/R floor, position sizing, circuit breaker |
| Execution | [execution/index.ts](execution/index.ts) | Paper + live entry / management / close via ccxt + private WS |
| Learning | [learning/index.ts](learning/index.ts) | Post-mortem, lesson retrieval, weekly synthesis |
| Capital | [capital/index.ts](capital/index.ts) | Portfolio value resolution |
| Persistence | [prisma/schema.prisma](prisma/schema.prisma) | Postgres schema: Agent, Trade, Signal, TradeLesson, Candle, BacktestResult |
| Utils | [utils/logger.ts](utils/logger.ts) | Winston structured logs |
| | [utils/notifications.ts](utils/notifications.ts) | Telegram alerts |
| | [utils/helper.ts](utils/helper.ts) | Trade mapping, timeout calc |
| Diagnostics | [scripts/measure-prompts.ts](scripts/measure-prompts.ts) | Local prompt-token measurement (no API spend) |

---

## Full lifecycle

### 1. Boot — [index.ts:42](index.ts:42)

1. `agentManager.loadActiveAgents()` — load all `status='active'` agents from DB.
2. For each agent, `restoreAgentState(agent)`:
   - Open trade exists → state `IN_TRADE`, attach trade.
   - Active signal exists, not expired → restore triggers, set `WATCHING` (NO_TRADE) or `PENDING_ENTRY` (LONG/SHORT).
   - Expired signal → mark expired, `IDLE`.
   - Otherwise → `IDLE`.
3. `startTimeoutChecker()` — 30-second interval that fires `TIMEOUT` triggers from memory.
4. `seedCandleBuffers(pairs)` — REST-fetch last 200 candles per pair × `['5','15','60','240']` from Bybit.
5. `onCandle(pair, '5'|'60')` listeners registered → `handleCandle`.
6. `BybitWebSocket.connectWebSocket()` — opens public WS, subscribes `kline.{1,5,15,60,240}.{pair}` + `tickers.{pair}` per pair.

### 2. Signal generation

Two paths arrive at `agentManager.processSignificantCandle`:

**Candle-close path** — fires when a 5m or 60m candle closes ([index.ts:81](index.ts:81)):
- `handleCandle` gate decides whether to spend an LLM call: `significant` (per `isSignificantCandle`) **OR** `forceByTime` (no call in last 5 min) **OR** `breakout` (close > 20-bar high or < 20-bar low).
- If passed: build MTF snapshot, detect regime, fetch news context, then `processSignificantCandle`.

**Realtime trigger fire path** — fires on every ticker tick (~10 Hz) via [markets/websocket.ts:248](markets/websocket.ts:248):
- Sets `agent.needsReanalysis` or `agent.needsManagementReanalysis`, marks the signal triggered in DB, clears in-memory triggers.
- The next candle close picks up the flag and runs the appropriate cycle.

**Entry cycle** — [agents/index.ts:514](agents/index.ts:514):
1. `getDrawdownState(agent.id)` → `resolvePerformanceMode` decides NORMAL / GROWTH / CONSERVATIVE / RECOVERY.
2. `buildSystemPrompt(agent)` + `buildEntryPrompt(...)` constructed.
3. `getRelevantLessons` pulls up to 5 lessons matching current regime/RSI/volume/day.
4. `getEntrySignal(systemPrompt, entryPrompt, agentId)` — LLM call (cached system prompt when going through OpenRouter to an Anthropic model).
5. Result is one of:
   - **NO_TRADE** → `setTriggers(price_up, price_down, timeout)` from LLM's `triggers` field → state `WATCHING`. Telegram notify.
   - **LONG / SHORT** → `validateEntrySignal(...)`:
     - Circuit breaker / TP-direction / SL-direction / confidence ≥ 6 / drawdown caps / correlation / cooldown / **R/R ≥ mode floor (1.0 / 1.0 / 1.8 / 2.5)** / position size > 0.
     - On approval → `setTriggers(pendingTriggers={null,null,null}, signal, entryExpiry, positionSize)` → state `PENDING_ENTRY`. Telegram notify.

### 3. Trigger tracking

Triggers live in **two stores** — the in-memory `Map` in [agents/triggers.ts](agents/triggers.ts) and the Postgres `signals` table (`status='active'`).

| When | What | Where |
|---|---|---|
| Every ticker tick | Detect price crossing `entry`, `price_up`, `price_down`, or entry expiry | [markets/websocket.ts:257](markets/websocket.ts:257) `processRealtimeSignals` — reads DB |
| Every closed candle | Detect price crossing or timeout | [agents/triggers.ts:246](agents/triggers.ts:246) `checkTriggers` — reads memory |
| Every 30s | Detect `timeout` ISO time elapsed | [agents/triggers.ts:332](agents/triggers.ts:332) `startTimeoutChecker` — reads memory |

Fires one of: `ENTRY_HIT`, `PRICE_UP`, `PRICE_DOWN`, `TIMEOUT`, `EXPIRY`. Each is routed by `handleTriggerHit` ([agents/index.ts:393](agents/index.ts:393)).

### 4. Trade execution

#### Paper mode — [execution/index.ts:500](execution/index.ts:500)
- `executePaperEntry`: applies 2 bps slippage, generates `paper_<timestamp>_<random>` order id.
- Trade row created with `status='open'`, attached to agent (`attachTrade` → state `IN_TRADE`).
- Notification: `PAPER_OPEN`.

#### Live mode — [execution/index.ts:518](execution/index.ts:518)
- `executeLiveEntry`: `exchange.setLeverage(...)` then `exchange.createOrder(pair, 'limit', side, size, price, { takeProfit, stopLoss, timeInForce: 'GTC' })`. **Bybit holds the TP/SL natively** — the bot does not need to monitor for hits on the live side.
- `startPrivateWebSocket()` is called — opens authenticated WS to listen for fills, executions, position changes.
- Trade row created identically, state `IN_TRADE`, notification: `LIVE_OPEN`.

### 5. Live PnL tracking — [execution/index.ts:147](execution/index.ts:147)

`updateLivePnl(pair, currentPrice)` fires on every ticker update:
- For each `IN_TRADE` agent on that pair, recompute `unrealisedPnl` and `unrealisedPct` on the in-memory trade object.
- This is read-only — it does not autonomously close the trade.

### 6. Management cycle — [agents/index.ts:621](agents/index.ts:621)

Triggered when an `IN_TRADE` agent has `needsManagementReanalysis=true` OR a candle closes with no triggers OR a `TIMEOUT` / `PRICE_UP` / `PRICE_DOWN` fires.

1. Build management prompt (open trade + 4H/1H/15M/5M snapshot + news).
2. Call `getManagementDecision` (DeepSeek via OpenRouter, by default).
3. LLM returns `HOLD | ADJUST | CLOSE | PARTIAL_CLOSE` + new price triggers + `urgency`.
4. System overrides `timeout` with `calculateManagementTimeout(style)` — scalp 15m, swing/position 30m, auto 20m.
5. `updateTriggers(...)` on the same signal row.
6. `validateManagementDecision(...)` blocks any SL-widening attempt.
7. `executeManagement(agent, decision, trade)`:
   - **ADJUST** — update DB `takeProfit` / `stopLoss`; on live, `exchange.editOrder(...)` to update TP/SL on Bybit.
   - **CLOSE** — `closeTrade(agent, trade, 'CLAUDE_CLOSE')`.
   - **PARTIAL_CLOSE** — reduces position by `closePercent`.
   - **HOLD** — no-op.

### 7. Trade close

| Mode | Close trigger | Path |
|---|---|---|
| Live | TP or SL hit on exchange | Bybit pushes `execution` topic → [execution/index.ts:442](execution/index.ts:442) `handleExecutionUpdate` → `closeTrade(agent, trade, 'TP_HIT' \| 'SL_HIT', exitPrice)` |
| Live | Position size goes to 0 | Bybit pushes `position` topic → `handlePositionUpdate` → `closeTrade(..., 'BYBIT_CLOSE')` |
| Paper | LLM returns `CLOSE` | `executeManagement` → `closeTrade(..., 'CLAUDE_CLOSE')` |
| Both | Manual / external | `closeTrade(...)` called directly |

`closeTrade` ([execution/index.ts:271](execution/index.ts:271)):
1. Resolve exit price (override > live close call > latest ticker).
2. `calculatePnl(direction, entry, exit, size)`.
3. Update trade row: `status='closed'`, `exitPrice`, `realizedPnL`, `closeReason`, `duration`.
4. `agent.clearTrade()` → state `IDLE`.
5. Telegram notification with `WIN` / `LOSS` outcome.

### 8. Post-mortem & learning

After every `closeTrade` with `realizedPnL < 0` ([execution/index.ts](execution/index.ts)):
1. The `entrySnapshot` JSON saved on the Trade row at entry time (regime, RSI, volume ratio, news context) is read back.
2. `runPostMortem(closedTrade, regime, news, rsi, volumeRatio)` calls the LLM ([learning/index.ts:16](learning/index.ts:16)).
3. The model returns `patternTag`, `primaryReason`, `ruleToAdd`, `verdict`, `avoidable`.
4. `saveLesson(...)` writes a `TradeLesson` row.

Weekly synthesis runs in-process via `startSynthesisRunner` ([index.ts](index.ts)) every 7 days:
1. For each active agent, `synthesiseLessons(agentId)` is called.
2. Up to 100 most recent `TradeLesson` rows are condensed by the LLM into the top 5 recurring patterns.
3. Result is written to `Agent.learnedRules` JSON column.
4. The next entry cycle embeds those rules in the system prompt via `buildSystemPrompt`.

Lesson retrieval at entry time ([learning/index.ts:91](learning/index.ts:91)) uses tag matching: `getRelevantLessons` accepts `'LONG' | 'SHORT' | 'UNKNOWN'`. Pre-decision (`'UNKNOWN'`), it surfaces tags that apply for *either* direction so the LLM sees all potentially relevant lessons before choosing a direction.

---

## Setup

### Prerequisites

- Node 20+
- PostgreSQL 14+
- Bybit API key (testnet or mainnet) for live mode
- Telegram bot token + chat id for notifications
- OpenRouter API key (only LLM provider supported)

### Environment — `.env`

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/trading_bot

# Bybit
BYBIT_API_KEY=...
BYBIT_SECRET=...
BYBIT_TESTNET=true

# LLM
OPENROUTER_API_KEY=...

# News
CRYPTOPANIC_API_KEY=...

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Capital
PAPER_CAPITAL=1000
INITIAL_CAPITAL=1000
```

### Database

```bash
npx prisma generate
npx prisma migrate deploy   # or `dev` for local
```

Seed an agent manually (no CLI yet):

```sql
INSERT INTO agents (id, name, pair, "allocationPercent", "riskPercent", mode, "tradingStyle", status, leverage)
VALUES (gen_random_uuid(), 'BTC Swing', 'BTCUSDT', 10, 1, 'paper', 'swing', 'active', 10);
```

### Run

```bash
npm install
npm run dev     # tsx watch
npm start       # tsx (no watch)
```

### Challenge mode

Time-boxed single-agent runs with isolated capital (e.g. $5 → $50 in 30 days). See [docs/CHALLENGE_MODE.md](docs/CHALLENGE_MODE.md).

```bash
npm run challenge -- --agent-id=<uuid> --start=5 --target=50 --days=30 --mode=paper
```

Optional: `--max-dd=1.0` `--risk-pct=2` `--leverage=10`

The bot must be running (`npm run dev`) for the agent to trade during the challenge. On pass/fail/expire the agent is set to `paused`.

### Measure prompt sizes (no API spend)

```bash
npx tsx scripts/measure-prompts.ts
```

Reports system / user prompt token estimates per call type and whether each clears Anthropic's 1024-token cache minimum.

---

## Prompt caching & cost notes

[claude/client.ts](claude/client.ts) implements per-call-type routing:

| Call | Default model |
|---|---|
| Entry | `anthropic/claude-sonnet-4-6` (Opus fallback, Gemini Pro last resort) |
| Management | `deepseek/deepseek-chat-v3.2` (Sonnet fallback) |
| Post-mortem | `deepseek/deepseek-chat-v3.2` |
| Synthesis | `deepseek/deepseek-chat-v3.2` |

Anthropic system-prompt caching (`cache_control: { type: 'ephemeral' }`) is attached when the active model is Anthropic. The system prompt is ~1500 tokens — above the 1024 minimum — so it caches from day one. Look for `cacheStatus: 'HIT' | 'WRITE' | 'miss' | 'disabled'` in the logs.

Rough per-call cost on the OpenRouter path:

| Call | Tokens (in / out) | Model | Cost |
|---|---|---|---|
| Entry, cache hit | ~1500 sys + ~1300 user / ~250 | Sonnet | ~$0.008 |
| Management | ~1500 sys + ~900 user / ~150 | DeepSeek | ~$0.0008 |

---

## Operational notes

### Required after pulling this code

```bash
npx prisma generate           # picks up entrySnapshot column
npx prisma migrate dev --name add_entry_snapshot  # applies the migration locally
```

(Production: `npx prisma migrate deploy`.) Prisma 7.x requires Node 20+; the bot runs on Node 22 via nvm.

### Risk gates as currently configured

The validator now applies *two* mode-aware floors in series, after the static checks:

| Mode | Min confidence | Min R/R | Size multiplier |
|---|---|---|---|
| NORMAL | 6.0 | 1.0 | 1.0× |
| GROWTH | 6.0 | 1.0 | 1.0× |
| CONSERVATIVE | 6.5 | 1.8 | 0.75× |
| RECOVERY | 7.0 | 2.5 | 0.5× |

In drawdown the bot keeps trading but must clear a higher confidence floor *and* find asymmetric payoffs, at reduced size. There is no hard kill switch — `monthlyDrawdownCap` (10%) is still the absolute backstop.

### Test mode

`TEST_MODE = true` in [claude/prompts.ts:23](claude/prompts.ts:23) forces the LLM to return `LONG | SHORT` (never `NO_TRADE`) — useful for shaking out the pipeline. Flip to `false` before going live.

### Remaining caveats

- **Synthesis cadence** — `startSynthesisRunner` is a simple `setInterval(7d)`. Restarting the bot resets the clock; if uptime is fragmented to under a week, synthesis never fires. Move to a real cron / external scheduler if that matters.
- **Live TP/SL via `trading-stop`** — `updateLiveTpSl` now calls Bybit V5's `POST /v5/position/trading-stop` via ccxt's private endpoint passthrough. Defaults to one-way mode (`positionIdx: 0`); change to `1`/`2` if you run hedge mode.
- **Post-mortem cost** — Every losing trade triggers an LLM call (~$0.001 on DeepSeek via OpenRouter).

---

## License

ISC
