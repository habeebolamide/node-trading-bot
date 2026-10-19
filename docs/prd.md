# Multi-Bot Strategy Trading Platform — Product Requirements Document

**Document:** `prd.md`  
**Version:** 1.5 (Architecture Decision 18: Implementation Phasing & Module Dependencies)  
**Status:** Implementation specification; numeric strategy/risk thresholds marked provisional  
**Date:** 2026-10-19  
**Audience:** Codex, engineering, QA  

> **Product boundary:** This is the **new, simplified, rule-based platform**. Do **not** implement the superseded AI Brain, weighted multi-analysis-agent signals, LLM Judge, memecoin smart-wallet-ranking system, or LLM autopsy loop. This PRD supersedes that design. Develop and validate the system in simulation/paper mode first. Live-execution interfaces and security/reconciliation requirements are included as a future-gated module; their existence does not authorize enabling live trading without review.

## 1. Product overview

Build a Node.js/TypeScript platform that operates multiple independently configured strategy bots against cryptocurrency market data. Every bot owns one market/coin, runs one selected rule-based strategy, controls one trade lifecycle at a time, and has separate allocated virtual equity. Strategies define the technical indicators, required market-data timeframes, triggers, entry rules, NO_TRADE criteria, and position-management logic. A common infrastructure handles market data, history seeding, risk constraints, simulated orders and fills, positions, persistence, recovery, analytics, and Telegram alerts.

Operating modes are **SIGNAL_ONLY**, **PAPER**, and an explicitly gated **LIVE** mode. Public market-data access does not require authenticated Bybit access or exchange account credentials. CCXT is an optional unified exchange adapter, not a wallet connector. In live mode, connection to an exchange trading account uses restricted credentials and an authoritative exchange reconciliation layer. One bot may be PAPER while another is LIVE; the mode is per bot.

**Core objective:** Correct, reproducible decisions and position/accounting state under normal operation, delayed market data, partial fills, restarts, concurrent bots, and connection failures. Profitability is neither presumed nor guaranteed.

### 1.1 Goals

1. Independent strategy bots with one exclusive coin assignment each.
2. Strategies define their primary and optional confirmation timeframes, indicators, evaluation triggers, and entry/exit conditions.
3. Run technical analysis on confirmed candle closes (or strategy-specific events); monitor active entry/exit thresholds on live price events independently.
4. Record `NO_TRADE` as an explicit, expected result.
5. Support pending entries with both expiry and strategy invalidation; support paper fill/rejection/partial-fill models.
6. Support break-even, trailing stops, sideways/time exits, and early strategy-invalidation exits only as strategy-defined, testable policies.
7. Independent per-bot virtual capital ledger that compounds realized net profit/loss, without automatic replenishment from the other bots or unallocated funds.
8. Shared-account 80% allocation ceiling, central risk checks, and atomic capital reservation.
9. Reliable startup seeding, outage backfill/replay, idempotent decision processing and restart reconciliation.
10. Reproducible historical backtests, portfolio backtests, walk-forward testing and forward paper validation.
11. Explainable dashboard, structured audit events, incident management and asynchronous Telegram alerts, with no alert floods or trading-path dependency.

### 1.2 Non-goals / deliberately excluded from MVP

- No AI/LLM decisions, auto-learned weights, autonomous strategy generation, or LLM autopsy.
- No multiple bots monitoring/owning the same coin, even across strategies or modes.
- No intentional scale-in / pyramiding. Partial execution of one order **is** supported.
- No automatic strategy-switching between trend following, mean reversion, and arbitrage during one bot's run.
- No assumption that every strategy uses TA-Lib: arbitrage may be order-book/event driven.
- No mandatory microservices/Kafka; modular monolith preferred.
- **No Docker, Docker Compose, or container requirement** in development, CI, staging, or production.
- No promise of actual risk caps in turbulent live markets; stop orders can slip and cross-margin collateral may be exposed.
- No default Telegram remote trading commands.

### 1.3 Invariants (must not be violated)

- A strategy cannot call the exchange trading API or access exchange credentials directly.
- A bot may initiate **at most one unresolved entry/position trade lifecycle** at a time. If `IN_TRADE`, it generates **no new entries** but continues indicator reassessment for trade management and price monitoring.
- **Exclusive canonical coin ownership**: one bot per coin; prevent collisions such as BTCUSDT versus BTC/USDT. Ownership persists through pause, crashes, and open exposure until safely released.
- A bot may change execution mode PAPER ↔ LIVE **only in truly `IDLE` state** and with no pending orders, open positions, unresolved executions or capital commitments. Never transfer paper profits to a live account ledger.
- Total configured target bot allocations must be <= **80% of shared account equity**; 20% is a software allocation buffer, not physically isolated collateral.
- Profits/losses from Bot A adjust Bot A's actual virtual equity. Do not automatically top up Bot A just because account equity or its 20% target changes.
- Exchange-confirmed orders, fills and positions are authoritative in LIVE; the internal database is authoritative for our intents, configuration, virtual capital attribution and audit trail.
- Only fully closed candles are used for closed-candle TA; only data available at the decision timestamp can influence that decision.
- Unknown order status after timeout must be reconciled; do not blindly resubmit.
- All new exposure fails closed if market/account/risk state is stale or unresolved. Existing exposure protection and reconciliation remain a priority.
- **Telegram is strictly off the critical trading path**: no strategy evaluation, risk approval, capital reservation, order submission, fill reconciliation, stop adjustment, protective action or position-state transition may await Telegram delivery, availability, retry, rate limits or notification-worker completion. A notification cannot act as a prerequisite for a trade (separate future human-approval workflow excluded).

## 2. Decisions: confirmed versus provisional

### 2.1 Confirmed decisions

| Area | Decision |
|---|---|
| Runtime | **Node.js + TypeScript + Express.js** REST API; modular monolith; logical bot instances, no process per bot |
| Deployment | **No Docker or Docker Compose**. Native Node.js processes supervised by systemd (Linux) or PM2; separate API, trading runtime, background worker; controlled restart/reconciliation |
| Strategies | Rule based: trend following, mean reversion; extensible strategy interface; arbitrage separate event/market-data needs |
| Timeframes | Strategy declares primary evaluation timeframe and optional confirmation timeframes; bot does not arbitrarily choose these |
| Indicators | TA-Lib computes locally from retrieved OHLCV data; it is not a price/indicator provider |
| Evaluation | Confirmed primary candle close, except explicitly event-driven strategies |
| Entry decisions | LONG, SHORT, **NO_TRADE** |
| Entry wait | Time-based expiry **plus** cancellation on strategy invalidation |
| Active trade | No new entry proposals; continuous price monitoring and scheduled strategy reassessment |
| Position management | TP/SL, optional strategy-configured break-even, trailing, time/sideways exits, early thesis invalidation |
| Modes | SIGNAL_ONLY, PAPER, gated LIVE; per-bot mode; PAPER and SIGNAL_ONLY need no authenticated exchange account |
| Mode switch | Only when bot is IDLE and all associated activity resolved |
| Coin assignment | Exclusive coin ownership across all bots for MVP |
| Equity allocation | Per-bot target percentage; sum max 80% of shared account equity |
| Accounting | Separate virtual bot capital; net realized P&L compounds within its bot, no automatic top-ups |
| Capital reservation | Atomically reserve for pending order; convert to committed on fills; release after confirmed cancel/close/reconciliation |
| Leverage | Conservative max **5x**, Moderate max **10x**, Aggressive max **15x**; engine chooses lowest permitted leverage satisfying approved margin, never increases risk-sized notional to exploit leverage |
| Order feasibility | Reject impossible/small orders rather than increasing position beyond risk bounds; optionally notify Telegram |
| OMS | Support market/limit intents, partial fills, order states, idempotency, authoritative reconciliation |
| Historical data | Initial seed/backfill, time-series coverage checks, persistent closed candles, tick/trade data for more accurate replay |
| Recovery | Reconcile pending/open positions before resuming entries; replay price/candle history when possible; explicitly flag ambiguity |
| Emergency | Default **Protect & Freeze**; Controlled Closeout requires separate explicit authorization or tightly defined preauthorization |
| Validation | Historical and forward PAPER testing before any LIVE deployment; avoid look-ahead and report cost sensitivity |
| Observability | Structured correlated events, bot/system health, first-class incidents and NO_TRADE metrics |
| Notifications | PostgreSQL durable outbox, asynchronous independent delivery, per-bot/account preferences, dedupe/group/retry; **never in trade path** |
| Database integrity | Decision 15: normalized PostgreSQL domain schema, append-only capital ledger, DB-enforced coin exclusivity/one active trade, account-level concurrency locks, idempotent fill/intent processing, scoped paper/live records |

### 2.2 Provisional/test parameters (not independently proven)

These are candidate **paper/backtest settings**, not blanket live-operating recommendations. They must be versioned and revalidated. Product requirements take precedence over placeholder numeric values.

| Parameter | Conservative | Moderate | Aggressive |
|---|---:|---:|---:|
| Planned loss budget per trade (% bot equity) | 0.5% | 1.0% | 1.5% |
| Maximum initial margin per trade (% bot equity) | 10% | 15% | 20% |
| Maximum leverage | **5x** | **10x** | **15x** |
| Bot daily realized loss suspension | 2% | 3% | 5% |
| Bot peak-to-trough drawdown suspension | 5% | 8% | 12% |
| Maximum concurrent trade lifecycles per bot | 1 | 1 | 1 |

Account-level testing defaults: aggregate committed initial margin <= 40% equity; gross notional <= 100% equity; combined estimated loss-at-stop <= 2% equity; daily loss suspension <= 3%; peak-to-trough drawdown suspension <= 10%; target bot allocation <= 80%. Proposed historical seed: **500 complete candles per strategy-required timeframe**, unless indicator stability/testing requires more. Proposed trade-event hot retention: **24–72 hours**. All numerical thresholds besides explicitly confirmed caps must be configurable, documented, and evaluated in stress tests.

## 3. Architecture and component ownership

```text
Public Exchange REST / WebSocket / Optional CCXT Data Adapter
                     |
            Market Data Service
       (normalize / dedupe / health / gaps)
               /              \
     Closed Candle Service   Live Price / Trade Events
       |          |                  |
  History Seeding Cache       Event Dispatcher
       |          |                  |
     TA-Lib    Strategy Evaluation   Pending Entry / Position Monitor
             /    |     \             /
          LONG  SHORT  NO_TRADE      /
                 |                /
       Trade Proposal / Position Action
                      |
              Central Risk Engine
                      |
       Capital Reservation + Order Manager
                      |
              Execution Router
              /      |       \
         SIGNAL     PAPER     LIVE (gated)
          only     simulator  exchange adapter
                      |
          Position Manager + Bot Ledger
                      |
      Postgres / Audit / Analytics / Dashboard
                      |
             Telegram notifications

Support services: Reconciliation, Historical Replay, Backtesting,
Runtime Supervisor, Background Worker, Auth/Control API.
```

Responsibilities:
- **Strategy:** pure/mostly deterministic logic; timeframes/indicator demands, entry, invalidation, position reassessment; no DB writes/order placement.
- **Market Data Service:** public prices, candles, validity, sharing/cache, stream health, historical gaps.
- **Position Manager:** state transitions and stop/exit proposals driven by price events and strategy reassessment.
- **Risk Engine:** three-level account/bot/trade authorization, including sizing and instrument minimums.
- **Capital Ledger:** reservations, committed capacity, net P&L, transfers/rebalance; never confused with exchange wallet segmentation.
- **OMS:** order intents, submissions, fills, cancellation, protective orders, status reconciliation, idempotency.
- **Execution Adapter:** PAPER simulator or optional future-gated LIVE exchange adapter.
- **Runtime Supervisor:** leases, bot status, safe start/pause/resume/stop, replay after restart.
- **Control API:** authorized human commands, dashboard projections, audit.

## 4. Bot model, ownership and configuration

### 4.1 Bot creation fields

- Name, canonical market key (`exchange`, `marketType`, `baseAsset`, `quoteAsset`, and contract identity), selected strategy/version/preset.
- Per-bot execution mode: `SIGNAL_ONLY | PAPER | LIVE`.
- Risk profile plus permitted settings; target allocation percentage; notification preferences.
- Strategy owns timeframes, indicators, warm-up requirement, evaluation triggers and position-management policy. Bot references a tested preset; bot-specific strategy variations require versioned validated parameters.
- Create as `STOPPED` by default. Starting initiates readiness/recovery.

### 4.2 Separate operational versus trading states

Operational: `STOPPED`, `STARTING`, `WARMING_UP`, `RUNNING`, `PAUSED`, `STOP_REQUESTED`, `RECONCILING`, `RISK_SUSPENDED`, `ERROR`.

Trading: `IDLE`, `PENDING_ENTRY`, `IN_TRADE`, `CLOSING`, `UNRESOLVED`.

Also persist independent OMS order state (do not collapse into bot state): `CREATED`, `SUBMITTING`, `OPEN`, `PARTIALLY_FILLED`, `FILLED`, `CANCEL_REQUESTED`, `CANCELLED`, `EXPIRED`, `REJECTED`, `UNKNOWN`, `RECONCILING`.

Rules:
- `PAUSED` and `RISK_SUSPENDED` stop new entries, **not** position protection.
- `STOP_REQUESTED` blocks new entries; achieve `STOPPED` only after safe exposure resolution or a documented protection handoff.
- Only `IDLE` without unresolved exposure permits paper/live mode switching, symbol changes, or strategy changes requiring reinitialization.
- Changes to name and Telegram preference may be allowed during a trade; changes to market, strategy, execution mode, or risky parameters must be blocked/deferred.
- Record configuration version and all relevant changes as audit events.

### 4.3 Exclusive coin ownership

Unique canonical coin assignment across bots **including paused/paper/signal-only** bots until explicitly released. Use DB uniqueness/transaction, not process-local maps. Market key must disambiguate spot/linear contracts for data retrieval, while a separate canonical base-coin ownership key enforces the stricter 'one bot per coin' MVP rule. Restart does not release ownership. Do not release while unresolved entry/position/order exists.

## 5. Strategy interface and technical analysis

### 5.1 Typed conceptual contracts

```ts
type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h';
type Trigger = 'CANDLE_CLOSE' | 'MARKET_EVENT';

type StrategyRequirements = {
  primaryTimeframe?: Timeframe;
  confirmationTimeframes: Timeframe[];
  trigger: Trigger;
  indicators: Array<{
    name: string;
    timeframe: Timeframe;
    parameters: Record<string, number>;
  }>;
  minClosedCandlesByTimeframe: Partial<Record<Timeframe, number>>;
};

type EntryDecision =
  | { action: 'NO_TRADE'; reason: string; features?: Record<string, unknown> }
  | { action: 'PROPOSE_ENTRY'; side: 'LONG' | 'SHORT'; orderType: 'MARKET' | 'LIMIT'; entryPrice?: string; stopLoss: string; takeProfit?: string; reason: string };

type PendingEntryDecision =
  | { action: 'KEEP_PENDING'; reason?: string }
  | { action: 'CANCEL'; reason: string };

type PositionAssessment =
  | { action: 'HOLD'; reason: string }
  | { action: 'CLOSE_EARLY'; reason: string }
  | { action: 'SUGGEST_STOP'; newStopPrice: string; reason: string };

interface StrategyDefinition {
  id: string;
  version: string;
  requirements: StrategyRequirements;
  evaluateEntry(context: Readonly<StrategyContext>): EntryDecision;
  evaluatePendingEntry(context: Readonly<StrategyContext>, signal: Readonly<PendingEntry>): PendingEntryDecision;
  evaluatePosition(context: Readonly<StrategyContext>, position: Readonly<PositionSnapshot>): PositionAssessment;
}
```

Implement concrete types for `StrategyContext`, `PendingEntry`, and `PositionSnapshot` with precise market, event, data-quality and time fields; no ambient wall-clock calls within strategy logic. Use explicit event-time injection for replayability. Use decimal/fixed-point values for money and prices in persisted financial state; indicators may use floating-point arrays with controlled conversion and validity checks.

### 5.2 Strategy families

- **Trend following:** strategy-defined primary/confirmation candles; EMA/MACD/ADX/ATR are examples, not mandatory universal values. Entry only if defined conditions hold; sideways market may cause NO_TRADE and an open trend trade may close early according to its testable invalidation criteria.
- **Mean reversion:** strategy-defined shorter candles and bounded-market assumptions; RSI/Bollinger/ATR examples. Sideways conditions may be favorable rather than universally disqualifying.
- **Arbitrage:** event-driven spread/depth/liquidity/funding/fees analysis, not necessarily TA-Lib. Needs a separate historical executable-price/quote simulator; mark advanced implementation **post-MVP** unless proper data is available.

Strategy and management configs must be versioned and snapshotted with each decision. No generic 'close losing trade if no hope' heuristic. Every exit criterion must be deterministic, measurable and testable.

### 5.3 NO_TRADE is a first-class evaluation

Record `LONG`, `SHORT`, `NO_TRADE` proposals independently from downstream `TRADE_REJECTED`, `ENTRY_EXPIRED`, and actual `TRADE_EXECUTED`. Reasons include `NO_SETUP`, `WEAK_TREND`, `CONFLICTING_SIGNALS`, `MARKET_REGIME_UNSUITABLE`, `VOLATILITY_UNSUITABLE`, `INSUFFICIENT_DATA`; extensible per strategy. Do not call risk/order modules for `NO_TRADE`. Do not spam Telegram for routine `NO_TRADE`. While `IN_TRADE`, do not call `evaluateEntry`; use `evaluatePosition` and `HOLD` instead.

### 5.4 Candle seeding, evaluation and multi-timeframe alignment

- At bot startup, strategy declares required timeframes/indicators; query local history then backfill only missing ranges from public REST/CCXT market-data adapter.
- Seed sufficient **fully closed** candles (initial heuristic 500 per timeframe), exceeding lookback and accommodating recursive indicator warmup; strategy readiness validated on each timeframe.
- Shared cache/history per market/timeframe; do not fetch identical datasets per consumer.
- TA-Lib processes each timeframe separately. Never combine 5m, 15m, 1h candles into one series.
- Evaluate a candle-based strategy exactly once per confirmed **primary** candle close. Only expose the most recent **completed** confirmation timeframe candle as of that decision time.
- At 10:15, a 15m strategy with 1h confirmation must not read the still-developing 10:00–11:00 hourly candle.
- On gaps/insufficient seed: mark `WARMING_UP` or `BACKFILLING`, block new entries, continue needed protection for existing positions; after recovery do not retroactively execute old strategy signals as though current.
- Maintain exchange/event timestamp and ingest timestamp separately; define boundary conditions and no-lookahead tests.

## 6. Real-time price monitoring and position management

### 6.1 Two distinct clocks

1. **Price/trade event clock:** watch pending entry triggers and open position TP/SL/break-even/trailing thresholds; do not run full TA on each tick for candle-driven strategies.
2. **Strategy evaluation clock:** run TA on completed primary candle; call entry evaluation only when bot IDLE, pending invalidation when waiting, and open-position thesis reassessment when in trade.

Subscribe once per unique market where possible and distribute normalized events to owning bots. Favor individual trade/tick events over sparse periodic last-price polling for threshold ordering. Distinguish traded price versus mark/index/side-of-book; trigger and fill reference must be explicit per instrument/order.

### 6.2 Pending entry lifecycle

- A strategy emits proposal with limit/market policy and optional entry price; risk engine approves quantity.
- For pending limit entry, create a persisted intent/reservation and wait. Expire after strategy-defined candle count/time, **or** cancel earlier if new analysis invalidates setup.
- Cancellation requires confirmation; a cancel request may race with execution. Partial fill creates real (or simulated) exposure and must be protected.
- Once filled, pending-entry expiry no longer governs the open portion.

### 6.3 Management policy contract

```ts
type PositionManagementPolicy = {
  breakEven?: { enabled: boolean; triggerR: number; offsetR: number };
  trailingStop?: { enabled: boolean; type: 'ATR' | 'PERCENT'; atrMultiplier?: number; percent?: number };
  earlyExit?: { enabled: boolean; evaluateOnCandleClose: boolean };
  timeExit?: { enabled: boolean; maxHoldingCandles: number };
};
```

`R` is initial price-risk distance, not an assertion of guaranteed realized risk. Strategies opt into supported mechanisms; defaults and settings require paper validation. SL tightening cannot worsen normal planned risk: for LONG, tightened stop should not fall below confirmed stop; for SHORT, should not rise above confirmed stop. Desired stop, submitted amendment and confirmed effective stop are **different states**.

### 6.4 Exit/event sequencing

- Process confirmed fills/position state first; prevent duplicate closure.
- Handle active protective TP/SL triggers using event time and actual confirmed order state.
- Emergency controls can preempt ordinary strategy operations according to predefined policy.
- Strategy early-close and stop-adjustment proposals pass validation and the OMS.
- Serialize decision-changing operations per bot/position. Time ordering matters more than simplistic priority ranking; replay must not reorder actual events.
- Record reason and event reference for each stop adjustment, early exit and closure.
- Stop price is not a guaranteed fill price; account for costs/slippage/fee/funding.

## 7. Per-bot capital, shared allocation and risk engine

### 7.1 Equity model

One exchange account can support several independent virtual bot ledgers. Each bot has:

- `allocationTargetPercent` (e.g. 20%): target at initial funding or **explicit rebalance**.
- `fundedPrincipal` and explicit `capitalTransfers`.
- `realizedNetPnl`: cumulative attributed gains/losses including fees and funding.
- `actualBotEquity = fundedPrincipal + netCapitalTransfers + realizedNetPnl + attributableUnrealizedPnl` for exposure/mark-to-market reporting (with a separately reported realized-ledger balance).
- `availableBudget` net of reserved capital, committed margin, fee/maintenance buffers and current risk constraints.

**Example:** account starts $100; Bot A funded $20 at 20% target, Bot B $20; Bot A incurs $0.50 net loss => its realized ledger falls to $19.50, Bot B stays $20. Do **not** recompute Bot A funding as 20% of new $99.50 account ($19.90). The target and actual capital must be displayed separately. Future trade risk/margin scales with Bot A's actual available capital, subject to unrealized/exposure checks. Profits compound too.

80% aggregate target ceiling is enforced upon allocations/rebalances. Unallocated 20% is a policy buffer; cross-margin losses can still affect it in reality. At a decline in account equity, if existing allocations/commitments exceed a refreshed envelope, block new commitments and flag reconciliation; **do not** silently liquidate or top up bots. Verify exchange available collateral and margin mode independently.

### 7.2 Three authorization levels

- **Account:** 80% allocation ceiling, aggregate margin, notional, combined stop exposure, correlation, account daily loss and drawdown, margin health, unknown/manual positions.
- **Bot:** virtual equity, assigned risk profile, planned loss/trade, margin/trade, cumulative drawdown/daily loss, one-trade rule.
- **Trade:** entry/SL validity, stop-based estimated loss plus transaction costs, quantity step, min quantity/min notional, margin and allowed leverage, liquidity and liquidation proximity.

Strategy supplies entry, stop, target and order semantics. Risk engine **never widens stop to consume maximum budget**. Determine notional based on allowed loss and stop distance plus conservative costs; enforce margin cap and account exposure; choose lowest permitted leverage meeting all constraints; round quantity **down** to exchange step; recheck risk and minima; reject when minimum valid quantity cannot be accommodated. Do not increase notional merely because 15x is allowed.

Definitions:

```text
PlannedLossBudget = BotRiskBasis * profile.riskPerTradePercent
StopDistanceFraction = abs(entry - stop) / entry
ApproxNotionalCap = PlannedLossBudget / (StopDistanceFraction + estimatedCostFraction)
ApproxInitialMargin = Notional / chosenLeverage   [exchange adjustments apply]
```

The `stopDistanceFraction` is the price gap from entry to invalidation stop, **not** the configured dollar loss. Example: $20 bot, $2 maximum margin, $0.50 permitted planned loss; a 5x $2-margin position has ~ $10 notional, and a 2% adverse move is ~$0.20 before costs. The $0.50 is a ceiling, not a requirement to set wider stops. On a $20 bot, $0.50 is 2.5% risk, which exceeds the provisional conservative preset and must not silently override it.

### 7.3 Capital reservation lifecycle

State transitions:

```text
BOT FREE BUDGET
  -> RESERVED (durable risk-approved order intent, pending submission/entry)
  -> COMMITTED (executed filled exposure/order margin)
  -> RELEASED (confirmed cancelled unfilled quantity or closed reconciled exposure)
```

Atomic DB reservation before external submission; simultaneous bots may not overclaim available account collateral. Reserve estimated initial margin **plus** fee/risk buffer for pending orders. A partial fill commits executed share and preserves reservation for outstanding share. Unknown submission or cancellation outcome stays reserved until authoritative reconciliation. On close, release margin and apply net P&L to bot ledger **once** using unique execution IDs. Avoid double counting margin release as profit: if Bot A has $20, commits $2, then realizes -$0.50 net, its new bot capital is $19.50, not $21.50.

### 7.4 Risk suspension and exposure

If per-trade/order minimum constraints fail: reject with reason (`MIN_ORDER_NOT_MET`, etc.) and optionally Telegram notify (deduplicated). Bot/profile daily loss or drawdown breach suspends **new** entries. Account-wide breach suspends all new live entries; existing positions must remain managed. Include mark-to-market risk for account guards even when realized P&L is unchanged. Never treat virtual budget as physically ringfenced cross-margin collateral.

## 8. Order management and execution

### 8.1 Mode behavior

- **SIGNAL_ONLY:** evaluate strategy, produce proposals and Telegram/dashboard signal; no assumed fills or realized P&L; can optionally record hypothetical setups but do not call them trades.
- **PAPER:** risk-check, reserve simulated capital, run paper OMS/fill model, manage virtual positions and P&L; public data only.
- **LIVE (future-gated):** restricted authenticated connection to exchange, exchange-confirmed fills/order statuses, protected positions and reconciliation; requires separate deployment gate and review. Paper and live ledgers independent.

### 8.2 Entry orders

Support `MARKET` and `LIMIT`; strategy defines order type. Market order requests immediate liquidity, not guaranteed price. Limit may be pending/partially filled/rejected/expired. Exchange instrument rules and precision must be queried and cached with expiry/versioning. Arbitrage execution requires separate cross-market atomicity/leg-risk considerations and is not covered by simple single-leg OMS MVP.

### 8.3 Partial fills

If requested $20 notional and $8 fills, record actual $8 exposure and immediately protect that filled quantity; keep unfilled quantity separately. If entry window ends, cancel remaining quantity once confirmation is obtained; preserve executed quantity. **No deliberate scale-in**. Position quantity/average fill and protective quantities derive from executions, not original requested intent.

### 8.4 Exit/protection and close-only semantics

Persist desired vs confirmed protective SL/TP and their trigger-price references (`last`, `mark`, `index`, bid/ask as supported). Ensure real filled exposure has adequate confirmed protection. Stop move requires adapter acknowledgment and verification. Early-close requests must be close-only/reduce-only where supported; reconcile stale protective orders and residual quantities. Partial close leaves residual exposure protected. Do not assume a cancelled/amended order actually changed until reconciliation confirms it.

### 8.5 Durable intents and unknown result

Persist `clientOrderId`, intent and risk reservation before submission. On API timeout or restart, look up exchange order by client ID / executions / positions before any retry. Unique IDs, DB constraints and idempotency reduce duplication but do not magically ensure exactly-once exchange execution. Record `UNKNOWN` / `RECONCILING` where necessary.

## 9. Market data storage and retention

### 9.1 Persistence

- **PostgreSQL:** complete OHLCV candles, data coverage/gaps/checkpoints, bot/config/orders/positions/fills/ledgers/audits/backtests; initial indefinite candle retention, revisit with volume.
- **In-process cache or optional Redis:** latest price, in-progress candle, deduplicated hot subscriptions and status; cache not sole truth.
- **Durable rolling trade-event buffer:** provisional 24–72h for outage replay, bounded by throughput and storage.
- **Compressed archives (e.g. Parquet):** larger imported historical tick/trade/order-book datasets for backtests; record their version and coverage.
- Unique candle key: `(exchange, canonicalMarketId, timeframe, openTime)`; include completeness and source metadata.

### 9.2 Integrity

Validate OHLC relationships, monotonic timestamps, continuity, closed flag and source precision. Track missing intervals and corrections. Deduplicate trade events by exchange identifier when available; otherwise use carefully documented event identity with collision/ordering caveats. Store both event and ingestion clocks. Fetch required timeframes natively where supported; do not indiscriminately aggregate all from 1m unless implemented with strict completeness/alignment checks.

### 9.3 Outage recovery

After live feed gaps, buffer new events, retrieve available missing historical trades and candles, replay in event order, merge/dedupe buffered events, reconstruct pending entry/TP/SL/break-even/trailing state and resume only after verification. If candles contain both TP and SL but no tick ordering, mark `RECONCILIATION_UNCERTAIN`; do not invent a fill sequence. For live connections, replay cannot create hypothetical orders that were never submitted: REST/private WS exchange order/fill/position snapshots are authoritative. When trade history unavailable, disclose uncertainty and block unsafe processing.

## 10. Runtime orchestration and background jobs

### 10.1 Implementation shape

Single TypeScript modular monolith with logical bots and one active bot-runtime worker initially. Suggested runtime boundaries: HTTP Control API, public Market Data Runtime/dispatcher, Bot Supervisor, critical OMS/Risk/Position services, Background Worker. May run as separate processes as load requires, but share contracts and Postgres.

- Per-bot serialized state changes; DB-unique evaluation key `(botId, strategyVersion, trigger, closedCandleTime/eventId)`.
- Durable order-intent and capital-reservation transaction before side effects.
- Runtime ownership lease/fencing token for safe deployments; do not rely exclusively on in-memory mutex.
- Price tick processing directly in low-latency dispatcher, not per-tick BullMQ jobs.
- On startup: restore ownership and unresolved state, reconcile exposure/protection first, backfill/seed required history second, enable eligible entries last.
- On graceful shutdown: stop new intents, checkpoint pending work, preserve protection, do not automatically close positions.

### 10.2 Background workloads

Good candidates: candle seeding, historical backfills, long backtests, report generation, noncritical analytics, Telegram retry delivery. Worker threads/separate process for CPU-heavy backtests to avoid event-loop stalls. **BullMQ/Redis optional initially**; if omitted, persist retryable job state for important work. Never allow a Telegram outage to block trade monitoring. Critical order/position reconciliation gets immediate high-priority handling, not buried behind reports.

## 11. Historical backtesting and validation

### 11.1 Engine requirements

Replay exactly the same strategy/TA/position-management/risk/ledger contracts used in PAPER. Substitute historical-event feed and paper execution simulator. Seed indicators from prior history before measured test window. Enforce no look-ahead: T0 decision cannot use future price, unfinished higher-timeframe candles, or fill prices assumed available at T0. Simulated decisions execute only after their information became available. Include partial fills, fees, spread, slippage, funding, latency and instrument minima as data allows.

Support (1) independent bot tests and (2) portfolio tests enforcing shared 80% allocation, central exposure/risk and exclusive coin ownership. If only OHLCV is available and TP/SL touch the same bar, use explicit uncertainty or labeled sensitivity assumptions, not fabricated precision.

### 11.2 Evaluation outputs

Persist per-run strategy/config/risk policy/data snapshot/execution model/code versions and simulation seed. Report total evaluations, NO_TRADE count/reasons, LONG/SHORT proposals, risk rejections, expired entries, filled trades, P&L after costs, returns, win rate, profit factor, expectancy, average win/loss, max drawdown, max losing streak, holding duration, fee/funding/slippage totals, margin usage, close reasons (TP/SL/BE/trailing/early/time), uncertain runs and data coverage. Sample size and slippage sensitivity must be visible.

### 11.3 Validation lifecycle

`DRAFT -> BACKTESTING -> VALIDATED -> FORWARD_PAPER -> LIVE_ELIGIBLE` (last phase gated). Train/parameter-select on training windows; walk-forward test on unseen windows; reserve an untouched holdout; prevent leakage from overlapping outcome windows. Compare controlled A/B strategy variants on identical data (e.g. BE on/off). Version-specific validation: meaningful changes require revalidation. Do not choose arbitrary profitability thresholds and declare them proven; formalize gates after examining sample size and evidence.

## 12. Dashboard and REST/WebSocket API

### 12.1 Views

- **Portfolio:** exchange or simulated equity, 80% allocation limit, target allocation vs current actual bot equity, unallocated buffer, committed/reserved margin, gross exposure, unrealized/realized P&L, account guard states.
- **Bots list:** name, coin, strategy/preset, mode, operational status, trade state, bot equity, health, risk state.
- **Bot detail:** config/version, timeframe/indicators, historical readiness, decision log (including NO_TRADE), pending order/position, entry/stop/TP, confirmed protection, P&L, drawdown, order/fill/event history.
- **Backtests:** start/configure, progress, reproducible comparisons, test/holdout evidence, data-quality warnings.
- **Incidents:** stale data, unresolved order, reconciliation progress, emergency mode, audit.

### 12.2 Suggested API endpoints

```text
GET    /api/strategies
GET    /api/risk-profiles
GET    /api/bots
POST   /api/bots
GET    /api/bots/:id
PATCH  /api/bots/:id
POST   /api/bots/:id/start
POST   /api/bots/:id/pause
POST   /api/bots/:id/resume
POST   /api/bots/:id/stop
POST   /api/bots/:id/change-execution-mode
GET    /api/bots/:id/evaluations
GET    /api/bots/:id/orders
GET    /api/bots/:id/positions
GET    /api/bots/:id/performance
GET    /api/bots/:id/events
GET    /api/portfolio
GET    /api/market-data/health
POST   /api/backtests
GET    /api/backtests/:id
GET    /api/incidents
POST   /api/emergency/protect-and-freeze
POST   /api/emergency/controlled-closeout   [separately authorized/gated]
```

State-changing HTTP operations are *requests*; return pending/accepted versus completed states accurately. Use authenticated dashboard WebSockets/SSE for live projections; client never connects directly to exchange credentials. Protect APIs with auth, authorization, validation, rate limits and CSRF protection as applicable.

## 13. Monitoring, observability, incidents and Telegram notifications (Decision 14, confirmed)

### 13.1 Non-negotiable separation from trading

**Telegram is an asynchronous consumer of trading events, never a dependency of the trading runtime.** Trading decisions and critical order/position transitions must complete according to the ordinary durable execution protocol irrespective of Telegram responsiveness, message delivery success, bot token invalidity, Telegram rate limits or worker backlog. Do not call `sendMessage`/Telegram HTTP in any strategy, risk, OMS, execution, position manager or account-reconciliation handler. Do not `await` a notification worker, delivery receipt or enqueue-to-external-service operation from those handlers. A real-time decision must not wait for notification dispatch to confirm order intent, submit an order, act on a fill, move protective stops or execute an early exit.

**Preferred reliable design:** create the relevant domain event in the **same business database transaction** as the durable state change, then let a separate outbox projector/notification worker asynchronously materialize deliveries. An implementation may atomically include a small outbox record in the transaction, provided its creation is local and bounded; it must not depend on Telegram availability. If outbox persistence fails because the shared database is unhealthy, apply normal trading-state durability/fail-closed rules, not an invented rule that Telegram must succeed. Place limits on notification workload, use separate DB pools/resources if justified, and prevent noisy notification writes or backlog scans from starving trading DB transactions. The strategy and OMS must have no synchronous RPC dependency on notification processes. A notification event is informative, not an exchange execution acknowledgment.

Flow: `trading action/state transition -> durable domain event -> [independent event projector/outbox] -> notification worker -> Telegram`. If Telegram is down for 30 minutes, trading correctness and protection must be unchanged; pending notifications may become delayed, merged or terminally failed according to policy. Critical incidents still exist in the database/dashboard even without Telegram.

### 13.2 Observability domains and health contracts

Track five domains independently rather than inferring health from a bot's `RUNNING` flag:

| Domain | Monitor | Consequence of unhealthy state |
|---|---|---|
| Bot/runtime | operational/trading state, runtime ownership/lease, last successful evaluation, error count, processing lag | Mark `DEGRADED`/`CRITICAL`; block affected new entries when correctness cannot be guaranteed |
| Market data | last received trade, WS heartbeat, last confirmed candle, missing candle intervals, gaps, freshness by exchange/market/timeframe | Backfill/reconcile; do not use stale/incomplete inputs for new signals |
| Strategy decisions | LONG/SHORT/NO_TRADE counts and reason codes, skipped entry evaluations, invalidation decisions | Make selectivity and missed opportunities auditable; no alert on each NO_TRADE |
| Capital/risk | bot actual virtual equity, realized vs unrealized P&L, reserved/committed/free capacity, allocation targets, account 80% envelope, drawdown, portfolio gross and planned-stop exposure | Account/bot risk suspension as already defined, preserve active protection |
| Execution/protection | order acknowledgment latency, unknown submission, partial fills, stop desired/submitted/confirmed state, missing exchange-side protection, ledger mismatches, reconciliation duration | Critical incidents and Protect & Freeze where warranted; never claim unverified protection |

Health is independently classified `HEALTHY`, `DEGRADED`, `CRITICAL`, `UNKNOWN`, with timestamp and reason. A quiet market is not proof of a failed trade stream: compare websocket heartbeat/provider health and market activity before raising stale-feed alarms. Thresholds are configurable per market and evaluation timeframe; absent stop protection on a confirmed live position is immediately critical. Health snapshots must distinguish **market event time** from **processing/observation time**.

### 13.3 Structured logs, traceability and audit data

Emit machine-readable JSON logs and persist important **domain events** in PostgreSQL. Minimum event contract:

```ts
interface ObservabilityEvent {
  eventId: string;               // globally unique and deduplicated
  eventType: string;             // e.g. strategy.no_trade, order.fill, risk.suspended
  severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  eventTime: string;             // source/market time if applicable
  observedAt: string;            // processing time
  correlationId?: string;        // joins evaluation -> risk -> order -> position
  causationId?: string;
  accountId?: string;
  botId?: string;
  strategyId?: string;
  strategyVersion?: string;
  configVersion?: number;
  evaluationId?: string;
  signalId?: string;
  orderIntentId?: string;
  clientOrderId?: string;
  positionId?: string;
  incidentId?: string;
  reasonCode?: string;
  details: Record<string, unknown>; // sanitized, bounded payload
}
```

- Persist decisions, fills, protection amendments, risk suspensions, capital ledger changes, operator controls and incident changes as durable and correlated records.
- Keep financial/OMS ledgers authoritative; observability views reference them rather than creating independent balance figures. Maintain immutable evidence of what the strategy knew **at its decision timestamp**. Do not retrospectively rewrite a NO_TRADE to a trade after market data changes.
- Do **not** insert every tick into audit logs. Tick recording/storage follows the market-data retention policy in section 9; log aggregates and anomalies in observability.
- Redact API secrets, signatures, auth tokens, private connection payloads and personally sensitive data. Bound log cardinality/size, and make logging failures incapable of changing trade decisions (subject to required transactional business/audit durability).

### 13.4 NO_TRADE and evaluation analytics

For every completed eligible strategy evaluation persist LONG, SHORT or NO_TRADE plus reason code and input/indicator snapshot. Distinguish:

1. `NO_TRADE`: strategy found no valid setup; no reservation/risk order flow.
2. `PROPOSED`: strategy emitted candidate entry.
3. `RISK_REJECTED`: candidate failed risk, leverage, exchange minimum or account checks.
4. `PENDING_ENTRY` / `ENTRY_EXPIRED`: approved setup has not filled / expired or invalidated.
5. `FILLED`: confirmed paper/live executed quantity (identify execution mode).

Dashboard aggregates evaluation totals, NO_TRADE percentage/reasons, long/short counts, rejected proposals, expired entries, fill counts and performance on filled trades. Store individual evaluations but **do not notify Telegram for each NO_TRADE or price tick**. In-trade strategy assessment is `HOLD`, not an entry NO_TRADE.

### 13.5 Incident lifecycle and escalation

Create first-class `system_incidents` with status `DETECTED -> ACTIVE -> ACKNOWLEDGED -> RECOVERING -> RESOLVED` (allow suitable alternate recovery paths); store timeline in `incident_events`. `ACKNOWLEDGED` means seen, **not** cleared or permission to resume. An incident has canonical `fingerprint`/dedupe key, source, severity, affected account/bots/markets, first/last seen, occurrence count, applicable safety actions, operator and resolution evidence. Resolve only after the underlying fault is actually recovered and any required order/account reconciliation succeeded.

Severity and delivery policy:

| Level | Typical examples | Default action/notification |
|---|---|---|
| INFO | bot started, simulated trade closed, qualified signal | configurable per bot |
| WARN | seed delayed, data stale, recurring min-order failure | aggregate/throttle by incident and cooldown |
| HIGH | unresolved order, bot/account loss suspension, material ledger mismatch | immediate notification attempt and dashboard incident |
| CRITICAL | live position protection unverified, credential incident, duplicate live execution, unauthorized exposure | immediate attempt, account-level incident, repeat/escalate until acknowledged/resolved; trigger agreed safety policy |

Create **one account/exchange-level incident** for shared feed or authenticated connection failure and relate affected bots; avoid a new Telegram message per bot per retry. Distinguish incident notification attempts from the actual safety action: Protect & Freeze occurs independently of messaging. Critical alert delivery failure raises an observability problem, but must not prevent the protection workflow. Notification escalation timing and channels are provisional configuration, not invented guaranteed delivery semantics.

### 13.6 Telegram delivery and preference model

- Account preferences govern security, critical failures and exchange/account-level risk; individual bot preferences govern optional signal, entry, exit, stop movement, break-even, recovery and periodic digest events. A bot cannot opt out of recording incidents merely by silencing Telegram.
- Telegram is one-way notification-only for MVP; **no trade approval/order submission/risk override via Telegram**.
- Use PostgreSQL `notification_outbox` and `notification_attempts`, processed asynchronously by dedicated worker or lightweight durable poller. BullMQ/Redis may be adopted later; it is **not** needed for correct order execution. No unbounded in-memory-only queue for important notifications.
- Outbox rows: `id`, `domainEventId`, `destination`, `recipientRef`, `templateKey`, `payloadSnapshot`, `dedupeKey`, `severity`, `status`, `availableAt`, `attemptCount`, `lastError`, `sentAt`, `createdAt`; attempts reference outbox row, attempt number, result/Telegram message id when available and retry timing.
- Apply unique event/destination keys to prevent duplicate outbox rows, group recurring incidents and throttle noisy warnings. Use bounded exponential backoff/jitter, respect 429 `retry_after`, limit concurrent sends, and dead-letter persistent failures. Do not assert exactly-once Telegram delivery: a send could succeed and its acknowledgment be lost; tolerate occasional duplicate messages.
- Template messages must show **PAPER vs LIVE vs SIGNAL_ONLY** clearly, bot/market/strategy, event, reason, financial figures only from authoritative relevant records, and links/IDs for traceability. Paper profit is never labeled realized live profit.
- Optional daily report combines per-bot net results, actual bot equity, account allocation, NO_TRADE counts, rejected signals, incidents and unresolved orders. Do not promise reports if no scheduler/delivery process is running.

### 13.7 Dashboard monitoring API and metrics

Add a system monitoring view and per-bot activity timeline. System overview shows running/degraded bots, open/unresolved positions/orders, incident counts, account allocation/risk limits and the state/freshness of market data, runtime, execution reconciliation and Telegram worker. Per-bot view includes P&L/equity, orders/position protection, decision reasons, last evaluation, current market-data readiness, and health timeline.

Suggested authenticated endpoints (in addition to section 12):

```text
GET   /api/monitoring/health
GET   /api/monitoring/metrics
GET   /api/bots/:id/health
GET   /api/bots/:id/evaluations
GET   /api/bots/:id/events
GET   /api/incidents?status=&severity=
GET   /api/incidents/:id
POST  /api/incidents/:id/acknowledge
GET   /api/notifications/preferences
PATCH /api/notifications/preferences
GET   /api/notifications/delivery-status
```

All control actions are authenticated, authorized and audited. An acknowledge request does not clear an active risk suspension. Dashboard updates may use existing authenticated WebSocket/SSE transport but must not obstruct the market feed event loop.

Metrics include: last live trade and WS heartbeat, last closed candle per timeframe, strategy evaluation lag, duplicate evaluation attempts, replay gap duration, reconciliation backlog/time, unknown orders, confirmed protection coverage, reservation mismatch, account/bot drawdown, per-bot NO_TRADE/reject rates, notification backlog age/rate and send errors. Expose lightweight counters/gauges/histograms initially; OpenTelemetry/Prometheus/Grafana can be introduced when justified. Thresholds require configuration based on venue and strategy; do not use one arbitrary global timeout.

### 13.8 Reliability and acceptance requirements

- Telegram API never appears inside the critical-path call stack. Mock Telegram with indefinite hangs, 429s, 5xx and invalid credentials: entry processing, order operations, fills, TP/SL and protective stop management continue according to their own safety/reconciliation state.
- Kill notification worker during a trade: position lifecycle completes without waiting; durable events/undelivered notifications remain for a restarted worker.
- Create 100 NO_TRADE decisions: 100 stored evaluations, **zero** default individual Telegram messages.
- Simulate shared Bybit feed outage affecting three bots: one canonical incident with three affected bots, one initial grouped alert; block only appropriate new entries and reconcile before resuming.
- Missing confirmed live protective stop: critical incident and default Protect & Freeze independently of Telegram delivery; operator sees incident on dashboard.
- Outbox retries with exponential backoff and dedupe; long outage doesn't cause unbounded DB writes or busy-loop retries. Message acknowledgment loss is safely tolerated (at-least-once, not guaranteed exactly-once).
- Correlation ID connects strategy evaluation, risk approval/rejection, reservation, order, fill, position/stop change and outbound message reference.
- Acknowledged incident never auto-resumes a bot; resolve only after explicit health checks/reconciliation, with audit evidence.
- After a process restart, open incidents, alert preferences and unsent notifications remain available; no duplicate account risk actions are applied merely because events are replayed.

## 14. Exchange connection and security architecture

- PAPER/SIGNAL_ONLY: public data, no API key required; optional CCXT public market adapter.
- LIVE: explicitly provisioned exchange connection; private REST/WS order, execution and position reads; credentials encrypted at rest, key stored separately, least-privilege trading permissions, no withdrawal/transfer permissions, API IP allowlist where available, secret rotation/revocation.
- Keep credentials server-side only; strategy modules, frontend and Telegram never receive them.
- Distinguish connection `DISCONNECTED`, `CONNECTING`, `CONNECTED_READ_ONLY`, `CONNECTED_TRADING`, `DEGRADED`, `RECONCILING`, `ERROR`; authorization capabilities must be explicit, not inferred from mere WebSocket connectivity.
- Sandbox/testnet and production environments must be unmistakably separated. Enabling LIVE requires deliberate authenticated confirmation and validated readiness.
- Exchange API rate limiting/backoff, signed request clock consistency, identity/permission checks, audit records, and secure backups with restoration drills are required for gated live capability.
- A stale runtime must not bypass execution ownership leases or persistent idempotency checks.

### 14.1 Emergency policy (confirmed)

**Default: Protect & Freeze.** Suspend new entries, cancel only eligible unfilled entry orders with reconciliation, preserve confirmed protective stop/TP coverage, alert operator and continue exposure monitoring as possible. A process kill alone is NOT an emergency stop.

**Controlled Closeout:** separate explicit operator authorization or narrowly pre-authorized, precisely tested emergency criteria; attempt risk-aware reduce-only close, reconcile partial fills/residual exposure and protective-order state, alert operator. Do not automatically use market-close for every infrastructure error. When state is unknowable, flag critical incident rather than claiming success.

Failure policy: failures in data, DB, Risk Engine or exchange order-state verification stop **new exposure**; existing position protection and emergency reconciliation remain prioritized. Telegram failure does not affect trading logic.

## 15. Database Schema & Data Integrity — Decision 15 (confirmed)

### 15.1 Database design principles and naming conventions

PostgreSQL is the durable source of truth for bot configuration, virtual capital, order *intent*, position state projections, risk decisions, execution history, incident records, and notifications. Exchange state is authoritative for **real live orders, fills, balances, and positions**; reconcile discrepancies instead of treating database state as proof of execution. Paper fills are authoritative only within their identified simulator run or paper environment.

- Prefer Drizzle ORM and explicit SQL migrations; write raw SQL migrations for partial unique indexes, check constraints, exclusion constraints, or locking semantics not conveniently expressed by the ORM.
- Every owned row carries an `account_id` or a path to one; never allow a query to cross accounts inadvertently. Initially a single application owner is fine, but preserve account boundary in schemas.
- All primary IDs are UUIDs (or consistent database-generated unique IDs). Use `timestamptz` for wall-clock times, `bigint` for canonical exchange event time in milliseconds if useful, and both `event_time` and `observed_at` where causality matters.
- All monetary, quantity, fee, and price columns use `NUMERIC(p,s)` with precision chosen after checking exchange maxima; never calculate money using JS `number` for authoritative ledger operations. The example DDL below uses `numeric(38,18)` for amounts and prices, and bounded `numeric(9,6)` for percentages; refine scales by product needs. Values returned over JSON should be decimal strings.
- Explicit `environment` (`PAPER`, `LIVE`, `BACKTEST`) or `trading_scope_id` distinguishes independent accounting/execution worlds. `SIGNAL_ONLY` has no real/simulated funded position ledger unless deliberately introducing signal-performance simulations as a separate feature.
- Use consistent `created_at`, `updated_at`, `version` fields where applicable; immutable version records and financial postings are **append-only**, not silently overwritten.
- State fields use DB-checked enums or checked `text` values. Application transitions must also be validated in domain code; a database `CHECK` validates possible values, not legal transitions.
- Every potentially replayed event has a stable idempotency key. External exchange identifiers are unique **within exchange connection, market and appropriate execution scope**, rather than assumed globally unique.
- Soft-deletion is suitable for user-facing bots; never soft-delete or cascade-delete audit history, fills, ledger entries, or reconciliation evidence.

### 15.2 Relationships and logical ERD

```text
app_users 1 --- N exchange_accounts / execution_scopes
exchange_accounts 1 --- N exchange_connections
exchange_accounts 1 --- N bots
bots 1 --- N bot_config_versions
bots 1 --- 0..1 active coin_ownership
bots 1 --- N strategy_evaluations --- 0..1 signals
bots 1 --- N trade_lifecycles --- N order_intents --- N orders --- N order_fills
trade_lifecycles 1 --- 0..N position_protection_versions
bots 1 --- N bot_capital_accounts (separated by execution scope)
bot_capital_accounts 1 --- N capital_ledger_entries
bot_capital_accounts 1 --- N capital_reservations --- order_intents
exchange_accounts 1 --- N account_allocation_snapshots / account_risk_snapshots
market_instruments 1 --- N candles / market_checkpoints / market_data_gaps
strategies 1 --- N strategy_versions / strategy_presets
backtest_runs 1 --- N backtest_events / backtest_trades / simulation capital ledgers
system_events 0..N --- 0..N system_incidents (via references or incident_events)
system_events 1 --- 0..N notification_outbox --- N notification_attempts
bots 1 --- 0..1 runtime_leases
```

`trade_lifecycles` is a durable parent for one pending→open→closing→closed lifecycle, including partial fills. `positions` is the quantity/cost/P&L projection of that lifecycle; **an order is not the same as a position**. An exit can consist of multiple order intents and fills. Multiple protective-order revisions may occur during one lifecycle.

### 15.3 Core table specification

| Table | Core columns | Constraints / notes |
|---|---|---|
| `app_users` | `id`, `email`, `password_hash` or auth-provider ID, `created_at` | Email unique; avoid plaintext credentials. |
| `exchange_accounts` | `id`, `owner_user_id`, `exchange`, `account_ref`, `environment`, `margin_mode`, `status` | Distinguish real exchange account from simulated portfolio; protect account boundaries. |
| `exchange_connections` | `id`, `exchange_account_id`, `credential_secret_ref`, `permissions_json`, `connection_state`, `last_verified_at` | Store vault/encrypted secret **reference**, not API secret in DB; one connection may be read-only. |
| `strategies` | `id`, `slug`, `name` | `slug` unique. |
| `strategy_versions` | `id`, `strategy_id`, `version`, `requirements_json`, `management_policy_json`, `code_hash` | Unique `(strategy_id, version)`; immutable when referenced. |
| `strategy_presets` | `id`, `strategy_version_id`, `preset_name`, `parameters_json` | Validate compatible indicator/timeframe parameters. |
| `bots` | `id`, `exchange_account_id`, `name`, `canonical_market_id`, `strategy_version_id`, `execution_mode`, `operational_status`, `trading_state`, `config_version`, `version` | `trading_state` is a DB projection, not proof there is no exposure. Mode changes require IDLE **and** zero unresolved order/position records. |
| `bot_config_versions` | `id`, `bot_id`, `config_version`, `config_json`, `changed_by`, `created_at`, `reason` | Unique `(bot_id, config_version)`; append-only. |
| `coin_ownership` | `id`, `exchange_account_id`, `canonical_coin_key`, `bot_id`, `claimed_at`, `released_at` | Partial unique index on canonical coin for `released_at IS NULL`; owner retains claim while paused/open/unresolved. For the single-owner MVP choose explicit scope: all bots across its platform account, independent of PAPER/LIVE. |
| `market_instruments` | `id`, `exchange`, `market_type`, `market_symbol`, `base_asset`, `quote_asset`, `instrument_version`, `spec_json`, `valid_from` | Normalize spot vs linear perpetual; track change history for backtests. |
| `candles` | `market_instrument_id`, `timeframe`, `open_time`, `close_time`, `open`, `high`, `low`, `close`, `volume`, `is_closed`, `source`, `quality`, `observed_at` | Unique `(market_instrument_id,timeframe,open_time)`; OHLC and positive-time checks; never feed incomplete candle as complete. |
| `market_data_gaps` | `id`, `instrument_id`, `stream`, `gap_start`, `gap_end`, `status`, `recovery_evidence` | Index by instrument/time; unknown tick sequence remains explicitly uncertain. |
| `market_checkpoints` | `stream_key`, `instrument_id`, `last_event_id`, `last_event_time`, `last_committed_at`, `version` | Unique stream key; checkpoint advanced only with durable effects. |
| `strategy_evaluations` | `id`, `bot_id`, `strategy_version_id`, `config_version`, `trigger_type`, `trigger_event_key`, `decision`, `reason_code`, `indicators_snapshot`, `evaluated_at` | Unique `(bot_id, strategy_version_id, trigger_type, trigger_event_key)`; `NO_TRADE` is stored and creates no order intent. |
| `signals` | `id`, `evaluation_id`, `bot_id`, `side`, `entry_type`, `entry_price`, `stop_price`, `take_profit`, `expiry_at`, `status` | One selected actionable proposal per evaluation in MVP; snapshot strategy and prices. |
| `trade_lifecycles` | `id`, `bot_id`, `execution_scope_id`, `signal_id`, `state`, `started_at`, `closed_at`, `version` | Partial unique active-lifecycle index by bot; closing/uncertain remain active until resolved. |
| `order_intents` | `id`, `trade_lifecycle_id`, `bot_id`, `execution_scope_id`, `client_order_id`, `intent_type`, `side`, `quantity`, `price`, `status`, `risk_approval_id`, `created_at` | Unique `(execution_scope_id, client_order_id)`; intent is persisted before external order request. |
| `orders` | `id`, `order_intent_id`, `exchange_order_id`, `connection_id`, `state`, `requested_qty`, `filled_qty`, `remaining_qty`, `last_exchange_update_at` | Index state and intent; external order uniqueness scoped to connection; `UNKNOWN` requires reconciliation. |
| `order_fills` | `id`, `order_id`, `execution_id`, `event_time`, `observed_at`, `quantity`, `price`, `fee`, `fee_asset`, `liquidity_role` | Unique `(connection_id, execution_id)` for live, equivalent immutable simulated execution ID within simulator scope; no double posting. |
| `positions` | `id`, `trade_lifecycle_id`, `bot_id`, `execution_scope_id`, `side`, `open_qty`, `avg_entry_price`, `realized_net_pnl`, `state`, `version` | One active position projection per lifecycle; fills update quantity/weighted price atomically; projections rebuildable from fills/events. |
| `position_protection_versions` | `id`, `position_id`, `revision`, `desired_sl`, `confirmed_sl`, `desired_tp`, `confirmed_tp`, `trigger_reference`, `exchange_ack_ref`, `status`, `created_at` | Unique `(position_id,revision)`; distinguish desired, submitted and exchange-confirmed stops. |
| `bot_capital_accounts` | `id`, `bot_id`, `execution_scope_id`, `currency`, `funded_principal`, `target_allocation_percent`, `version` | Unique `(bot_id, execution_scope_id, currency)`; not a wallet or physically ring-fenced account. |
| `capital_ledger_entries` | `id`, `capital_account_id`, `entry_type`, `amount`, `currency`, `source_type`, `source_id`, `idempotency_key`, `posted_at` | Append-only; unique `(capital_account_id,idempotency_key)`; use signed entries and explicit fees/funding or net P&L **once**, never both for the same amount. |
| `capital_reservations` | `id`, `capital_account_id`, `order_intent_id`, `currency`, `reserved_amount`, `committed_amount`, `released_amount`, `status`, `version` | Unique per reservation purpose/intent, partial fills adjust reserved vs committed; unknown orders retain reserve. |
| `account_allocation_snapshots` | `id`, `exchange_account_id`, `equity`, `total_target_percent`, `total_actual_bot_equity`, `buffer`, `as_of` | Derived/reporting snapshot; not the sole authorization data for concurrent allocation. |
| `account_risk_snapshots` | `id`, `exchange_account_id`, `gross_notional`, `planned_loss`, `committed_margin`, `unrealized_pnl`, `as_of` | Monitoring projection, must be fresh before permission for new exposure. |
| `runtime_leases` | `bot_id`, `owner_instance_id`, `fencing_token`, `expires_at` | Primary key `bot_id`; token only increases on takeover; runtime checks ownership at execution boundary. |
| `reconciliation_runs` | `id`, `exchange_account_id`, `bot_id`, `started_at`, `ended_at`, `state`, `input_checkpoint`, `result_json` | Retain evidence, discrepancies, unresolved exposure and source timestamps. |
| `backtest_runs` / `backtest_events` | Run manifest and chronologically ordered events with dataset, code/strategy/risk/fill-model versions | Isolated simulator scope; immutable completed run; do not contaminate live ledgers. |
| `system_events` / `audit_events` | Actor, correlation/causation IDs, source object, reason, event/observation times, sanitized payload | Append-only critical history. |
| `system_incidents` / `incident_events` | Fingerprint, severity, status, affected bots, resolution evidence / history | Persist across restarts; acknowledging does not bypass freeze. |
| `notification_preferences` | Owner/bot, event/severity settings and Telegram destination ref | Critical alerts retain account-level routing. |
| `notification_outbox` | `id`, `event_id`, `destination_ref`, `message_type`, `status`, `next_attempt_at`, `dedupe_key`, `created_at` | Unique `(event_id,destination_ref,message_type)`; worker only; Telegram not part of critical execution. |
| `notification_attempts` | `id`, `outbox_id`, `attempt_no`, `attempted_at`, `response_status`, `error_sanitized` | Bounded retries, no credentials in errors. |

### 15.4 Essential PostgreSQL DDL patterns (illustrative, to adapt in migrations)

```sql
-- Coin exclusivity is global for the single-owner MVP by canonical key.
CREATE UNIQUE INDEX uq_active_coin_owner
  ON coin_ownership (canonical_coin_key)
  WHERE released_at IS NULL;

-- Only one unresolved trade lifecycle per bot.
CREATE UNIQUE INDEX uq_one_unresolved_lifecycle_per_bot
  ON trade_lifecycles (bot_id)
  WHERE state IN ('PENDING_ENTRY','OPEN','CLOSING','UNRESOLVED');

CREATE UNIQUE INDEX uq_strategy_eval_event
  ON strategy_evaluations
     (bot_id, strategy_version_id, trigger_type, trigger_event_key);

CREATE UNIQUE INDEX uq_intent_client_id
  ON order_intents (execution_scope_id, client_order_id);

CREATE UNIQUE INDEX uq_unique_live_fill
  ON order_fills (connection_id, execution_id)
  WHERE connection_id IS NOT NULL;

CREATE UNIQUE INDEX uq_unique_ledger_posting
  ON capital_ledger_entries (capital_account_id, idempotency_key);

CREATE UNIQUE INDEX uq_notification_delivery
  ON notification_outbox (event_id, destination_ref, message_type);

CREATE INDEX idx_unresolved_orders
  ON orders (state, last_exchange_update_at)
  WHERE state IN ('SUBMITTING','OPEN','PARTIALLY_FILLED','UNKNOWN','CANCEL_REQUESTED');

CREATE INDEX idx_candle_history
  ON candles (market_instrument_id, timeframe, open_time DESC);

CREATE INDEX idx_bot_evaluation_time
  ON strategy_evaluations (bot_id, evaluated_at DESC);

CREATE INDEX idx_outbox_due
  ON notification_outbox (next_attempt_at, created_at)
  WHERE status IN ('PENDING','RETRY');

-- Illustrative checks; migrate and validate against actual exchange precision.
ALTER TABLE candles ADD CONSTRAINT ck_candle_ohlc CHECK (
  close_time > open_time AND high >= low AND
  high >= GREATEST(open, close) AND low <= LEAST(open, close) AND
  volume >= 0 AND open > 0 AND close > 0
);
```

Adjust fill ID fields so paper and historical simulator fills have a unique `(simulation_scope_id, simulated_execution_id)` constraint too. The exact schema must enforce nonnegative quantities, consistent currencies, valid state enums, unique version identifiers, and referential integrity. Since PostgreSQL partial unique indexes only constrain rows matching the predicate, **active-lifecycle state changes must be transactional**; a position with uncertain residual exposure cannot be prematurely transitioned to `CLOSED`.

### 15.5 Transactions and concurrency boundaries

| Transaction / command | Must be atomic | External side effect and recovery behavior |
|---|---|---|
| Create/configure bot | Validate target allocations against locked account allocation row; insert bot and config version; claim unique coin atomically | No market orders; one failing coin claim rolls back creation. |
| Allocate/rebalance capital | Lock account allocation coordinator and relevant bot capital accounts; validate <=80% target total; append funding/transfer ledger entries; update projections | Never silently top up a losing bot; do not resize existing positions. |
| Approve entry | Lock bot state, account risk/collateral reservation coordinator and bot capital record; verify IDLE/ownership and risk limits; insert trade lifecycle, risk approval, reservation and durable order intent | **Commit before external submit**. Never hold DB lock while calling exchange or Telegram. |
| Submit entry | Acquire current runtime fencing authorization; set intent `SUBMITTING` durably; send using pre-persisted client ID | Timeout => `UNKNOWN`, retain reservation, reconcile before any retry. |
| Consume fill | Deduplicate execution ID; atomically update order executed qty, position qty/average, capital commitment and any fee postings; append event | Duplicate/reordered exchange events must not double-post or reopen position. |
| Cancel pending entry | Record cancel intent; request cancellation outside DB transaction; reconcile cancel acknowledgment and any racing fills | Release only verified **unfilled remainder**; partial exposure persists and stays protected. |
| Amend protective stop | Version desired stop; request amendment outside DB transaction; record acknowledged confirmed stop in new revision | A timeout does not prove stop moved; mark `UNKNOWN`/incident until reconciled. |
| Close position | Confirm exit fills, post net realized P&L exactly once, release committed margin, mark lifecycle closed **after** outstanding orders/protection reconciled | No new entry while close state unresolved. |
| Paper replay | Apply one market event and derived state changes idempotently; advance checkpoint in same transaction as durable effects | Replay uses historical timestamps; ambiguous intra-candle ordering remains `RECONCILIATION_UNCERTAIN`. |
| Runtime lease takeover | Lock lease row, increment fencing token, set new owner and expiration | Stale worker's state writes fail if token/version does not match. |
| Incident and notification | Persist domain event with business state; asynchronously project to notifications and send | Telegram worker never participates in strategy/risk/order/position command transaction via RPC. |

For concurrent capital allocation, one account-level coordination row (or PostgreSQL advisory transaction lock keyed by account) protects allocation and margin capacity checks **across bots**, not just an in-memory bot mutex. Choose deterministic lock order (account → bot → trade/order) to reduce deadlocks. Where a transaction fails serialization/version checks, retry boundedly with fresh validation. Never retry an external exchange order request solely because a DB transaction was retried.

Do **not** wrap network calls in PostgreSQL transactions. For multi-step external workflows use durable intents/state machines and a reconciler (transactional outbox / saga style), not an imaginary distributed atomic transaction across PostgreSQL and an exchange.

### 15.6 Ledger model and reconciliation invariants

A bot's ledger represents its **attributed economic capital**, not the initial margin currently locked by the exchange. Maintain separate notions:

```text
RealizedBotCapital = FundedPrincipal + Sum(verified capital transfers) + Sum(net realized P&L postings)
MarkToMarketBotEquity = RealizedBotCapital + attributable unrealized P&L
AvailableCommitmentCapacity = risk-eligible equity - outstanding reservations - committed margin - policy buffers
```

Choose **one** posting convention: (A) net realized P&L per closed trade with fees and funding included or (B) gross trade P&L plus separate fee and funding entries. The system MUST NOT post net P&L *and* separately subtract the same fees/funding. For auditability option B is preferable, with a derived net P&L view and unique source posting IDs. All adjustments need actor, reason and source references.

Example invariant: $20 funded, $2 margin committed, then a net loss of $0.50 after exit ⇒ realized bot capital is **$19.50**. Releasing margin makes funds available; it is **not** a $2 capital credit. Bot B remains unchanged. Account-wide exchange equity, sums of funded/attributed bot equity, unallocated funds, manual positions and fees must reconcile; disparities suspend new allocations and live entries rather than silently moving money between ledgers.

Use account equity snapshots for dynamic allocation *envelope* checks; a 20% target is not a promise to refill a bot after it loses. Preserve the 20% unallocated target buffer, while recognizing shared cross-margin losses can impair that buffer physically.

### 15.7 Referential and domain integrity rules

1. **No duplicate ownership:** exactly one active owner for a canonical coin across all bots in the MVP. Releasing assignment requires authoritative proof of zero associated pending/live/paper exposure.
2. **No phantom IDLE:** execution-mode changes PAPER↔LIVE are forbidden unless trading state is `IDLE`, all relevant order intents are terminal, positions have no residual quantity, capital reservations are reconciled, and no unresolved execution incidents exist.
3. **No cross-environment leakage:** PAPER, BACKTEST and LIVE ledger/order/fill records are scoped independently. Switching modes never imports paper gains into live principal.
4. **No double entry:** only one unresolved trade lifecycle per bot, enforced by the partial index; runtime serialized processing is a further safeguard.
5. **No duplicate fill impact:** one execution identifier creates at most one fill and one associated set of accounting postings.
6. **No undocumented risk bypass:** every new order intent references immutable config version, strategy version, risk approval and capital reservation.
7. **No unseen stop amendment:** desired stop and confirmed stop are distinct; a missing exchange acknowledgment cannot count as confirmed protection.
8. **No prematurely released margin:** until an order is authoritatively confirmed cancelled/closed and the executed remainder reconciled, keep appropriate reservations and commitments.
9. **No duplicate candle assessment:** each strategy trigger is uniquely keyed; old/same candle events cannot generate multiple order intents.
10. **No trading dependency on notifications:** Telegram delivery may fail for hours without affecting order handling. Keep audit and incident evidence durable.

### 15.8 Data isolation, lifecycle, and indexes

- Index operational hot paths: latest candles by `(market_instrument_id, timeframe, open_time DESC)`; unresolved orders by state; active lifecycle by bot; checkpoint by stream; latest strategy evaluations by bot/time; capital postings by bot account/time; active incidents by severity/status; due notifications by status/retry time.
- Partition very large candle or execution-event tables only after measuring volume; begin with appropriate btree indexes and batch insertion. Archive tick trades/backtest datasets to Parquet/object storage instead of unbounded per-tick SQL inserts.
- Reference immutable strategy/config/risk/execution-model versions from evaluations and orders. Backtests additionally pin input data snapshot and code revision.
- Deny DELETE/UPDATE on financial ledger entries in normal application roles; corrections are reversing entries with an audit reason. Limit credential and personally identifying fields to authorized services.
- Migration strategy: additive schema first, backfill, validate indexes/constraints, migrate readers/writers, only then drop deprecated fields. Test migrations with existing open position/order states and previous ledger history.
- Operational backups must include a point-in-time recovery strategy, restore rehearsal and consistency checks after restore. Never resume live entry generation after restoring an old snapshot until external exchange reconciliation completes.

### 15.9 Testable database acceptance criteria

- [ ] Two concurrent bots cannot claim the same canonical coin (including different exchange symbol spellings normalized to the same key).
- [ ] Two simultaneous allocations that separately look permissible cannot jointly exceed the 80% ceiling.
- [ ] Two concurrent entry proposals for one bot create at most one unresolved lifecycle/order intent.
- [ ] Two bots competing for shared account collateral cannot both reserve the same available capacity.
- [ ] A duplicate execution callback does not double-increase filled quantity, double-charge fees, or double-credit/debit the bot capital ledger.
- [ ] A partial fill followed by cancel preserves the filled position and releases only the confirmed unfilled reservation.
- [ ] $20 bot funding minus $0.50 **net** realized loss equals $19.50 after margin release; no top-up from unallocated funds.
- [ ] PAPER→LIVE change is refused if any pending order, unknown submission, open position, unsettled reservation, or unresolved exposure exists even when a stale status field says IDLE.
- [ ] A rejected/sluggish Telegram call does not hold a capital reservation lock, delay an exchange order, or prevent TP/SL processing.
- [ ] Crash between durable `SUBMITTING` state and exchange response recovers via client order ID, without placing a duplicate order.
- [ ] Stale runtime owner cannot commit a new order/state change after fencing token turnover.
- [ ] Restored database snapshot never authorizes live new entries without exchange-state reconciliation.
- [ ] Historical replay duplicates and gaps do not mutate terminal fills or fabricate event ordering.
- [ ] No unversioned financial adjustment or modification of prior immutable strategy/evaluation context is permitted.

### 15.10 Implementation phases and unresolved precision choices

**Phase DB-1:** migrations for identity/account/bots/strategies/canonical ownership/market candles + seed queries; basic model constraints. **Phase DB-2:** trade lifecycles, durable order intents, simulated orders/fills, position protection, bot capital ledgers/reservations + atomic transaction APIs. **Phase DB-3:** reconciliation/checkpoints, runtime fencing, backtest isolation, analytics snapshots, incidents/audit and independent Telegram outbox. **Phase DB-4 (future-gated):** exchange connectivity, authoritative live orders/fills, margin-mode reconciliation and security review.

Implementation choices still to document explicitly: exact `NUMERIC` precision per instrument; ledger posting convention (gross plus separate costs recommended); treatment of late/adjusted exchange fee or funding postings; scope of `canonical_coin_key` (for MVP single owner globally, using canonical base asset); whether paper bots share a synthetic portfolio or have independent simulation scopes linked to an account-equity baseline; and the precise account/subaccount equity source for the 80% envelope. Do not silently substitute assumptions for user-confirmed requirements. Keep all live entry actions disabled pending independent operational review.

## 16. Acceptance criteria and test scenarios

### 16.1 Core strategy behavior

- [ ] Starting a 15m strategy at 10:07 seeds enough complete 15m and optional 1h candles and does **not** evaluate entry on the incomplete 10:00–10:15 candle.
- [ ] The strategy receives the last fully closed 1h candle, not its partial ongoing hour.
- [ ] `NO_TRADE` is stored with reason; no risk reservation or order is created.
- [ ] Two identical candle-close events create exactly one evaluation/entry proposal.
- [ ] Bot `IN_TRADE` receives prices and strategy exit reassessments but generates zero new entry proposals.
- [ ] Pending limit entry expires on time or cancels earlier on validated strategy invalidation; race with fill is reconciled.

### 16.2 Capital and allocation

- [ ] $100 account allows at most $80 target allocations; an attempted increase to $81 is rejected.
- [ ] Bot A funds $20, closes with -$0.50 **net**, and now has $19.50 realized ledger equity; Bot B and unallocated funds not automatically replenishing A.
- [ ] Reservations are counted once across concurrent bots; overclaim fails atomically.
- [ ] Margin released on close does not get misclassified as realized profit.
- [ ] Minimum-order rejection leaves no unconfirmed order or orphan reservation; alert eligible for Telegram dedupe.
- [ ] Risk profiles expose max leverage 5x/10x/15x and choose minimum admissible leverage for an already risk-sized position.
- [ ] If account equity falls below allocation target envelope, block additional commitments and alert without auto-liquidation/rebalance.

### 16.3 Orders/positions/recovery

- [ ] A $20 requested order with $8 filled maintains an $8 protected position and tracks/cancels $12 unfilled remainder according to policy.
- [ ] Duplicate fill events and submit retries do not double debit/credit ledgers or open duplicate positions.
- [ ] Submission timeout enters UNKNOWN; queries/reconciliation run before any retry.
- [ ] Break-even stop amendment remains `REQUESTED` until confirmed; failed amendment never appears as effective.
- [ ] With outage between price events, replay reconstructs entry and TP/SL sequence where trade-level history exists.
- [ ] If both TP and SL were crossed in an unknown historical interval, simulator returns `RECONCILIATION_UNCERTAIN` rather than assuming favorable order.
- [ ] Live restart restores exchange-confirmed state rather than manufacturing missed stop amendments.
- [ ] Bot cannot switch PAPER↔LIVE in `PENDING_ENTRY`, `IN_TRADE`, `CLOSING`, `UNRESOLVED`, or with outstanding orders; clean `IDLE` only.
- [ ] Two bots cannot claim BTC even if their symbol format, strategies or execution modes differ.

### 16.4 Validation and operations

- [ ] Backtest output reproducible from data/config/code/version manifest; indicator warmup excluded from performance.
- [ ] Backtest reports NO_TRADE and risk rejection counts separately from filled trades.
- [ ] Backtest uses conservative/explicit fill assumptions; does not use future candles in current decisions.
- [ ] Long backtests cannot starve live price monitoring in the event loop.
- [ ] Bot pause preserves protection; Protect & Freeze blocks new entries and preserves/monitors existing exposure.
- [ ] Telegram indefinitely hangs, returns 429/5xx, or worker crashes; strategy/risk/OMS/fill/protective actions proceed without awaiting notification and outbox retries asynchronously.
- [ ] At least 100 NO_TRADE records create no per-evaluation Telegram flood.
- [ ] One shared exchange feed outage affecting multiple bots creates a grouped incident with stable fingerprint.
- [ ] Critical unverified live stop triggers Protect & Freeze and a durable incident even while Telegram is unavailable.
- [ ] Incident acknowledgment never implicitly clears entry suspension; resolution requires verified recovery.
- [ ] Notification backlog and retry attempts persist and are bounded; delayed Telegram acknowledgment does not imply exactly-once delivery.
- [ ] Critical actions, security changes, risk suspensions and emergency commands recorded in audit trail.

## 17. Delivery roadmap for Codex

**The authoritative, confirmed eight-phase implementation sequence, dependencies, quality gates, and Codex completion protocol are in Section 23 (Architecture Decision 18).** This section supersedes the earlier ten-item sketch. The previous DB-1 through DB-4 sequence in Section 15.10 is a *database-specific dependency breakdown* inside the eight-phase plan, not an alternative product roadmap. In particular, a production LIVE adapter is **not** part of the paper-first completion milestone; its implementation and authorization remain separately gated.

## 18. Engineering guidance / suggested structure

```text
apps/
  api/                 # Express.js bot controls, portfolio, backtest endpoints
  web/                 # optional React/Vite dashboard
  runtime/             # subscriptions, event dispatcher, bot supervisor
  worker/              # history backfill, tests, reports, Telegram outbox
packages/
  domain/              # immutable domain types/state machines/invariants
  strategies/          # interfaces, TA-Lib adapters, concrete strategies
  market-data/         # exchange public adapters, candles, trades, gaps
  risk/                # account/bot/trade validation and capital ledger
  oms/                 # order intent, state, partial fills and protection
  execution-paper/     # deterministic simulator
  execution-live/      # future-gated, secure exchange adapters
  replay/              # deterministic historical sequencing
  backtesting/         # test runner/metrics/validation
  persistence/         # DB schema/migrations/repositories
  observability/        # health, structured events, incident/metrics projection
  notifications/       # durable outbox, preferences, independent Telegram worker
```

This is a suggestion, not a mandate to introduce microservices. Prefer clean boundaries and a manageable repo. Use interfaces, schema validation (e.g. Zod), DB migrations, explicit env files and redacted logs. Use Drizzle ORM with PostgreSQL during scaffold; no need to replicate a prior AI project's stack just because it existed.

## 19. Open implementation choices Codex must not silently invent

The following were **not finalized** in discussion and need documented implementation defaults/test plans before representing the design as production-ready:

1. Concrete entry/exit indicator rules, parameter presets, symbol universe, and strategy-specific confirmation behavior (no guaranteed profitable defaults).
2. Which paper execution price (last/bid/ask/depth) is used in each instrument, latency and slippage model, and partial-fill assumptions.
3. Exact rule for simultaneous strategy time-close and tick events, including exchange event timestamp granularity and deterministic tie-breaking.
4. Whether target allocation percentages are configured against all exchange equity, equity in a particular subaccount, or a user-designated tradable portfolio, and how deposits, withdrawals, and transfers are attributed. Preserve the confirmed independent P&L ledger either way.
5. Funding/payment timing for derivatives, historical leverage-tier changes, and margin mode. Treat historical unavailable instrument specifications as backtest limitations.
6. Exact Telegram alert grouping/cooldown/escalation windows, retention periods, and whether signal-only mode participates in hypothetical capital allocation (by default, don't reserve real/simulated margin for signal-only notifications).
7. Live system activation policy, manual intervention procedure for unprotected exposure, and production closeout authorization. Do not turn on LIVE until reviewed and tested.
8. Validation sample sizes and numerical acceptance gates: select them before seeing a test result and document any resulting changes.
9. Data retention capacity, archive source, backtest dataset licenses, historical order-book availability, and scheduling of archive compaction.
10. Multi-user support: initial design assumes a private/single-owner account; if expanded, require tenancy isolation and authorization model changes.

## 20. Definition of done

The MVP is complete when a user can configure two distinct paper bots on two distinct coins with separate strategies and capital allocations; both warm up from complete historical candles, return NO_TRADE or qualified signals only on valid evaluation triggers, manage independent pending/open/closing lifecycles from live public data, enforce stop/risk/capital constraints, withstand restarts and data gaps without duplicate simulated fills, compound individual net P&L correctly, run reproducible historical backtests, display decisions, health, incidents and performance, and deliver meaningful deduplicated Telegram notifications asynchronously without affecting trading. The system must have automated tests for allocation, ownership, replay ambiguity, partial fills, stop adjustment acknowledgement, and state transitions.

Live-trading readiness is **not** part of that default MVP definition of done. Its architecture is specified to avoid future redesign; enabling it requires separate safety, security, reconciliation and exchange-integration review.


## 21. Decision 16 — Deployment, environments and release management (CONFIRMED)

### 21.1 Nonnegotiable technology and deployment choices

- **Backend HTTP framework: Express.js**, not Fastify. Implement REST routes, authentication, input validation, error middleware, and health/readiness endpoints using Express.js and TypeScript. The dashboard may use authenticated WebSocket connections supported by the same Node.js deployment.
- **Do not use Docker or Docker Compose.** Do not generate a `Dockerfile`, compose manifest, container-first deployment instructions, or require Docker for running PostgreSQL or tests. Develop and deploy by installing Node.js, application dependencies, and required infrastructure natively or via managed services.
- Maintain one repository and shared TypeScript packages (modular monolith), but run the **Express API**, **trading runtime**, and **background worker** as separate OS processes. A failure or restart of the API must not automatically restart the trading runtime. CPU-heavy backtests should execute in isolated worker processes or worker threads with resource limits.
- On a Linux host, prefer **systemd service units** with restart policies and dependency ordering; PM2 is an acceptable alternative if chosen consistently. Do not run critical runtime logic as a short-lived serverless function.
- **PostgreSQL** is authoritative; **Redis/BullMQ remain optional**, only if justified for job execution. Existing persisted outbox/ledger/event mechanisms must work without mandatory Redis.

### 21.2 Environment isolation

| Environment | Database/secrets | Permitted execution | Goal |
|---|---|---|---|
| Local development | Dedicated local DB and test credentials | Signal-only and paper simulation | Feature development, unit/integration tests |
| Staging | Separate DB and isolated secrets; exchange testnet only if later integrated | Paper, simulated failures, testnet behind explicit gate | Integration, deployment/restart rehearsals |
| Production | Separate DB, dedicated encrypted secrets | Paper by default; LIVE separately reviewed/authorized | Continuous operation |

Never share staging and production bot capital ledgers, exchange credentials, runtime leases, or order namespaces. Explicit environment identifiers must scope exchange connections and records.

### 21.3 Native process/service boundaries

```text
HTTPS reverse proxy (e.g. Nginx/Caddy)
  └── Express.js API + dashboard update endpoint      [separate OS process]

Trading runtime supervisor                            [separate OS process]
  ├── public market-data subscriptions + candle engine
  ├── per-bot state machines, strategy evaluation
  └── risk, OMS orchestration, position monitoring

Background worker                                     [separate OS process]
  ├── historical data seeding/backfill
  ├── backtesting/report generation (isolated CPU jobs)
  └── PostgreSQL outbox → Telegram (never awaited by OMS)

PostgreSQL; optional Redis; optional managed secrets/monitoring
```

Use explicit process entrypoints, independently configured health checks, environment validation, structured logs, and restart policies. An API restart should not affect position monitoring. No part of order execution may await Telegram.

### 21.4 Release and deployment sequencing

1. **Build and test candidate release**: TypeScript check, lint, unit tests, SQL migration tests, market-data and order-state integration tests, recovery/fault-injection suites. CI (e.g. GitHub Actions) can run native Node/PostgreSQL or managed test databases; no Docker requirement.
2. **Staging smoke test**: verify readiness, restored paper positions, candle warmup, stop rules, duplicate-event protection, database migration compatibility, and notification isolation.
3. **Back up and check PostgreSQL** before migrations. Use backward-compatible expand/migrate/contract schema changes. Never apply destructive changes while active code still depends on the old schema. Database rollback is a separate plan from code rollback.
4. **Freeze new entries** for the affected trading runtime. Finish/checkpoint in-flight durable transitions, record last processed market events, and preserve outstanding orders, positions and reservations.
5. **Confirm exposure protection before runtime handoff**, with LIVE positions requiring verified exchange-side protection or an authorized operator-supervised protective procedure. A failed protection check blocks the handoff, except under documented emergency incident policy.
6. **Stop the old trading runtime under process supervisor control** and release or expire its ownership lease; start the new runtime with a newer fencing token. Never permit overlapping active owners to emit orders.
7. **Reconcile orders/positions, backfill gaps and reseed indicators** on the replacement runtime. Do not generate new entries until exchange/account/market readiness and capital reconciliation are confirmed.
8. **Resume eligible bots** after readiness succeeds; otherwise remain in `RECONCILING` / `PROTECT_AND_FREEZE`, raise an incident and preserve protective monitoring where available.

A controlled short gap may occur; do not claim zero-downtime position monitoring merely because a process supervisor restarts a process. For paper trades, replay available history. For LIVE, actual exchange executions and protective orders remain authoritative.

### 21.5 Operational readiness and rollback

- API health and trading-runtime readiness are **separate**. `liveness` answers whether the process is running; `readiness` answers whether new entry generation is allowed. Existing-position protection has its own health indicators.
- Restart-on-crash must not automatically clear risk suspensions or incidents. Durable persisted state wins over process memory.
- Recovery from host reboot must acquire exclusive leases, restore unresolved exposure, reconcile exchange state, validate candle coverage and reservations, then enable new entries.
- Run dedicated backtest workers with bounded CPU/memory concurrency; resource contention must not starve price-event processing.
- An application rollback must use a database-compatible release or a preplanned migration procedure. Never roll back financial ledger records to erase valid fills or P&L.
- Native deployment steps should be documented (system packages, Node version, `.env` secrets, PostgreSQL permissions/migrations, Nginx/Caddy, systemd/PM2, log rotation, backup/restore and operator runbook). No Docker-based alternatives should be presented as necessary setup.

### 21.6 Deployment acceptance criteria

- [ ] Express.js routes and middleware implement the API contract; no Fastify dependency.
- [ ] Local setup, staging and production instructions run without Docker or Compose.
- [ ] Restarting Express API leaves trading runtime and open paper-position monitoring uninterrupted.
- [ ] Background CPU-heavy backtesting and stuck Telegram delivery do not block market event handling, risk evaluation, or OMS.
- [ ] Restarting trading runtime reconciles unresolved orders and positions without duplicate fills or orders before enabling entries.
- [ ] Old/new runtime overlap cannot acquire simultaneous write/execution authority for the same bot.
- [ ] Staging is isolated from production databases and secrets; production LIVE execution remains separately gated.
- [ ] Failed migration/readiness/protection checks block resumption and create a durable incident.
- [ ] Host reboot and supervisor recovery restore persisted bot/trading states; protected exposure is not abandoned.

**Confirmed scope boundary:** Deployment architecture is approved with **Express.js and no Docker**. Provider choice (VPS brand, managed PostgreSQL vendor, systemd versus PM2) may be selected during implementation without altering these invariants.

---

## 22. Architecture Decision 17 — Testing, Simulation & Quality Assurance (CONFIRMED)

### 22.1 Purpose and test philosophy

The system must prove **software correctness** independently from **strategy profitability**. A favorable historical return does not establish that the order manager, virtual capital ledger, data replay, or protective-position logic is safe or correct. Tests must run without production trading credentials, must not submit production exchange orders, and must be deterministic where possible.

**Test layers:**

1. **Unit tests:** pure strategy rules (including `NO_TRADE`), TA-Lib indicator input/warmup guards, size/risk calculations, pending-entry expiry, position state transitions, break-even/trailing-stop policy and data normalization.
2. **Integration tests:** Express.js API authorization/validation, PostgreSQL + Drizzle constraints and transactions, bot/coin ownership, capital ledger, reservation-to-order intent, fills, protection-state reconciliation, outbox publication.
3. **Market simulation tests:** controlled historical candle/market-trade replay, simulated market and limit orders, nonfills/partial fills, stop/TP ordering, slippage and fees, re-evaluation and strategy-specific exits.
4. **Failure and recovery tests:** dropped data streams, incomplete backfill, restart during order submission or amendment, duplicate/out-of-order events, concurrent workers, stale fencing tokens, database outage and failed notification delivery.

Use **Vitest** as the primary TypeScript runner; use an **isolated real PostgreSQL test database** for transaction/constraint tests, rather than replacing transactional behavior entirely with mocks. Test database provisioning must not require Docker. Use a controllable fake exchange adapter for automated execution tests and an injectable clock to advance simulation time.

### 22.2 Deterministic test harness and fixtures

Build `FakeMarketFeed`, `FakeExchangeAdapter`, `VirtualClock`, and reusable historical-event fixtures. Each fake must support configured latency, rejection, partial fills, missing ticks, stale snapshots, reconnection, duplicate events and unknown order outcomes. Replay events in their actual available order, with separate source/event timestamps and processing timestamps. Never expose future bars or post-signal events to an earlier strategy decision. Make randomized simulation seeds explicit and persist them in test artifacts.

**Canonical fixture groups:**

- Candle seeding: 500 history bars as a proposed default, insufficient warmup, incomplete latest bar, timeframe-specific gaps, 15m trigger with most recently *closed* 1h confirmation bar.
- Decision selectivity: consecutive `NO_TRADE` outcomes, valid LONG/SHORT proposals, no new entry evaluation while `PENDING_ENTRY` or `IN_TRADE`.
- Orders: full fill, no fill, partial fill, cancel-after-partial, late fill during cancellation, submission timeout with eventual fill, duplicated exchange execution ID.
- Position management: ordinary TP/SL, break-even then reversal, trailing-stop tightening, strategy invalidation, sideways time exit, competing exit decisions and confirmation lag for stop amendment.
- Recovery: disconnect while entry/TP/SL crosses, missing trade-history segment, ambiguous same-candle TP/SL ordering, new events buffered during backfill, crash/restart during order submission, missed strategy candle close.
- Concurrent bots: independent virtual accounts, same-coin exclusivity, simultaneous reservations, aggregate allocation and exposure ceilings, stale runtime lease.

If a historical sequence does not establish whether TP or SL triggered first, do not assert a fabricated winning outcome: report `RECONCILIATION_UNCERTAIN`, or compare clearly labeled alternate simulation assumptions.

### 22.3 Financial and risk invariants: release-blocking

Run example-based and **property-based tests** over sequences of deposits/explicit allocations, order reservations, partial fills, releases, fees, funding, realized P&L and authorized transfers.

Required properties:

- Initial Bot A virtual equity $20 with a **net** realized loss of $0.50 results in **$19.50**; Bot B equity does not change. The original percentage allocation does not silently replenish Bot A.
- Margin **reservation** or **commitment** reduces available capacity but **does not** itself reduce bot equity. Releasing margin restores capacity; it is not counted as a profit or second credit.
- A confirmed duplicate fill, ledger posting or state transition is **idempotent**: no duplicate P&L, fee, reservation release or position increase.
- Aggregate target allocations cannot exceed **80%** of the relevant account-equity baseline at funding/rebalance authorization. Existing bot positions are not automatically resized when account equity changes; excess target commitments must prevent new funding/entries until reconciled.
- Account and bot available-to-reserve capacity never becomes negative through an **approved new reservation**; already-open exposures may still cause negative economic equity and must be handled by risk/incident rules, not hidden by the test invariant.
- Risk-profile maximum leverage caps remain **5× Conservative, 10× Moderate, 15× Aggressive**; position sizing never increases merely because more leverage is available. Instrument minimums cannot override planned-loss or margin caps.
- One assigned coin belongs to at most one active bot across PAPER/LIVE modes for MVP; each bot has at most one unresolved trade lifecycle.
- PAPER ↔ LIVE transition is rejected unless bot is genuinely `IDLE` with no unresolved orders, positions or reservations; PAPER and LIVE ledger histories never commingle.
- Risk suspensions and Protect & Freeze block new entries without discarding or falsifying existing exposure.

For financial calculations, assert precise decimal behavior and tolerance at explicit rounding boundaries; do not use approximate JavaScript floating-point equality for monetary ledger values.

### 22.4 Failure injection matrix

| Injected event | Required result |
|---|---|
| Public WebSocket disconnect and restart | No new affected entries before backfill/readiness; existing simulation replayed where evidence exists |
| Stop hit while application is disconnected | PAPER reconstructs stop only with sufficient historical evidence; LIVE relies on actual exchange executions |
| Both TP and SL crossed, order unknown | Preserve explicit uncertainty, never silently mark a winner |
| Crash immediately after order accepted | Reconcile by durable order intent/client ID; no blind resubmission |
| Partial fill followed by cancellation | Protect and account for filled quantity; release only unfilled remainder |
| Duplicate order/fill events | One economic effect per unique execution |
| Two owners during deployment | Stale owner/fencing token cannot commit decisions or create new orders |
| PostgreSQL outage | New decisions requiring durable state fail closed; raise incident |
| Unknown exchange-side protective stop | Critical incident + Protect & Freeze; don't report unconfirmed protection as active |
| Telegram API stalls for 30 seconds | Strategy evaluation, risk checks, OMS and position monitoring continue independently |
| Telegram outage and retry | Durable notification outbox retries without duplicate domain events or blocked fills |
| Backtest high CPU | Worker isolation/resource bounds prevent trading runtime starvation |

### 22.5 Golden scenarios and regression suites

Maintain immutable input fixtures plus expected event sequences (`CandleClosed → StrategyEvaluation → RiskDecision → OrderIntent → Fill → PositionTransition → LedgerPosting`). For every important strategy and position-management policy, include successful trades, skipped signals and adverse results. A change to indicator rules, candle timeframe, stop management, sizing, execution model or risk limits must explicitly regenerate/review the affected golden outcomes and re-run historical regression backtests. Record software, strategy, risk-policy and fill-model versions used to produce the result.

Do not treat an updated golden file as proof the new behavior is correct: review intentional changes against strategy contracts and accounting invariants.

### 22.6 Test organization (suggested)

```text
 tests/
   unit/
     strategies/ indicators/ risk/ position-manager/
   integration/
     api/ database/ capital-ledger/ orders/
   simulation/
     market-replay/ paper-execution/ partial-fills/ stop-management/
   resilience/
     reconnect/ process-crash/ duplicate-events/ exchange-outages/
   fixtures/
     candles/ market-events/ exchange-responses/ golden-scenarios/
```

Use separate test settings, databases and environment secrets. Automated CI never imports live API credentials; tests and staging do not have permission to submit production orders.

### 22.7 CI and release quality gates

| Changed subsystem | Minimum required checks |
|---|---|
| Strategy/indicator | Unit tests, historical regression scenarios, no-look-ahead tests |
| Position Manager | Entry/exit lifecycle, stop tightening, timing and replay tests |
| Risk/capital | Property-based ledger invariants, allocation cap, concurrent reservations |
| Drizzle schema/migrations | Real PostgreSQL migration, constraints, transaction and restore checks |
| OMS/exchange adapter | Duplicate/partial fills, timeouts, unknown order reconciliation, protection-state tests |
| Market-data/recovery | Closed-candle alignment, gap replay, stale data and uncertainty tests |
| Runtime/deployment | Restart, fencing ownership, process isolation and readiness tests |
| Telegram/observability | 30s timeout isolation, outbox retry, deduplication and incident logging |

**Release blockers:** any failing capital-accounting invariant, duplicate-order/fill regression, protective-order reconciliation test, exclusive coin ownership violation, or failure to prevent new entries during unknown account state. UI-only passing tests cannot waive these blockers.

### 22.8 Acceptance criteria

- [ ] Vitest runs all pure strategy/risk/state tests deterministically.
- [ ] Integration tests exercise real PostgreSQL/Drizzle constraints without Docker.
- [ ] Fake exchange and virtual clock cover full/partial/no fill and asynchronous failure cases.
- [ ] A $20 → $19.50 realized-loss scenario remains correct through restart and reconciliation.
- [ ] Duplicate candle, execution and notification events do not create duplicate economic effects.
- [ ] PAPER reconnect replay distinguishes confirmed from uncertain outcomes; LIVE test uses authoritative fake-exchange records.
- [ ] Two bots cannot reserve the same coin or exceed account limits concurrently.
- [ ] PAPER/LIVE switching is refused unless bot is genuinely IDLE.
- [ ] A delayed or unavailable Telegram endpoint never blocks position management or order-state processing.
- [ ] CPU-heavy backtests cannot starve the runtime.
- [ ] Release CI applies subsystem-specific tests and rejects critical financial/execution failures.

**Decision status: CONFIRMED.** All values labeled provisional elsewhere in this PRD remain provisional; Decision 17 confirms the testing methodology and release gates, not guaranteed strategy performance or authorization to activate LIVE mode.


## 23. Architecture Decision 18 — Implementation Phasing & Module Dependencies (CONFIRMED)

**Decision status: CONFIRMED (2026-10-19).** Implement in **eight sequential, independently verifiable phases**, with the first complete product milestone being a **fully working PAPER trading platform**. Authenticated production LIVE order execution is an **additional, separately authorized future milestone**, not implicitly part of Phase 8. Use **Node.js, TypeScript, Express.js, React/Vite, PostgreSQL, Drizzle, TA-Lib, npm workspaces, and no Docker**. Start with a modular monolith; the API, trading runtime, and background worker are independently supervised native processes.

### 23.1 Phase-gate contract for Codex

Each phase must deliver: (1) working source code with correct module boundaries; (2) all applicable migrations and fixtures; (3) unit/integration/golden-scenario tests; (4) concise setup and run instructions; (5) a completion report citing commands run, test results, acceptance criteria, known limitations, and changed interfaces. Do not claim a phase complete merely because files compile, test stubs exist, or an endpoint returns a placeholder. Do not silently skip a dependency. If a dependency is not ready, use a **strict, testable fake adapter** behind the same typed interface rather than introducing an unverified live side effect. Keep any financial/test fixtures clearly labeled illustrative.

**Shared architectural contracts established early:** `MarketDataProvider`, `CandleRepository`, `StrategyDefinition`, `PositionManager`, `RiskEngine`, `CapitalLedger`, `ExecutionAdapter`, `OrderManagementService`, `BotRuntime`, `EventRecorder`, `Clock`. Prefer injected dependencies and no direct exchange access in strategy modules. Maintain strict persistence and no-look-ahead requirements throughout.

### 23.2 Phase 1 — Foundation & Database

**Depends on:** none. **Deliverables:** npm-workspaces monorepo; `apps/api` Express app with validated configuration, structured errors, authentication/authorization and health endpoints; `apps/runtime` and `apps/worker` executable scaffolds with isolated process lifecycles; `apps/web` React/Vite scaffold; `packages/core`, `packages/database`, and test harness; Drizzle migrations for exchange accounts, bot identities, strategy registry/configuration versions, canonical symbol ownership, and audit identifiers. Create a safe PAPER-only default configuration. Begin structured logs with correlation IDs. Define non-negotiable financial and execution constraints in migration design even where later tables are phased in.

**Gate:** create, fetch and version a stopped bot; exclusive coin ownership rejects conflicting assignments even under concurrent requests; migrations run on a real PostgreSQL database without Docker; restarting API preserves bot config; API restart does not require runtime restart; test suite and TypeScript checks pass.

### 23.3 Phase 2 — Market Data Infrastructure

**Depends on:** Phase 1, shared types and persistence. **Deliverables:** public market-data provider abstraction (direct API and/or optional CCXT); normalized exchange/market/symbol IDs; WebSocket market-price feed; historical OHLCV fetching, pagination and per-timeframe coverage; closed-candle validation and persistence; shared subscriptions and price dispatcher; indicator input readiness and TA-Lib integration; strategy-requested initial historical seeding (500 closed candles as an illustrative default, with actual amount derived from indicator requirements); gap detection, backfill, freshness/health tracking and checkpoints. Historical trade/event retrieval capabilities should be defined for Phase 6.

**Gate:** independent 5m and 1h series are complete and correctly aligned; incomplete candles never enter closed-candle analysis; shared feeds do not duplicate per-bot subscriptions; a gap can be detected and repaired; a cold-start strategy can obtain adequate history without future data; degraded data blocks new signals while preserving any existing protective process.

### 23.4 Phase 3 — Strategy Engine

**Depends on:** Phase 2 readiness, TA-Lib, clock/test fixtures. **Deliverables:** versioned `StrategyDefinition` contract with strategy-owned primary timeframe, optional confirmation frames, technical indicator requirements, warm-up, trigger type (candle close or event), entry, pending-invalidation and position-assessment methods. Implement deterministic **Trend Following** and **Mean Reversion** research strategies; explicit `NO_TRADE` reason codes and immutable evaluation snapshots. Support event-driven strategy interface without prematurely implementing real arbitrage execution. Keep all evaluations side-effect free and prevent indicator data timestamped after the evaluation time.

**Gate:** known historical fixtures yield reproducible LONG, SHORT and NO_TRADE results; the correct last **closed** higher-timeframe candle is used; duplicate candle events do not create duplicate evaluations; strategies cannot place orders or call authenticated exchange endpoints.

### 23.5 Phase 4 — Bot Runtime & Position Management

**Depends on:** Phase 3 strategy contract, data events and durable bot state. **Deliverables:** per-bot operational and trading state machines, event dispatcher, per-bot serialized decision handling, startup/warm-up, pause/resume/stop behavior, idempotent evaluation keys, persistent checkpoints and restart restoration. Implement pending-entry time expiry plus strategy invalidation; price-event monitoring, TP/SL thresholds, BE/trailing-stop policy support, early exit/sideways/time exit and unambiguous transition arbitration. Build this **against a fake execution adapter**: it must not require live exchange credentials or a real paper fill engine yet. Every confirmed or pending action is represented by an explicit contract, not assumed fulfilled.

**Gate:** a deterministic scenario runs IDLE → PENDING_ENTRY → IN_TRADE → CLOSING → IDLE (or cancelled/expired variants); an IN_TRADE bot never generates a new entry but continues candle-close position assessment and tick monitoring; restart restores unresolved state; simultaneous TP/SL and candle callbacks cannot create competing close intents.

### 23.6 Phase 5 — Paper Execution & Risk Management

**Depends on:** Phases 1 and 4; exchange instrument constraints from Phase 2. **Deliverables:** fully implemented PAPER `ExecutionAdapter` and OMS with market/limit order models, partial/no fills, fees, slippage, reservation lifecycle, positions and confirmed simulated protection; separate PAPER ledger accounts; append-only attributed capital ledger with independent P&L compounding. Implement account/bot/trade risk levels, 80% total target bot-allocation ceiling, no automatic losing-bot replenishment, atomic capital reservation, per-trade planned loss and margin caps, minimum quantity/notional/step validation, 5×/10×/15× profile leverage ceilings with lowest-sufficient-leverage policy, and portfolio-wide risk limits. Exact percentage risk presets remain provisional until validated. Paper environment cannot access production trading credentials.

**Gate:** $20 initial Bot A equity with a $0.50 net loss becomes $19.50 with Bot B unaffected; reserve → commit → release does not alter equity incorrectly; duplicate fills cannot book twice; risk-sized orders below minimum are rejected, not enlarged; concurrent reservations never breach allocation/margin/exposure caps; partial fills have correct filled quantity and protection; end-to-end PAPER bot completes a trade and survives restart.

### 23.7 Phase 6 — Backtesting & Recovery

**Depends on:** complete Strategy, Runtime, OMS/PAPER, Risk and Ledger. **Deliverables:** historical event replay through **the same** core trading modules; injectable virtual clock; reproducible seeded candles; configurable fee/funding/slippage and liquidity models; individual-bot and shared-account portfolio tests; NO_TRADE/rejected/expired/fill metrics; walk-forward, untouched holdout and A/B comparisons. Recover missed market events and candles after disconnect; reconcile paper execution and stop adjustments in event-time order; use `RECONCILIATION_UNCERTAIN` where TP/SL ordering cannot be established. Add durable connection-gap records, replay checkpoints and regression golden scenarios.

**Gate:** identical input dataset/version/seed yields identical reports; no future observations influence an earlier signal; an outage with sufficient event history reconstructs the appropriate paper position state; incomplete evidence never fabricates a fill or favorable TP-before-SL sequence; recovery is idempotent and account ledgers remain consistent.

### 23.8 Phase 7 — Dashboard & Telegram

**Depends on:** production-quality paper API/domain endpoints, health and event schemas from earlier phases. **Deliverables:** React/Vite portfolio and individual-bot views, create/configure/start/pause/resume/stop controls, order/position lifecycle, equity and allocation target versus actual bot equity, NO_TRADE reasons and risk rejections, backtest/forward-paper reports, incidents and status displays. Implement persistent audit/observability events, account/bot notification preferences, incident grouping and resolution workflow, **PostgreSQL notification outbox** and separate Telegram delivery worker with bounded retries/dedupe. All control actions must go through authorized Express API and durable runtime commands.

**Gate:** UI reports paper P&L explicitly as simulated; stop/pause controls respect unresolved exposure; a 30-second or indefinitely hanging Telegram request cannot delay strategy processing, capital approval, simulated fills, or protective actions; queued notifications survive process restart; repeated NO_TRADE events do not flood Telegram; one shared outage produces one grouped incident.

### 23.9 Phase 8 — Hardening & Paper Production Readiness

**Depends on:** paper MVP end to end and prior phase-gate evidence. **Deliverables:** completed Vitest and real PostgreSQL integration suites; fake exchange/adversarial failure injection, property-based ledger tests, lease/fencing verification, market-data gap/unknown-state drills, backup/restore, authentication/authorization/security review, credential and secret hygiene, incident playbooks, `Protect & Freeze` default, and rehearsed controlled restart. Establish native, Docker-free deployment with Nginx/Caddy and systemd/PM2; isolate API, trading runtime and CPU-heavy worker; add CI and reproducible deployment/rollback guides.

**Gate:** all critical tests in Section 22 pass; financial state survives simulated crash and restore; old runtime workers cannot commit stale decisions; resource-heavy backtest and Telegram outage do not degrade critical paper position monitoring; bad migrations fail safely; operators can deploy and restore without Docker; no production LIVE execution path is active.

### 23.10 Future separately gated milestone — LIVE Exchange Adapter

**Not part of the eight-phase paper-first acceptance milestone.** If authorized in a subsequent project decision: implement encrypted, least-privilege exchange credential management; adapter capability detection; authoritative private order/fill/position streams and REST reconciliation; unique client order IDs; exchange-side protective-order verification and amend/close safety; margin mode checks; external/manual exposure reconciliation; real/PAPER ledger isolation; production-exchange access controls; and comprehensive staging/testnet failure validation. Only PAPER ↔ LIVE switches in genuinely IDLE bots with no unresolved exposure. Paper results never fund a live bot. An exchange adapter passing tests does not itself authorize production order placement.

### 23.11 Dependency graph and cross-cutting ownership

```text
Phase 1: Core/DB/API scaffolds
   └─ Phase 2: Market feed + candle storage + seeding
       └─ Phase 3: TA + deterministic Strategy engine
           └─ Phase 4: Bot runtime + Position Manager (fake adapter)
               └─ Phase 5: Risk + virtual capital + PAPER OMS/fills
                   └─ Phase 6: Backtest + event replay + recovery
                       └─ Phase 7: Dashboard + independent Telegram outbox
                           └─ Phase 8: Paper readiness + release safeguards
Future (separate gate): LIVE authenticated executor
```

**Cross-cutting work begins before its primary completion phase:** structured logging/correlation IDs in Phase 1; candle-gap detection in Phase 2; decision audit snapshots in Phase 3; durable state and restart recovery in Phase 4; capital/order audit and independent environment ledgers in Phase 5; full event-time replay in Phase 6; Telegram and operator dashboard in Phase 7; comprehensive ops hardening in Phase 8. An early critical requirement must not be omitted merely because its final dashboard or runbook appears later.

### 23.12 Implementation rules and final milestone acceptance

1. **Express.js only** for HTTP API; do not introduce Fastify. **No Docker, Compose, or Kubernetes** as a development/deployment prerequisite.
2. Keep the code in one modular TypeScript npm-workspaces repository. Separate packages/modules by responsibility, not a premature microservice per bot.
3. No LLM Brain, Judge, autopsy learning pipeline, or memecoin wallet-copying modules from the superseded plan.
4. Preserve the documented data/financial invariants with DB constraints, transactional persistence, idempotent commands and integration tests; do not rely exclusively on in-memory checks.
5. Reuse strategy/risk/position logic across PAPER and backtesting; use a fake adapter to test the ordering/execution contract.
6. A strategy emitting NO_TRADE creates an evaluation record, **not** an order intent, capital reservation or Telegram flood.
7. Never treat missing historical ticks as proof of a particular TP/SL order. No look-ahead or optimistic fill assumptions.
8. Never route Telegram through the critical execution path. No `await` on network notifications to complete any trade decision or protection action.
9. Do not turn on authenticated production LIVE trading or import production credentials as part of completion tests.
10. After each phase, report actual tests and limitations and stop at the phase boundary if a release-blocking gate fails.

**Paper-first product acceptance:** A user can create multiple independent, exclusively assigned bots; fetch/seal strategy-required candle data; get deterministic NO_TRADE/LONG/SHORT decisions; configure risk and 80% total allocations; observe correct independent $20 → $19.50 loss attribution and reserves; run a realistic pending/partial/open/exit simulated position through TP/SL and early-management rules; recover from restarts and market gaps without invented fills; backtest reproducibly; inspect a React dashboard; receive asynchronous Telegram alerts; and deploy/operate the solution without Docker. Production LIVE orders remain disabled pending a new explicit authorization decision.
