# Trading Intelligence Platform — Master Planning Document

## Purpose

This document is the planning handoff for building a configurable, event-driven trading-intelligence platform inspired by the architecture and product concepts visible in StackerAgent.ai.

The goal is **not** to copy StackerAgent's implementation or UI. The goal is to design our own system around the same broad idea:

> Observe market/on-chain activity, identify historically useful participants and patterns, let specialized agents independently analyze opportunities, combine evidence through a persistent Brain, create timestamped predictions, evaluate outcomes, and continuously improve the intelligence layer from historical evidence.

The initial system must be **research/paper-trading oriented**. Do not design or implement real-money execution unless explicitly revisited later.

This document is organized in three parts:

- **Part I — General Platform Architecture**: shared across both trading domains.
- **Part II — Memecoin Domain**: intelligence specific to MEMECOIN (Solana).
- **Part III — Perp Domain**: intelligence specific to PERPETUALS.

Read Part I first, then whichever domain part is relevant to what you're working on.

---

# PART I — GENERAL PLATFORM ARCHITECTURE

## 1. Product Vision


We are building a:

**Configurable Autonomous Trading-Agent Research Platform**

The platform supports multiple trading domains:

1. **Memecoin**
2. **Perpetuals (Perps)**

The user should be able to create multiple independent trading agents from the dashboard and choose which domain each agent belongs to.

Example:

- `Meme Hunter Alpha` → MEMECOIN → Solana
- `Meme Scalper` → MEMECOIN → Solana
- `BTC Perp Scout` → PERPETUAL → Crypto
- `SOL Perp Macro` → PERPETUAL → Crypto

Each agent has its own:

- configuration
- enabled analysis modules
- scoring configuration (weights, thresholds, min R:R)
- prediction history
- paper portfolio
- performance statistics

Each agent does **not** get its own Brain. Brain facts (wallet/token/setup/market memory) are shared per domain — see §15/§16 — so wallet or setup quality is derived once, not re-derived per agent. What's genuinely per-agent is config and that agent's own prediction/outcome history, since two agents with different weights produce different predictions off the same shared facts.

The platform itself provides the shared infrastructure.

---

## 2. Core Principle


Do NOT think of this as:

`LLM → BUY/SELL`

Think of it as:

`DATA → OBSERVATIONS → SIGNALS → AGENT ANALYSIS → BRAIN → PREDICTION → OUTCOME → LEARNING`

The LLM is only one component.

Most numerical/market calculations should be deterministic and reproducible.

The LLM should primarily synthesize structured evidence, explain a thesis, identify conflicts, and produce structured reasoning.

---

## 3. High-Level Architecture


```text
                         DATA SOURCES
                              |
                    +---------+---------+
                    |                   |
              Blockchain            Market Data
                    |                   |
                    +---------+---------+
                              |
                        INGESTION LAYER
                              |
                         NORMALIZATION
                              |
                          EVENT BUS
                              |
          +-------------------+-------------------+
          |                   |                   |
       Wallet             Token/Market         Perp
       Intelligence       Intelligence         Intelligence
          |                   |                   |
          +-------------------+-------------------+
                              |
                        SIGNAL ENGINE
                              |
                    +---------+---------+
                    |                   |
              MEMECOIN BRAIN       PERP BRAIN
                    |                   |
                    +---------+---------+
                              |
                      OPPORTUNITY SCORE
                              |
                       AGENT / JUDGE
                              |
                         PREDICTION
                              |
                       PAPER ENGINE
                              |
                         OUTCOME ENGINE
                              |
                  +-----------+-----------+
                  |           |           |
               Wallet      Agent       Setup
               Memory      Memory      Memory
                  |           |           |
                  +-----------+-----------+
                              |
                            BRAIN
                              |
                         next cycle
```

---

## 4. Important Domain Separation


The platform is generic, but the intelligence must be domain-aware.

## Memecoin Brain

Focus on:

- smart-money wallets
- wallet profitability
- wallet consistency
- early-entry edge
- memecoin specialization
- wallet convergence
- token age
- liquidity
- holder concentration
- volume acceleration
- momentum
- token safety/risk
- signal freshness
- historical memecoin setups

## Perp Brain

Focus on:

- funding rates
- open interest
- liquidations
- long/short positioning
- basis
- price action
- volatility
- volume
- market regime
- technical setups
- historical perp setups
- holding-period behavior

Do NOT mix memecoin and perp performance statistics.

There can be a global platform layer, but each domain should maintain separate intelligence and historical evaluation.

---

## 5. Facts vs Intelligence


This distinction is mandatory.

## FACT

Something objectively happened.

Example:

```text
Wallet X
bought
Token Y
$5,000
12:31:04
```

## OBSERVATION

A derived factual property.

Example:

```text
Wallet X has made 417 historical trades.
```

## SIGNAL

An observation considered interesting by an analysis system.

Example:

```text
Wallet X has a strong early-entry history and just bought Y.
```

## PREDICTION

A forward-looking, timestamped hypothesis.

Example:

```text
Given current evidence, Token Y has a favorable
historical setup for the next 6 hours.
```

Never blur these layers.

---

## 6. Agent System


Every agent should follow a common interface.

Conceptually:

```ts
interface TradingAgent {
  name: string;

  canHandle(event: DomainEvent): boolean;

  analyze(
    event: DomainEvent,
    context: AgentContext
  ): Promise<AgentResult>;
}
```

Agents should produce structured results.

They should NOT directly mutate unrelated parts of the system.

Agents are data/intelligence producers.

---

## 7. Agent Types (Common)
Potentially reusable across domains:

- Risk Agent
- Momentum Agent
- Market Regime Agent
- Research/Judge Agent
- Sentiment Agent (future)

Domain-specific agent rosters (Memecoin Agents, Perp Agents) are defined in their respective sections below.

### Agent access: users toggle per TradingAgent; compute stays shared platform-wide

Users creating a TradingAgent choose which Analysis Agents it uses, from an agent registry curated per domain by the developers. What does **not** change based on that choice: every registered Agent still runs once per relevant symbol platform-wide and is cached for every TradingAgent watching that symbol — the same reasoning as the shared-Brain decision (§15), so a Momentum Agent computation is never redone N times for N TradingAgents watching the same symbol. Toggling affects the composite only, never whether the agent runs.

Mechanically this is one field, not two: `agentWeights: Record<agentKey, number>` in `ScoringConfig`. **An absent key means disabled.** A UI toggle-off omits the key; a slider sets its value. There is no separate `enabledAgents` array to fall out of sync with the weights. **Default: all agents contribute** unless a user deliberately customizes their TradingAgent — e.g. a "Funding Contrarian" agent omits Momentum's key and leans on Funding/Positioning instead, as a deliberate specialization, not a default state.

Two consequences that must be implemented, not assumed:

1. **Weights renormalize across enabled entries** so the composite stays on [−1,+1] and remains comparable between TradingAgents with different rosters. A TradingAgent running four of eight agents does not produce systematically smaller scores than one running all eight.
2. **Setup Memory fingerprints always use the full shared feature set**, never the TradingAgent's enabled subset. The Brain is shared per domain (§15) — if fingerprints varied by roster, two agents would write incompatible `setupId`s into one table and the shared Brain would fragment. Toggles affect scoring, never fingerprinting.

### Agents vs Features (they are not the same thing)

The weight tables in Part II §9 and Part III §3 list eight rows each, but only some are Agents. The rest are computed by the Feature Aggregator or read from the Brain:

```text
AGENT    → has a trigger type, an agentVersion, an AgentPerformance record, an
           Agent Memory standalone-accuracy score, and a user-facing on/off toggle.
           Produces a directional lean.
           perp: Momentum, Open Interest, Market Regime, Liquidation, Funding, Positioning
           memecoin: Smart Money, Convergence, Momentum, Token Quality, Market Regime

FEATURE  → a scalar the aggregator computes or reads from the Brain. No trigger, no
           version, no performance record, no Agent Memory — "what if you followed only
           this one's lean" is meaningless for a decay function or a win-rate lookup.
           Carries a weight in the composite, settable to 0, but is not a toggle.
           perp: Volume, Historical Edge
           memecoin: Early-Entry Edge, Signal Freshness, Historical Edge
```

`AgentPerformance` and `BrainAgentMemory` are keyed by `(agentKey, agentVersion)` and only ever hold Agents. Features are weighted inputs and nothing more. Market Regime is an Agent that emits an enum plus a directional bias — its Agent Memory tracks the bias, not the enum. The Risk Agent is an Agent but sits outside the composite entirely (post-aggregation veto), so it has performance tracking but no weight.

### Trigger types (required field on every agent spec, Task 5)

Every specialized Agent declares its own trigger — there is no single global cadence:

```text
CADENCE      → fires on candle close of a timeframe (e.g. Momentum Agent, Market Regime Agent).
               Timeframe comes from the TradingAgent's trading style (see Agent Creation, trading style).
EVENT        → fires only on a specific raw event (e.g. Liquidation Agent on perp.liquidation.detected;
               Smart Money Agent on a trade from a high-scoring wallet).
CONDITIONAL  → a CADENCE agent that additionally skips a candle close if nothing meaningful changed
               since its last run (e.g. Momentum Agent skips a flat, low-volume candle).
```

This applies to both domains — memecoin leans more heavily on EVENT-type agents (wallet activity is inherently event-driven), perp leans more heavily on CADENCE-type, but the mechanism itself is domain-agnostic.

---

## 8. Agent Creation


The dashboard must support:

`Create Agent`

Core fields:

- name
- domain
- chain/exchange/market universe
- paper starting balance
- risk profile
- trading style (day / swing / scalp — see below)
- enabled agents + their weights (§7 — absent key = disabled; weights
  renormalize across enabled entries)
- scoring configuration

Note: no "Brain configuration" field — the Brain is shared per domain (§15), not configured per agent.

### Trading style (replaces manually-selected prediction horizons)

Instead of users picking raw horizons directly, they pick a trading style, which drives three things together: the candle timeframes Agents analyze, the prediction horizon(s) offered, and the ATR/support-resistance timeframe the Trade Planner uses for SL/TP.

**Resolved (finalized mapping):**

```text
                Scalp              Day                Swing
Analysis TFs    1m · 5m · 15m      15m · 1h · 4h      4h · 1d
Primary TF*     5m                 1h                 4h
Horizons (T1)   5m · 15m · 30m     1h · 4h · EOD**    1d · 3d · 1w
ATR window      14 on 5m           14 on 1h           14 on 4h
Signal TTL      15m                4h                 1d
  · memecoin    10m                30m                2h
LIMIT expiry    6 × 5m (30m)       6 × 1h (6h)        6 × 4h (24h)
```

\* **Primary TF** is the timeframe whose candle close fires the analysis-tier pipeline
(§10) for CADENCE/CONDITIONAL agents — chosen as the middle of each band.
\*\* EOD = 00:00 UTC.

Notes:
- Outcome horizons are **style-driven** (this table), which supersedes §21's domain-fixed
  horizon lists — those are retained only as the per-domain *reference horizon* for
  cross-style comparability (Task 7 resolution, §34).
- Memecoin Signal TTL runs tighter than perp because wallet-convergence edge decays within
  minutes (Part II §3).
- Per-piece user overrides (e.g. a custom primary TF) are a post-MVP config affordance, not
  part of the initial version.

Example:

```text
Name:
Meme Hunter Alpha

Domain:
MEMECOIN

Chain:
Solana

Trading style:
Day

Agent weights:
(default: all agents contribute; override individual weights here)
```

Perp example:

```text
Name:
BTC Perp Scout

Domain:
PERPETUAL

Universe:
BTC, ETH, SOL

Trading style:
Swing

Agent weights:
(default: all agents contribute; override individual weights here)
```

**Resolved (configuration schema).** TradingAgent identity is immutable —
`{ id, domain, universe, tradingStyle }` — because changing trading style invalidates the
whole timeframe/horizon basis (that's a new agent, not an edit). Everything tunable lives in
the versioned `ScoringConfig` (Task 1, §34): `riskPercent, minRR, maxConcurrentPositions,
maxCorrelatedExposure, dailyLossLimit, leverageMax (perp), agentWeights{}, signalThresholds`.

**Added fields.** `confidenceWeights{}` (the 0.30/0.30/0.25/0.15 split from
Task 6 — confidence is a property of a prediction and both the deterministic engine and
the Judge produce one, so its weights must be versioned like any other scoring input) and,
for memecoin, `stopPct`, `takeProfitPct`, `walletExitThreshold`, `maxPoolShare` (Part II
§10). Full schema:

```text
riskPercent, minRR, maxConcurrentPositions, maxCorrelatedExposure, dailyLossLimit,
leverageMax (perp), agentWeights{}, confidenceWeights{}, signalThresholds,
stopPct / takeProfitPct / walletExitThreshold / maxPoolShare / batchingWindowMs
  / profitLadder[] (memecoin)
```

Memecoin-only `batchingWindowMs` (default 5000, §9a) and `profitLadder` (default `null`;
when populated, replaces the single-level `takeProfitPct` — see Part II §10) are versioned
here rather than hardcoded so the seed-history analysis can tune them without a code change
and every prediction's `configVersion` FK captures which values produced it.

---

## 9. Signal Engine (Generic)


The Signal Engine is responsible for:

- normalization
- deduplication
- correlation
- aggregation
- prioritization
- expiration

Example:

```text
Wallet A buys X
Wallet B buys X
Wallet C buys X
Wallet D buys X
```

Should potentially become:

```text
SMART_MONEY_CONVERGENCE
```

rather than four unrelated signals.

Signals should be timestamped and traceable back to source facts.

---

## 10. Event Architecture


Use an event-driven architecture.

Potential events:

```text
wallet.transaction.detected
wallet.trade.detected
wallet.profile.updated
wallet.score.updated

token.activity.detected
token.profile.updated

memecoin.wallet.buy.detected
memecoin.wallet.convergence.detected
memecoin.wallet.exit.detected        (Part II §10 — cluster-weighted sell)
memecoin.signal.created

perp.funding.updated
perp.open_interest.updated
perp.liquidation.detected
perp.signal.created

agent.analysis.completed
brain.score.updated

prediction.created
prediction.expired
prediction.resolved

agent.performance.updated
setup.performance.updated

signal.retrigger.requested
paper_trade.tp_hit
paper_trade.sl_hit
paper_trade.opened     (build-time addition, audit-2 entry orchestrator — the §11 fast lane's
                        entry receipt, emitted after the paper fill commits)
signal.flipped         (build-time addition, §18 gate → shadow-inserter subscribes to insert the
                        DETERMINISTIC-direction shadow prediction for §23 evaluation)
signal.stood_aside     (build-time addition, §18 gate → shadow-inserter subscribes to insert the
                        DETERMINISTIC-direction shadow when the Judge stood aside)
```

Use a standard event envelope:

```ts
interface DomainEvent<T = unknown> {
  id: string;
  type: string;
  version: number;
  timestamp: string;
  source: string;
  correlationId?: string;
  payload: T;
}
```

### Trigger cadence (resolved — applies to both domains)

Previously unresolved: is the pipeline triggered on every candle close, or handled purely by events? Answer: both, at two different tiers, matching the per-agent trigger types defined in Agent Types (§7):

- **Analysis tier**: the *heavy* pipeline (Agents → Feature Aggregator → Signal Scoring → Brain → Judge → Prediction) fires on candle close of the TradingAgent's primary timeframe (style-derived, see Agent Creation §8) for CADENCE/CONDITIONAL agents, or on the relevant raw event for EVENT-type agents. It does not run on every tick — that would be expensive and mostly noise.
- **Tick tier**: raw streamed data (trades, orderbook, liquidations) continuously updates rolling in-memory buffers via the normal event pipeline — cheap, no heavy pipeline invoked.

### Tick-level monitoring (new — needed for retriggers and TP/SL detection)

A separate, continuous per-tick WebSocket feed is required, consumed by a lightweight monitor that never runs the full pipeline. It checks exactly two things on every tick:

1. **Retrigger conditions.** A Signal/Prediction can attach one or more conditions when created, e.g. `{ type: "price_above", value: 67000 }`. The tick monitor watches these until they fire or the prediction expires; on fire, it emits `signal.retrigger.requested`, which kicks the analysis-tier pipeline early, out of its normal cadence.
2. **TP/SL hit detection.** A stop or target can be hit mid-candle — waiting for candle close to detect this is wrong and the Paper Engine (§20) previously didn't specify how this was detected at all. The tick monitor checks every open paper trade's TP/SL on every tick and closes it immediately at the tick that crosses it, emitting `paper_trade.tp_hit` or `paper_trade.sl_hit`.

Both checks are intentionally cheap (threshold comparisons against already-buffered prices) — the tick monitor never invokes Agents, the Brain, or the Judge.

### Feed staleness detection (new — the specific bug that killed the previous bot)

Not previously specified, and it's the documented failure mode of this platform's predecessor: a WebSocket connection can die silently while the process keeps running, and nothing downstream notices — open paper positions stop being checked against real prices, and predictions keep "resolving" against data that's no longer moving.

**Resolved: every feed subscription (per symbol, per topic) tracks a heartbeat/watermark** — the timestamp of its last received message. A background check compares this against a per-feed max-staleness threshold. If a feed exceeds its threshold, the TradingAgents depending on it transition to `BLOCKED` (Trading Agent Lifecycle, §37) — this is what actually implements that state, which was previously named but never given a trigger.

**Per-feed thresholds (resolved — MVP defaults, live in platform-wide infra config, not `ScoringConfig`):**

```yaml
feed_staleness_thresholds:
  bybit.tickers:              5s          # near-continuous in a live market; silence = broken
  bybit.orderbook:            5s          # near-continuous; silence = broken
  bybit.kline.1m:             2m 30s      # allow one missed close + small buffer
  bybit.kline.5m:             10m 30s     # 2 × interval + 30s (same rule below)
  bybit.kline.15m:            30m 30s
  bybit.kline.1h:             2h 30m
  bybit.kline.4h:             8h 30m
  bybit.kline.1d:             2d 30m
  bybit.publicTrade:          60s         # quiet periods exist on smaller symbols;
                                          # do NOT false-alarm on legitimate low activity
  bybit.liquidation:          30m         # genuinely sporadic — hours of silence is
                                          # normal (nobody got liquidated); alarm only
                                          # on very long gaps
  bybit.positioning_poll:     3 × poll interval    # e.g. poll every 5m → alarm at 15m
                                                    # without a successful response
  helius.wallet_webhook:      60s         # first approximation — see caveat below
```

**General rule for kline feeds:** `threshold = 2 × interval + 30s`. Allows one missed close (a real occurrence during minor network hiccups without indicating feed death) plus a small buffer for delivery delay. Second missed close = something's genuinely wrong.

**Helius webhook caveat.** Helius webhooks are push-only rather than a persistent connection you can heartbeat directly, so "detect subscription died" is subtler than for a WebSocket. The 60s threshold above is a first approximation — if a subscribed wallet has been silent for 60s, *maybe* the wallet just isn't trading, or *maybe* the webhook subscription is broken. Two practical detection strategies, either works: **(a) canary wallet** — subscribe to at least one very high-activity wallet as a liveness probe (if the canary goes silent, the webhook path is likely broken regardless of what your target wallets are doing); **(b) periodic REST re-check** — every N minutes, poll the recent transaction list of one known-active subscribed wallet via Helius REST and confirm it matches what webhooks delivered. Task 5 detail; not blocking MVP start, but must be settled before shipping the Helius adapter (M1).

**Fallback for the one check that can't just stop:** TP/SL detection (above) depends entirely on the tick feed. If that specific feed goes stale, the tick monitor must fall back to REST polling for open positions' current price until the WebSocket recovers — silently doing nothing here is not acceptable, since it's exactly the scenario that causes an open position to sit unmonitored.

**Threshold tunability.** All thresholds above live in platform-wide infra config (a YAML or table, NOT `ScoringConfig` — these are platform reliability settings, not per-TradingAgent scoring inputs). If any threshold false-alarms in production, tune it up; if one is missing real failures, tune it down. One-line change, no code redeploy needed.

### Event-time vs. processing-time (new — protects the point-in-time correctness the doc already relies on)

Idempotency (Concurrency, §29) stops the same event being processed twice, but not misordering — a WebSocket reconnect replaying a backlog, funding data arriving after the candle it belongs to, or a Solana transaction that gets dropped and rerouted can all arrive out of their true order. A system that leans this heavily on "state as of T" (the wallet score log, rule 21; the T0/T1/T2 autopsy boundary, rule 22) needs to track **event time** (when something actually happened) separately from **processing time** (when the system received it), and apply a watermark — data arriving late enough that it would retroactively change an already-finalized "as of T" read must not silently rewrite that history. Exact watermark tolerance is left to Task 2 (event contracts).

---

## 11. Queues


Use Redis + BullMQ.

Potential queues:

```text
blockchain-ingestion
market-ingestion

wallet-analysis
token-analysis

signal-processing
agent-analysis

brain-processing

prediction-evaluation

paper-portfolio

analytics
```

Do not make agents call each other synchronously wherever avoidable.

Prefer:

`event → queue → processor → event`

### Fast-path priority lane (resolved — the reaction path must not starve behind heavy jobs)

Detection of a watched-wallet buy or sell must reach a paper fill and a Telegram alert
quickly, and must not wait its turn behind queued analysis/Brain/attribution work. So the
reaction path rides a **high-priority lane** (BullMQ job priority), ahead of the heavy tier:

```text
FAST LANE (high priority — must not lag under load):
  detection → selection pass → PAPER FILL (or recorded decision-not-to-fill) → TELEGRAM
  detection → PAPER CLOSE (sell) → TELEGRAM

SLOW LANE (normal priority — allowed to lag; enriches after the fact):
  full scoring detail, Brain memory update, attribution, autopsy
```

Two hard rules on the fast lane:

1. **Ordering is `detection → paper fill → telegram`.** The alert is a *receipt* of a recorded
   outcome (entry/exit price, size, which agent, SL/TP), not a bare "a wallet moved" ping —
   possible only because the fill is committed before the alert sends.
2. **The paper fill's recorded price is pinned to detection time, never to when the worker
   ran.** A fill recorded late is a *wrong* fill (bad price), not merely a slow one — decouple
   "when we recorded it" from "what price we recorded" so a busy box can't silently corrupt
   paper P&L. Telegram send is **fire-and-forget after the fill commits**: a Telegram outage
   logs an error and the fill still stands; the alert depends on the fill, never the reverse.

**Telegram feed scope (resolved):** only **real fills and closes** hit Telegram — "agent
bought X @ price", "agent sold Y, wallet-exit, +34%". Decision-not-to-fill outcomes
(Token-Risk veto, thin pool, token already claimed §9a, no free slot) are **recorded** for the
dashboard and learning loop but **not** pushed to Telegram, to keep the feed readable.

---

## 12. Normalization Layer


Never expose raw provider-specific transaction formats to agents.

Example normalized event:

```json
{
  "wallet": "...",
  "action": "BUY",
  "token": "...",
  "amountUsd": 4200,
  "timestamp": "...",
  "signature": "..."
}
```

Provider-specific data stays inside the adapter/ingestion layer.

---

## 13. Database Design


Use PostgreSQL + Drizzle.

Core entities:

```text
TradingAgent
Wallet
WalletTransaction
WalletTrade
TradeOutcome
WalletScoreEvent      (§4 — append-only score log, "score as of T" lookups)

Token
PriceSnapshot
TokenMetrics

Agent
Signal
Convergence

Prediction              (isShadow: boolean, shadowOf: predictionId? — §18 override mechanism
                          produces a real + a shadow prediction; same table, not a separate one)
PredictionOutcome

AgentPerformance

BrainWalletMemory
BrainTokenMemory
BrainAgentMemory
BrainSetupMemory       (Part II §8/§9 — keyed by setupId (the fingerprint hash); occurrences,
                         wins, losses, winRate, medianReturn, drawdown, horizonBreakdown,
                         winRateWilsonCI, recency-weighted stats)

TradeAutopsy           (§24 — one row per resolved prediction, WIN or LOSS: evidence package refs,
                         outcome, rootCause, failureCategory (loss) / successFactor (win),
                         contributingFactors, agentFailures, lesson, recommendation)
LearningHypothesis     (§24 — one row per proposed weight/config change: hypothesis text,
                         supporting autopsy count, proposed change, backtest result,
                         out-of-sample result, status: PROPOSED/PROMOTED/REJECTED)

LLMCallLog             (§23 — every LLM call: predictionId, agent, model, tokens, cost,
                         latencyMs — covers Judge calls, overrides, and autopsies alike)

PaperPortfolio
PaperPosition
PaperPositionFill              (Part II §10 — one row per fill on a memecoin position:
                                 { positionId, fillAt, sizeFraction, price, reason:
                                 LADDER_RUNG_N | STOP_LOSS | WALLET_EXIT | TAKE_PROFIT |
                                 HORIZON, isFinal }. Enables size-weighted average exit
                                 return + full audit trail across ladder + closing exit.)
PaperPositionOriginatingWallet (Part II §10 — join table between PaperPosition and Wallet;
                                 one row per wallet that contributed to the entry signal:
                                 { positionId, walletId, clusterId, entryUsd, entryWeight,
                                 entryScore (point-in-time, rule 21), currentHeldFraction }.
                                 currentHeldFraction decrements as the wallet sells; the
                                 walletExitThreshold accumulator sums (1 − currentHeldFraction)
                                 × entryWeight across all rows for the position. Retained
                                 after position close for autopsy / performance attribution.)

DomainEvent
ProcessedEvent

ScoringConfig
```

Note: the final Drizzle schema is derived at build time from this entity list plus the
`CLAUDE.md` context, not hand-specified here — see Task 2 (§34), resolved as
"sufficiently specified."

---

## 14. TradingAgent vs Agent


These concepts should remain separate.

## TradingAgent

A user-created strategy/research entity.

Example:

```text
Meme Hunter Alpha
domain = MEMECOIN
```

It owns:

- configuration (including trading style, agent weight overrides — see §7/§8)
- predictions
- paper portfolio (single, shared across all symbols it watches)
- performance
- lifecycle state (see new Trading Agent Lifecycle section)

It does **not** own a Brain (shared per domain, §15). It **does** own an enabled-agent
roster with per-agent weights (§7) — the agents themselves still run once
platform-wide regardless.

## Analysis Agent

A specialized reasoning/data component.

Example:

```text
SmartMoneyAgent
MomentumAgent
FundingAgent
RiskAgent
```

A TradingAgent can enable/disable specialized Analysis Agents (§7 — this line
is correct as written; the toggle governs the composite, not whether the agent computes).
Features are not toggleable, only weightable.

This separation is important.

---

## 15. Brain Architecture


The Brain is NOT simply an LLM.

It is persistent statistical/contextual intelligence.

Conceptually:

```text
Global Platform
      |
      +---------------------+
      |                     |
Memecoin Brain          Perp Brain
      |                     |
Wallet Memory           Funding Memory
Token Memory            OI Memory
Agent Memory            Market Memory
Setup Memory            Setup Memory
Outcome Memory          Outcome Memory
```

The Brain should answer:

> Given the current evidence, what has historically happened in situations resembling this?

### Decided: shared domain Brain, not per-agent Brain

The Brain is **shared per domain** (one Memecoin Brain, one Perp Brain) — not duplicated per TradingAgent. Rationale: wallet score, token score, and setup-outcome history are facts about the market, not opinions belonging to any one agent. Re-deriving them per agent would be wasteful (same computation N times) and would let two agents disagree about a fact, which shouldn't be possible.

What's per-agent instead is a thin layer on top of the shared Brain:

- **Config**: scoring weights, thresholds, enabled modules, min R:R — how this agent *weights* the Brain's shared outputs.
- **Own outcome memory**: this agent's own prediction/outcome track record — genuinely agent-specific, since different agents make different predictions off the same shared facts.

So "does a TradingAgent get an isolated Brain" (Task 1) is resolved: no. It gets isolated config + its own outcome history, reading from a shared domain Brain.

---

## 16. Brain Memory Types (Common)
## Agent Memory

How useful each specialized agent has been.

### Concrete mechanism (resolved — was previously a named concept with no wiring)

As stated, "how useful has this agent been" sounds distinct from Attribution (§22, per-prediction numeric factor scoring) and hypothesis promotion (§24, weight changes after backtest confirmation) — but without a defined mechanism it just collapses into those two and adds nothing. The concrete thing Agent Memory tracks that neither of those does: **each specialized agent's own standalone counterfactual accuracy** — if a hypothetical TradingAgent had followed *only* this one agent's lean, direction-for-direction, ignoring every other agent, what would its win rate have been? Tracked per agent, per domain, decayed by recency same as Setup Memory.

This is different in kind from Attribution (which explains one prediction's composite score) and from hypothesis promotion (which changes weights only after a specific, tested proposal) — Agent Memory is a continuously-updated, ungated read: "historically, has Momentum Agent's lean alone been worth following?" It's descriptive, not prescriptive — it doesn't change any weight by itself, but it's the diagnostic signal that would motivate someone to *propose* a hypothesis about that agent's weight in the first place, and it's also the number that would justify deprecating an agent entirely if its standalone accuracy sat at or below chance for long enough.

## Market Memory

How setups behave under different market regimes.

Domain-specific memory types (Wallet/Token Memory for memecoin, Funding/OI Memory for perp) are defined in their respective sections below.
## 17. Data Providers (General Rule)
Both domains follow the same rule: never hard-code provider-specific responses throughout the application. Create a provider adapter interface per domain, and route all provider-specific data through the adapter/ingestion layer only.

Domain-specific provider details (Solana for memecoin, Bybit for perp) are defined in their respective sections below.
## 18. LLM / Judge Layer

**Model: DeepSeek V4-Flash for every LLM call in this system** — Judge (this section), overrides, invalidators, and Trade Autopsy (§24) alike. One model, not a Pro/Flash split, chosen for cost given the call volume Autopsy alone introduces (every resolved *perp* prediction, win or loss — memecoin autopsy is deferred in MVP, §24). `LLMCallLog` (§23) still records `model` per call, so this can be revisited per-role later without a schema change if evidence (§23's cost-vs-value metrics) suggests it should be.

The LLM receives structured evidence and must not invent market facts — it reasons over evidence the system supplies.

Example input:

```json
{
  "walletScore": 91,
  "convergence": 88,
  "momentum": 76,
  "marketRegime": "BULL",
  "agentAgreement": 0.84,
  "historicalEdge": 0.17,
  "riskScore": 48
}
```

Expected structured output:

```json
{
  "direction": "LONG",
  "confidence": 0.75,
  "thesis": "...",
  "keyRisks": [],
  "invalidators": [],
  "confidenceTag": "moderate"
}
```

### The Judge always states its own direction and confidence, independent of the deterministic Signal Engine's call

Both directions get compared. The gate is deliberately narrow, so it only fires on genuine, well-evidenced disagreement — an unconditional veto would reintroduce the exact mistake this platform's predecessor was built to avoid (the LLM architecting the trade under a different name).

*Caveat on "independent": the Judge's input includes `historicalEdge`, which comes from the same Brain the deterministic Signal Scoring Engine also reads — so the two confidences are not a truly independent second opinion, they're correlated by construction through shared inputs. This biases the gap toward agreement (smaller gaps than a genuinely independent read would produce), which makes disagreement even rarer than the gate alone would suggest. The honest framing: the confidence gap measures whether the Judge's synthesis diverges from a deterministic read of largely the same evidence, not an independent check. Full blinding of the Judge's inputs is not adopted here — it would remove useful context for a marginal independence gain — but §23's evaluation sample-size concern is partly a consequence of this correlation.*

**If they agree** — no shadow trade. The LLM's other fields (`thesis`, `keyRisks`, `invalidators`, `confidenceTag`) attach as narrative context to the single real prediction.

**If they disagree on direction**, the outcome is one of three, decided by which side is confident:

```text
gap = |deterministic_confidence − llm_confidence|

FLIP          det_conf < 0.7  AND gap >= 0.2  AND llm_conf > det_conf
              → REAL = Judge direction, SHADOW = deterministic direction

STAND ASIDE   det_conf >= 0.7 AND llm_conf < 0.7 AND gap >= 0.2
              → NO REAL TRADE, signal → INVALIDATED (§36),
                SHADOW = deterministic direction

DEFER         everything else, incl. two confident disagreeing reads
              → deterministic wins, dissent row logged, no shadow
```

Worked examples: `det 0.45 / llm 0.85` → FLIP. `det 0.90 / llm 0.55` → STAND ASIDE. `det 0.90 / llm 0.75` → DEFER (gap clears the threshold, but both sides are confident — genuine disagreement worth logging, not grounds for a trade decision). `det 0.40 / llm 0.25` → DEFER — a weaker dissent must never flip a weak signal, which is what the `llm_conf > det_conf` clause on FLIP enforces.

All four thresholds live in an `overrideGate` block in `ScoringConfig`, versioned like every other scoring input. `judgeAction: FLIP | STAND_ASIDE | DEFER` is recorded on every disagreement and is the grouping key for §23's evaluation. STAND ASIDE reuses the existing invalidator evaluation path — mechanically the same event (a trade prevented before entry), asking the same question of its shadow.

**On FLIP:**

```text
REAL prediction   = Judge's direction   → goes to Trade Planner → normal risk gates
                                           (min R:R, leverage/liquidation check) apply
                                           exactly as they would to any direction →
                                           paper-traded as the system's actual trade
SHADOW prediction = deterministic's original direction → also goes through the
                                           Trade Planner and gets paper-traded, but
                                           purely for comparison — never the real trade
```

On STAND ASIDE, only the shadow exists — no real trade is taken. On DEFER, neither exists — just a logged dissent row. Both FLIP and STAND ASIDE get full outcome tracking (a complete parallel paper trade, not a lightweight comparison), to build a track record answering "when the Judge disagrees, is it actually right more often?" — see §23.

**Accepted consequence:** because the gate is deliberately narrow, the FLIP/STAND-ASIDE population grows slowly, so §23's headline "does the Judge add value" question will take a long time to reach significance. That's a known cost of keeping execution conservative, not an oversight — logged dissent rows (including DEFER cases) still accumulate and can be analyzed for direction agreement rates without any shadow execution.

**What never triggers any of this:** a TP/SL tweak, an entry-type preference, or a confidence tag alone. Only an actual directional flip through the gate above does. Risk gates remain fully deterministic regardless of which side produced the winning direction — the Judge can only choose which direction those checks get applied to, never bypass them.

### LLM failure in the hot path

The Judge sits inline in Signal → Prediction. If the call times out or fails, the prediction **must still be created, deterministic-only** — direction/entry/SL/TP/sizing all come from the deterministic engine regardless, so there's nothing structurally stopping this. `thesis`/`keyRisks`/`invalidators`/`confidenceTag` are simply null, and since there's no Judge direction to compare, FLIP/STAND-ASIDE are structurally impossible for that prediction (no gap to compute) — it's a DEFER by default. The wrong answer — "Judge down = zero trades" — is never acceptable; the system degrades to "Judge down = trades without narrative or override capability," a graceful, well-defined degradation, not a missed opportunity. This is also required for the reproducibility goal in Success Criteria (§32) — a hidden dependency on LLM uptime for trade creation would undermine it.

### Memecoin scoping note

Memecoin is effectively long-only — a wallet buys a token or it doesn't; there's no clean short. This means the FLIP/STAND-ASIDE machinery above, built around a LONG↔SHORT flip, rarely or never actually fires in memecoin — the Judge's only real functional lever there is the invalidator (don't enter / exit early). The mechanism and thresholds are the same across both domains, it just structurally has near-zero surface area to trigger on in memecoin, and that's expected, not a bug — worth stating plainly so nobody builds out shadow-trade infrastructure for a case that doesn't occur in this domain. *(MVP status, audit #21: even the invalidator lever is NOT wired for memecoin — the Judge agent's `canHandle` refuses memecoin outright, per CLAUDE.md's do-not list: near-zero surface, wasted LLM cost. The lever unlocks together with memecoin autopsy when memecoin gets a backtest (§24's own trigger), not before.)*

This rule applies identically to the Perp Judge Agent (Part III) — see the correction there.

---

## 19. Prediction System


Every prediction must be immutable after creation.

At minimum:

```text
agent
domain
token/symbol
createdAt
horizon
direction/stance
confidence
score
entry reference
thesis
features
invalidators
configVersion    (FK to ScoringConfig, §13 — resolved, see below)
```

### configVersion is required, not optional (resolved — was previously missing)

`ScoringConfig` already exists as a versioned table (§13), and Task 1 already calls for config versioning — but nothing on `Prediction` itself actually recorded *which* version produced it. Without this FK, the moment a `LearningHypothesis` gets promoted (§24) and weights change, every performance stat and Attribution (§22) breakdown silently blends predictions made under two different scoring configs into one number, with no way to separate them after the fact. Every `Prediction` must carry an immutable `configVersion` pointing at the exact `ScoringConfig` row active when it was created — this is what lets "did the weight change actually help" be answered cleanly, rather than retroactively guessed at.

After creation:

```text
PREDICTION CREATED
        ↓
LOCKED
        ↓
MARKET EVOLVES
        ↓
OUTCOME
```

This is necessary to avoid look-ahead bias and retroactive editing.

---

## 20. Paper Engine


The first version should simulate positions.

It should support:

- virtual cash
- virtual positions
- entry
- exit
- unrealized P&L
- realized P&L
- drawdown
- fees/slippage assumptions
- position sizing
- risk constraints

No real-money execution in the initial system.

### TP/SL detection (resolved)

Previously unspecified: how does the Paper Engine know a stop or target was hit? It doesn't poll candle closes — a stop can be crossed mid-candle. TP/SL hits are detected by the tick-level monitor (Event Architecture §10), which watches every open paper position against the live tick feed and closes it at the exact tick that crosses TP or SL, emitting `paper_trade.tp_hit` / `paper_trade.sl_hit`.

### Fill model — domain-split, not one flat assumption (resolved — this is the biggest hole in making backtest/paper results trustworthy)

"Fees/slippage assumptions" as a single generic bullet is not sufficient, and using it uniformly across domains would make one domain's numbers fiction:

**Perp**: a flat bps slippage assumption is fine. BTC/ETH/major perp markets are deep enough that a reasonably-sized paper position doesn't meaningfully move the market — fill price = mid/last price ± a small fixed bps for spread/slippage.

**Memecoin**: (see Part II §10 for the full memecoin planner — MARKET-only entry, fixed-% stop, wallet-exit as primary exit — that this fill model serves.) A flat bps or last/mid-price fill is **not** acceptable and must not be used. Low-liquidity memecoin pools have large, non-linear price impact — a paper engine that fills at last price will manufacture returns that don't survive contact with a real order book, which directly undermines the "demonstrates predictive value" success criterion (§32) for the exact domain the roadmap front-loads. Memecoin fills must be **liquidity/depth-aware**: fill price is a function of trade size against the pool's actual depth at execution time (e.g. constant-product AMM math, or orderbook depth consumption, depending on what the chosen Solana provider exposes), not a static assumption. This needs its own design pass as part of Task 5 (per-agent specs) / Memecoin Data Providers (Part II §7) — whatever provider is chosen must expose enough liquidity/depth data to make this possible, which becomes a hard requirement on that provider decision, not a nice-to-have.

### Detection-lag pricing (resolved — the fill model handles size impact but not *time* impact)

The depth-aware model above prices *size* impact correctly, but there is a second, separate
source of paper-vs-reality divergence it does not touch: **webhook detection lag.** A watched
wallet's on-chain action reaches the system a few seconds later via the Helius webhook (a floor
set by Solana finality + webhook delivery, not removable in code — Part II §7). The paper fill
must be priced against the **pool state / price at detection time (when the system could first
have acted), not at the wallet's on-chain action time.** Pricing at the wallet's action time
credits the system a fill it could never have gotten.

This matters most on the **sell side**, and the exit precedence in Part II §10 already anticipates
it (stop-loss ranks above wallet-exit precisely because "a dump can outrun webhook latency"):
the two exit mechanisms run on **two different latency paths** —

```text
SL / TP        → watched by the tick monitor against the live price feed → fires on the tick
                 that crosses the level, effectively zero added lag.
WALLET EXIT    → arrives by the same webhook path as the buy → carries the few-second
                 detection lag; paper close is priced at detection time, i.e. at whatever the
                 price already is by the time the sell was detected (in a dump, worse than
                 where the wallet actually got out).
```

This split is deliberate and good — a fast reflex (SL/TP on the price feed) plus a slower-but-
smarter signal (wallet exit via webhook) — but the paper engine must price the lagged one
honestly or the sell-side P&L flatters itself in exactly the scenario that hurts most in real
trading. **Record both clocks** (event/on-chain time and processing/detection time — Part I §10
already requires event-time vs processing-time separation) on every fill and close, so the real
reaction lag is a measured number, not a guess, and so alerts can show it (e.g. "detected 3.4s
after on-chain buy").

---

## 21. Outcome Engine


Evaluate predictions at multiple horizons.

Memecoin example:

```text
5m
15m
30m
1h
6h
24h
```

Perp example:

```text
15m
1h
4h
24h
```

Outcome data can include:

```text
return
benchmark return
alpha
maximum favorable excursion
maximum adverse excursion
hit target
hit invalidation
holding period
```

### Horizon anchor (resolved — was previously unpinned)

Every horizon above (5m, 1h, 4h, ...) measures **from T1 (entry/fill), not T0 (signal creation)**. This matters concretely for LIMIT orders (Part III §4) that can sit `PENDING_ENTRY` for several candles before filling — anchoring at T0 would silently eat into the reported horizon before the position even exists. T0 remains the reference point only for the no-look-ahead rules (rule 21, rule 22) — that's a different purpose (what data was available), not the return-measurement clock.

### Every outcome records how it was resolved

Live outcomes are resolved tick-by-tick (§10). Seeded outcomes (§25) are resolved from
historical candles, which cannot say whether TP or SL was touched first inside a candle.
Both populations feed the same `BrainSetupMemory`, so the difference must be visible rather
than silent. `PredictionOutcome` carries:

```text
outcomeResolution: TICK | CANDLE_1M_CONSERVATIVE
```

Dashboards report seeded and live win rates separately as a divergence check, even though
the Brain aggregates them together and lets recency decay do the rest.

---

## 22. Attribution


Every prediction should explain what contributed to its score.

Example:

```text
Prediction #8321

Wallet convergence       +21
Wallet quality           +18
Momentum                 +14
Agent agreement          +11
Historical edge           +9
Liquidity                 +6
                         ---
Total                    79
```

After resolution, record which factors actually had predictive value.

This becomes input to future Brain improvements.

---

## 23. Cost Tracking & LLM Value Measurement

Because the system uses an LLM (Judge, §18), every call needs cost/usage tracking, tied back to the prediction it supported:

```ts
interface LLMCallLog {
  predictionId: string;
  agent: string;        // which Judge instance / config version
  model: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  latencyMs: number;
  timestamp: string;
}
```

### What "is the LLM adding value" actually means

The Judge (§18) has three functional levers:

1. **FLIP** — the Judge's direction becomes the real trade, deterministic's original direction becomes a full parallel shadow trade.
2. **STAND ASIDE** — no real trade is taken; the signal is invalidated before entry, and the deterministic direction runs as a shadow-only comparison. Mechanically the same evaluation as an invalidator (Signal Lifecycle, §36) — a trade prevented before entry, asking the same question of its shadow.
3. **Narrative** (thesis, keyRisks, confidenceTag) — read by a human, doesn't affect the system's own behavior, not separately measured here.

DEFER disagreements produce no shadow trade — only a logged comparison row (deterministic vs. Judge direction/confidence, with the outcome of whichever trade was actually taken). Direction-agreement rates and per-side calibration can be computed from those rows; win-rate comparison cannot, and that limitation is accepted as a known cost of keeping execution conservative (§18).

A fourth LLM call exists outside these — **Trade Autopsy** (Learning Loop, §24) — which runs post-outcome per resolved prediction and also needs cost tracking via the same `LLMCallLog`, but it's evaluated differently: autopsy value isn't measured by shadow trades (there's no "shadow" version of a completed trade), it's measured by whether its aggregated hypotheses actually get promoted through the backtest-and-out-of-sample pipeline (§24) — a promoted hypothesis is a concrete signal the autopsy layer is finding real, actionable patterns; a growing pile of rejected hypotheses is a signal it isn't.

So "does the LLM add predictive value" is two separate measurable questions:

- **Do FLIPs actually improve outcomes?**
- **Do STAND ASIDEs actually improve outcomes?**

Both use the same shadow-evaluation method below, just triggered by different `judgeAction` values.

### Shadow evaluation (covers both FLIP and STAND ASIDE)

Whenever §18's gate produces a FLIP or STAND ASIDE, the deterministic direction runs as a shadow, paper-traded in full, to outcome. For FLIP, compare against the real (Judge-direction) trade:

```text
Override group (FLIP — Judge direction taken):        win rate, median return, drawdown
Shadow group (deterministic direction, same signals):  win rate, median return, drawdown
```

If the override group doesn't outperform its shadow, FLIP is net-negative and the gate should be tightened (raise the confidence-gap threshold, lower the confidence-floor cutoff) or removed — this is directly testable, not assumed.

For STAND ASIDE, the comparison is against what would have happened had the trade been taken anyway (invalidator-style):

```text
With STAND ASIDE honored (no trade taken):   n/a — nothing to measure directly
Shadow (deterministic direction, as if taken): win rate, median return, drawdown
```

If the shadow group doesn't perform meaningfully worse than the domain's baseline, STAND ASIDE isn't adding value either — exactly the "maybe the LLM adds almost nothing" hypothesis this section exists to test, not assume.

### Aggregate reporting

```text
Total LLM cost (period)
Cost per prediction
Cost per FLIP taken (and FLIP win rate vs shadow win rate)
Cost per STAND ASIDE (trades prevented) vs shadow win rate
Cost per autopsy, and autopsy hypothesis promotion rate (promoted vs rejected)
$ spent on LLM per unit of shadow-vs-real outcome improvement (all mechanisms)
```

That last figure is the actual answer to "is this worth it" — cost against measured effect, not cost in isolation.

---

## 24. Learning Loop


The fundamental feedback loop:

```text
OBSERVE
   ↓
ANALYZE
   ↓
SCORE
   ↓
PREDICT
   ↓
MEASURE
   ↓
ATTRIBUTE
   ↓
UPDATE MEMORY
   ↓
UPDATE BRAIN
   ↓
OBSERVE AGAIN
```

Do not claim the system "learns" merely because an LLM is present.

The learning should be measurable through historical outcomes and updated statistics.

### Trade Autopsy (post-trade failure analysis)

A dedicated, first-class part of the learning system — distinct from Attribution (§22, numeric factor scoring at prediction time), from the Judge's original thesis (forward-looking, written before the outcome is known), and from `BrainSetupMemory` (Part II §8/§9 — pure win/loss/occurrence counting per `setupId`, updated directly and instantly, no LLM involved). Autopsy is the qualitative *why*, per trade; `BrainSetupMemory` is the quantitative *how often*, per fingerprint — they share a `setupId` but are separate tables with separate consumers (see relationship note below).

**Resolved scope: symmetric (WIN + LOSS), PERP ONLY in MVP.** Memecoin autopsy is explicitly deferred — see the memecoin scope note immediately below. For perp: every completed prediction gets an autopsy, win or loss. `outcome` is `WIN` or `LOSS` (a hard fact from the Outcome Engine, §21 — the autopsy never re-decides this, only explains it). A loss gets a `failureCategory`; a win gets the equivalent `successFactor` (e.g. `MOMENTUM_CONFIRMED_EARLY`, `REGIME_ALIGNED`) — so Setup Memory can eventually learn not just what a setup does wrong, but what it does right, at roughly 2x the LLM call cost of loss-only.

**Memecoin autopsy is deferred, not part of MVP (resolved — the deferral falls out of §25's memecoin backtest scope-out, not a new decision).** The reasoning is structural: memecoin has no historical backtest in MVP (§25), so the hypothesis pipeline below (propose → backtest → out-of-sample → promote) has no promotion path in this domain. A memecoin autopsy could tag `WALLET_EXITED_LATE`, `RUG_SLIPPED_VETO`, `DETECTION_LAG_ATE_EDGE`, but the tag would sit forever as a `LearningHypothesis` in `PROPOSED` state with no mechanism to promote or reject it — LLM cost with no promotion payoff. The two things that actually change future memecoin decisions are already updated by the outcome directly, no LLM involved: every closed wallet trade writes a fresh `WalletScoreEvent` (Part II §4), and every closed prediction updates `BrainSetupMemory`'s win/loss/median-return/Wilson-CI on its `setupId`. Recency decay ages both. `exitReason` on the position (`STOP | WALLET_EXIT | LADDER_COMPLETE | TAKE_PROFIT | HORIZON`, Part II §10) plus per-fill rows in `PaperPositionFill` and logged partial-sell observations give the learning loop enough structured signal to answer "which exit condition earns its keep" from plain SQL. Autopsy comes back for memecoin only when memecoin gets a backtest engine — that is the trigger, not a calendar date. Until then, the memecoin outcome path is: `OUTCOME → { WalletScoreEvent update, BrainSetupMemory update, exitReason + per-fill log + partial-sell log } → BRAIN → future decisions`, with no autopsy hop.

```text
Prediction → Outcome → Autopsy → Root Cause → Agent Attribution → Learning Hypothesis
```

**Evidence package (three parts, not raw data dumped at the LLM):**

1. **What the system believed** — the exact, immutable signal-time snapshot: every agent's normalized score, the composite Signal Score, confidence, direction, entry, SL, TP.
2. **What actually happened** — the subsequent market evolution as a timestamped sequence (price, OI, etc. at +5m, +15m, +22m stopped-out, +30m, ...), plus how the agent outputs themselves evolved over that window.
3. **Surrounding raw market data** — OHLCV, trades, orderbook, funding, OI, liquidations, long/short ratio, volatility, regime for the full prediction window, so the LLM can investigate the sequence, not just the final numbers.

**The question asked must be specific, not "why did this trade lose?":** for a loss, identify the most likely failure mechanism and classify it as incorrect market interpretation, insufficient signal quality, execution/entry placement, risk parameters, or an unforeseeable market event. For a win, identify what actually drove it, with the same rigor — not just "the LLM was right."

**Structured output:**

```json
{
  "outcome": "LOSS",
  "rootCause": "LONG_CROWDING",
  "failureCategory": "POSITIONING_MISREAD",
  "successFactor": null,
  "explanation": "...",
  "contributingFactors": [
    "Funding was already highly elevated",
    "OI expanded faster than price",
    "Long/short ratio was heavily skewed",
    "Momentum signal overweighted price trend"
  ],
  "agentFailures": [
    { "agent": "momentum", "assessment": "overweighted", "impact": "high" },
    { "agent": "positioning", "assessment": "correct_warning_but_underweighted", "impact": "high" }
  ],
  "lesson": "...",
  "recommendation": "..."
}
```

(`failureCategory` is null on a WIN record; `successFactor` is null on a LOSS record — always exactly one of the two populated.)

**Hard rule — no direct weight changes from a single autopsy, or even from an LLM's aggregate opinion.** An individual autopsy (or even a pattern the LLM claims to see across many) never edits scoring weights directly — that's the same veto-scope discipline as everywhere else in this doc: the LLM proposes, it doesn't silently self-modify the deterministic engine. Autopsy findings instead feed a hypothesis-test pipeline:

```text
TRADE RESOLVED (WIN or LOSS)
    ↓
FAILURE ANALYZER (autopsy, per-trade)
    ↓
ROOT CAUSE REPORT
    ↓
LEARNING RECORD (stored, aggregated across trades)
    ↓
┌───────────────┬────────────────┐
↓                                ↓
Aggregate over many trades   Evaluate hypothesis
↓                                ↓
└───────────────┬────────────────┘
                 ↓
        MODEL / WEIGHT PROPOSAL
                 ↓
             BACKTEST
                 ↓
           IMPROVEMENT?
          /              \
        YES               NO
         ↓                 ↓
     PROMOTE            REJECT
```

### Hypothesis eligibility (resolved — n≥20 for hypothesis proposal, higher than Setup Memory's own n≥10 trust bar)

A high loss count on a `setupId` does *not* by itself make anything eligible for testing. Eligibility is tied to a **specific `failureCategory` (or `successFactor`) recurring often enough within that same `setupId`** — the floor here is **effective-n ≥ 20**, deliberately *higher* than the **effective-n ≥ 10** Setup Memory uses to trust its own win-rate stats (§8/§9). The split is intentional: reading a slightly-thin cell's own stats is cheap-wrong (the composite already down-weights it via a wide Wilson CI), but promoting a weight change off thin evidence is a permanent config mutation guarded only by the backtest — that's where the real risk lives, so it gets the more demanding bar. **All three floors are on recency-weighted effective count, using the domain's Setup Memory half-life; raw counts appear nowhere as a gate.** A category that recurred 25 times three years ago is not eligible on the strength of that alone:

```text
setupId X has 40 losses total (BrainSetupMemory.losses)
        ↓
Of those 40, 25 autopsies share failureCategory = REGIME_SHIFTED_MID_TRADE
        ↓
25 >= 20 → THIS specific pattern is eligible for hypothesis proposal
(if instead 40 losses were scattered across 8 different categories, none hitting
 20, nothing becomes eligible yet — even though the total loss count is high)
```

Crossing this bar only unlocks the *right to be proposed and backtested* — it doesn't promote anything by itself. It's deliberately a cheap, generous gate: getting eligibility exactly right isn't the safety-critical step, since nothing reaches production without also surviving backtest + out-of-sample confirmation below, which is what actually guards against a pattern that only looked real on the data that produced it.

Example (loss side): if autopsies across 184 similar losses converge on "funding was underweighted," the system records the hypothesis and evidence count, proposes a specific weight change (e.g. 10% → 18%), backtests old vs. new weighting, and requires **out-of-sample** confirmation before promoting. A single LLM opinion is never enough — only a backtested, out-of-sample-confirmed improvement gets promoted; anything else is rejected and stays a logged hypothesis, not a live change.

Example (win side, same mechanism): if 30 autopsies on a different `setupId` converge on `successFactor = MOMENTUM_CONFIRMED_EARLY`, that's equally eligible (30 >= 20) — proposes increasing Momentum's weight for that fingerprint, backtested and out-of-sample-confirmed exactly the same way before promotion. `LearningHypothesis` doesn't care whether the recurring pattern came from wins or losses; the pipeline (propose → backtest → out-of-sample → promote/reject) is identical either direction.

**Relationship to Setup Memory (Part II §8 / Part III §6), stated precisely:** `BrainSetupMemory` and `TradeAutopsy` are parallel tables sharing a `setupId`, not one feeding the other directly. `BrainSetupMemory` updates instantly on every resolved prediction and is read directly by the Signal Scoring Engine at signal time — no gate. `TradeAutopsy` records are never read directly at signal time at all; they only matter in aggregate, and only after clearing eligibility above and surviving the full backtest pipeline, at which point a *promoted* hypothesis changes the live scoring config that future predictions on that fingerprint (or its parent buckets) will use. Aggregated autopsy patterns are a much stronger form of learning than any single autopsy's narrative conclusion — e.g. "when funding > 90th percentile AND OI rising rapidly AND long/short > 1.8 AND momentum score > 80, LONG signals underperform by 18%" — but they earn that strength through the gate, not through volume alone.

**Strict no-look-ahead boundary (also added to Planning Rules, §33):** the autopsy is post-outcome only. Define `T0` = signal timestamp, `T1` = entry, `T2` = exit. The original prediction and any backtest of it may only use data `<= T0`. The autopsy itself may use the full `T0 → T2` window — but nothing it observes in that window may leak backward into the original prediction or its backtest. This is the same discipline as the point-in-time wallet score rule (§4/rule 21), applied here to autopsies specifically.

**Cost is tracked, not free.** Every autopsy is an LLM call and gets logged into the same `LLMCallLog` (Cost Tracking, §23) as every other Judge/LLM call in this system — model, tokens, cost, latency, tied to the prediction it's autopsying. This isn't optional bookkeeping: it's what makes the "is the LLM adding value" question in §23 answerable for the autopsy layer too, not just for overrides and invalidators — cost per autopsy weighed against hypothesis promotion rate is the concrete number that says whether running autopsies at all is worth it. Symmetric scope (WIN + LOSS) on perp roughly doubles this cost versus loss-only, which is the real trade-off behind that scope decision. Excluding memecoin from MVP autopsy (above) removes another significant chunk of LLM cost — every closed memecoin paper trade would otherwise be a call, and memecoin has no promotion path to spend that cost on until it has a backtest.

---

## 25. Backtesting


This is a major feature.

The system should eventually replay historical events:

```text
Historical Data
      ↓
Replay events chronologically
      ↓
Run agents
      ↓
Generate signals
      ↓
Generate predictions
      ↓
Evaluate outcomes
```

Critical rule:

**No look-ahead bias.**

If prediction time is `12:00`, only information with timestamp `<= 12:00` may influence the prediction.

Features must be timestamped.

### Brain Seeding (resolved — this is how cold-start actually gets solved, not just documented)

Setup Memory (Part II §8/§9) needs effective-n≥10 per fingerprint before it trusts its own numbers (lowered from the earlier n≥20 default — see §24 hypothesis eligibility for the rationale; the scoring engine already down-weights thin cells via Wilson CI width, so trusting a cell's own stats at 10 is safe when the composite still folds the interval width in), and with ~6,500 possible fingerprint cells for perp, starting from zero live trades means most cells stay `INSUFFICIENT` for a long stretch — the system's headline "historical edge" feature runs essentially silent for months if left to fill in purely from live paper trading.

**Resolved: run the replay engine above against historical data *before* the system ever trades live**, generating synthetic predictions against the past, evaluating them against what actually happened, and feeding those outcomes into `BrainSetupMemory` exactly as a real trade outcome would. On day one of live trading, a meaningful fraction of fingerprints already carry real historical stats instead of starting at `INSUFFICIENT`. Seeded occurrences are timestamped with their true historical dates, so Recency decay (Part II §8) naturally fades their influence as fresh live data accumulates — no separate "this was seeded" flag or special-case logic needed, the existing decay math already handles it correctly.

**How seeded outcomes get resolved (this was the open methodological gap).**
Live TP/SL detection is tick-level; historical seeding cannot be, so seeded and live rows
would otherwise be produced by two different exit models and mixed into one table. Resolved:

1. Seed from Bybit **1m klines** — the finest historical granularity that is cheap and goes
   back years. Not the primary timeframe: resolving a 4h trade on 4h candles is far too
   coarse to be honest about intra-candle exits.
2. **Pessimistic tie-break**: when a single 1m candle's range spans both TP and SL, record
   the outcome as **SL hit first**. This biases seeded stats downward. That is the correct
   direction to be wrong in — a Brain that slightly under-rates a seeded fingerprint costs
   a missed trade, one that over-rates it costs a taken loss.
3. Record `outcomeResolution = CANDLE_1M_CONSERVATIVE` (§21) so the two populations stay
   separable in reporting forever.

Upgrading to Bybit historical trade data (true tick resolution) is a later refinement, not
an MVP requirement — the ingestion volume is large and the pessimistic rule already bounds
the error in a known direction.

### Historical data lives in local Postgres, not fetched live from Bybit (resolved — was implied but never stated)

Both Brain Seeding above and any subsequent backtest (hypothesis-pipeline runs, §24;
walk-forward evaluation, Task 7) query historical klines/funding/OI from **local Postgres**,
never from Bybit's REST API at replay time. Three reasons make this non-negotiable, not a
preference:

1. **Reproducibility.** A hypothesis promoted on Monday must give the same backtest result
   on Friday. Bybit occasionally corrects historical bars; a live-fetched replay would
   silently return different numbers on the same test, breaking Task 7's train/test
   discipline and rule 11 (no look-ahead → also no data-drift).
2. **Rate limits.** A single full backtest across BTC/ETH/SOL over a year of 1m candles is
   millions of rows. Fetching that from Bybit REST per replay run would throttle or get
   the app banned.
3. **Speed.** Local indexed reads vs HTTPS round-trips are orders of magnitude apart —
   without local storage, walk-forward folds become the pipeline's bottleneck.

Concrete shape:

```text
ONE-TIME BACKFILL (pre-launch, part of M1 — see §30 correction)
   ↓
Fetch Bybit REST historical klines (per symbol × timeframe × range),
funding history, OI history
   ↓
Store in Postgres tables keyed by (symbol, timeframe, timestamp)
   ↓
Composite index on (symbol, timeframe, timestamp) for chronological
range scans

ONGOING (extends the same table forward)
   ↓
Live WS ingestion writes closed candles into the same historical table
as they close — the historical store and the live store are one table,
just continuously extended. No sync job, no divergence risk.

BACKTEST / SEEDING REPLAY
   ↓
Replay engine queries Postgres chronologically ("give me every candle
with timestamp <= T, one at a time"), feeds into agents as if live
   ↓
Never calls Bybit at replay time.
```

Sizing: 1 year of 1m candles for one symbol ≈ 525k rows; a handful of symbols across the
style-relevant timeframes is a few million rows total — comfortably inside Postgres's
sweet spot, no partitioning needed at MVP scale.

Memecoin is unaffected by any of this — memecoin has no historical backtest or seeding in
MVP (§25 memecoin scope, above); Helius live webhooks are the only Solana data source, and
they write into their own live-only tables.

**This has a structural consequence for the roadmap (Initial Roadmap, §30):** the replay engine cannot be a late-stage evaluation tool built at M6 as originally sequenced — if the Brain needs to be seeded *before* launch, the core replay capability is a **pre-launch requirement**, not a post-launch measurement feature. See the roadmap correction in §30.

**Scope decision: Brain Seeding and historical backtesting apply to perp only.** Historical klines/funding/OI from Bybit are cheap and go back years, so perp seeding is straightforwardly buildable and required before perp goes live. **Memecoin is explicitly scoped out of both Brain Seeding and historical backtest replay** — not because it's blocked pending a provider decision, but as a deliberate MVP scope decision (see the resolved provenance question immediately below).

### Memecoin: no historical backtesting/seeding in MVP (resolved — scoped out, not a blocking open risk)

Previously flagged as an open risk pending provider research (whether any Solana provider could supply enough historical swap/liquidity/wallet data to make memecoin replay possible). **Resolved by scoping decision, not by provider research: memecoin does not get Brain Seeding or historical backtest replay in this MVP.** The memecoin Brain builds up purely from live paper trading — Setup Memory fingerprints start at `INSUFFICIENT` and cross effective-n≥10 only through real elapsed live volume, same mechanism as perp, just without the pre-launch head start.

**Two different uses of "historical" — one is IN, one is OUT (this distinction is the whole point, and is easy to misread):**

```text
IN  — Wallet Scoring backfill (Part II §4).  "Is THIS WALLET any good?"
      Fetch one wallet's OWN past trades (per-address Helius lookup, on demand) → run the
      Wallet Scoring formula → write its WalletScoreEvent. Populated from day one for all
      ~100 seeded wallets. Cheap, per-address, no bulk archive needed.

OUT — Brain Seeding / Setup Memory replay (§25, Part II §8).  "When a SETUP LIKE THIS
      happened before, what was the outcome?" Requires replaying the ENTIRE market's
      history — every token's price evolution after every historical convergence, chain-wide
      — to pre-fill the 243-cell fingerprint win-rate table. Needs bulk historical archival
      access (all Solana swap/liquidity/price data), which the Helius free tier does not
      provide and which is scoped out for MVP.
```

These are **different databases answering different questions** — a per-wallet quality score
vs. a per-fingerprint setup-outcome win rate. Fetching each wallet's own history to score it
(IN) does **not** imply the ability to replay the whole chain to seed Setup Memory (OUT), and
scoping out the latter does **not** mean wallets start unscored. On day one: wallet scores are
fully populated (backfill), while Setup Memory's "historical edge" feature reads `INSUFFICIENT`
until live volume fills it. Both statements are true simultaneously and do not conflict.

**Consequences, stated plainly:**
- The memecoin domain has a genuinely longer bootstrap window (§32) than perp — this should be expected, not treated as a problem to fix later, and Success Criteria evaluation for memecoin specifically should account for this being the slower-to-mature domain.
- This removes the historical-data requirement from Task 4's provider evaluation (§34) — the Solana provider only needs to support **live wallet/token watching** (webhooks, parsed swaps, real-time delivery), not deep historical archival access. This is a meaningfully easier bar: Helius' free tier (30M CU/month, webhooks, enhanced parsed transaction APIs) is sufficient for MVP live watching on this scope.
- If memecoin backtesting/seeding becomes worth doing later, it's a genuine future-phase decision, revisited with real provider research at that point — not something this MVP needs to solve now.

### Seed vs live parity (addendum, build-time — audit-3 clarifications)

*A live-vs-seed audit turned up three silent bugs (all fixed): (a) `prediction.createdAt` used
`defaultNow()` so seeded outcomes anchored on today and resolved as `won=false, returnPct=0`;
(b) the seeder called `resolvePrediction` but not `feedBrainOnce`, so the Brain tables stayed
empty; (c) `agent_performance` had zero writers repo-wide. This addendum documents the invariant
"seed must produce the same downstream state a live run would" so the next audit doesn't have
to rediscover it.*

**Seed writes (must match live-on-close):**

- `signal` + `signal_feature` — every fired signal + per-agent features
- `signal_no_trade` — planner refusals (INSUFFICIENT_RR / CANNOT_SIZE_SAFELY / etc.)
- `signal_risk` — Risk Agent verdict (audit-3: same veto the live pipeline applies)
- `prediction` — with `createdAt = bar.closeTime` so outcomes anchor correctly
- `prediction_outcome` — every horizon in the style's Task-7 set
- `brain_setup_occurrence` + `brain_setup_memory` — via `feedBrainOnce`
- `brain_agent_occurrence` + `brain_agent_memory` — same
- `agent_performance` — per-user-agent scorecard, one row per `(tradingAgentId, agentKey, agentVersion)`

**Seed deliberately DOES NOT write (per §25 scope):**

- `paper_position` / `paper_position_fill` / `paper_portfolio` — "seeding does not open paper
  positions; it resolves the counterfactual and feeds the Brain." Live has cash/equity/drawdown;
  seed does not. Portfolio metrics live-only.
- `judge_decision` — the Judge is deterministic-input LLM output but the LLM call itself is
  non-deterministic AND costs money per bar. Seed omits the Judge; live invokes it when
  `DEEPSEEK_API_KEY` is set.
- `trade_autopsy` / `learning_hypothesis` — perp autopsy is a live-only loop (§24 defers
  memecoin autopsy entirely). Seeded predictions are not autopsied.

**Live-only writes not related to individual predictions (unchanged, unaffected by seed):**

- `wallet_score_event` / `brain_wallet_memory` — driven by `scoreAllWallets` on a schedule
- `cluster_run` / `wallet_cluster` — driven by `recomputeClusters` on a schedule
- `active_token_claim` — memecoin live only (seeded perp never touches it)

**The invariant:** if a table has a live-on-close writer, seed must call the same writer with
the same inputs — otherwise seeded state drifts from what "we had been running live for six
months" would look like. The `feedBrainOnce` fix + Risk-Agent-in-seed fix + `agent_performance`
fix all restore this invariant. A future contributor adding a new close-side write MUST add it
to seed too or explicitly document why not (usually: LLM cost, or the write is per-position
which seed doesn't have).

---

## 26. Dashboard


Main navigation could be:

```text
Overview
Agents
Smart Money
Tokens
Signals
Brain
Predictions
Paper Portfolios
Performance
Backtesting
Settings
```

## Agents page

```text
Meme Hunter Alpha
MEMECOIN · SOLANA
Score: 84
Predictions: 421

BTC Perp Scout
PERPETUAL
Score: 76
Predictions: 318

+ Create Agent
```

## Agent detail

```text
Overview
Live Activity
Agents/Modules
Brain
Signals
Predictions
Paper Portfolio
Performance
Configuration
```

---

## 27. Agent Room


A live activity feed should show what specialized agents are doing.

Example:

```text
Whale Agent
3 high-quality wallets entered TOKEN X

Momentum Agent
15m momentum accelerated

Risk Agent
Liquidity is acceptable but holder concentration is elevated

Brain
Convergence score → 89

Judge
Current evidence supports WATCH
```

Every displayed claim should map to real system events/data.

---

## 28. Project Structure


Recommended monorepo:

```text
trading-intelligence/
│
├── apps/
│   ├── api/
│   ├── worker/
│   └── dashboard/
│
├── packages/
│   ├── domain/
│   ├── database/
│   ├── events/
│   ├── ingestion/
│   ├── agents/
│   ├── brain/
│   ├── signals/
│   ├── predictions/
│   ├── evaluation/
│   ├── paper-engine/
│   └── llm/
│
├── db/
│   ├── schema.ts
│   └── migrations/
│
├── docs/
│   ├── architecture/
│   ├── agents/
│   ├── brain/
│   ├── scoring/
│   ├── research/
│   └── decisions/
│
├── openspec/             (spec-driven change workflow — see below)
│   ├── AGENTS.md
│   ├── specs/            (source-of-truth capability specs)
│   ├── changes/          (in-flight change proposals with tasks + design)
│   └── archive/          (completed changes, permanent audit trail)
│
├── scripts/
│
└── package.json          (npm workspaces declared in root package.json)
```

**No Docker, no Turborepo.** Neither is structurally required — nothing in this architecture depends on containers or a task-caching layer existing. Postgres and Redis run via hosted/managed services (e.g. Neon/Supabase, Upstash) instead of containers; the Node/TypeScript apps run directly via `npm run` scripts across the existing npm workspaces, no container packaging needed at this scale. Turborepo would only start paying for itself once rebuild times actually become annoying with a larger codebase — safe to add later with zero rework, since it just wraps npm workspaces rather than restructuring anything. Deployment uses a platform that builds directly from the repo (Railway, Render, Fly.io) rather than hand-rolled Dockerfiles.

**Deployment topology: monorepo, independent deploys (resolved — was implicit, now explicit).** Monorepo describes *code organization*, not *deployment*. Each `apps/*` folder is a separate deployment target on its own platform, deployed independently, scaled independently, with its own env vars and domain:

```text
apps/api         → Railway service (Express API + WebSocket server)
apps/worker      → Railway service (BullMQ processors)
apps/dashboard   → Vercel project (static React build, CDN-served)
```

**Independent rebuilds via watch paths (per-platform config).** Each hosting platform is configured with a path filter so a single `git push` only rebuilds the services whose files actually changed. A commit touching only `apps/dashboard/**` rebuilds the Vercel dashboard and nothing else. A commit touching `packages/domain/**` correctly rebuilds every service that depends on it, since a shared type change *should* propagate. Concrete config per platform:

```text
Vercel (dashboard) — ignoreCommand or vercel.json:
    trigger only on changes under apps/dashboard/**, packages/domain/**,
    packages/events/**

Railway (api) — Watch Paths setting:
    apps/api/**, packages/domain/**, packages/events/**, packages/database/**,
    packages/signals/**, packages/predictions/**, packages/agents/**,
    packages/brain/**, packages/llm/**

Railway (worker) — Watch Paths setting:
    apps/worker/**, packages/ingestion/**, packages/events/**,
    packages/agents/**, packages/brain/**, packages/paper-engine/**
```

Setup effort is one-time (~20 minutes across all three platforms); after that, invisible. Without watch-paths configuration, every platform rebuilds on every push — usually harmless (Vercel skips deploy on byte-identical output; Railway just burns build minutes) but wasteful.

**Consequence: this is not a reason to split into multiple repos.** Two-repo layouts trade type-sharing, atomic PRs across the frontend/backend boundary, and single-command dev setup for zero deployment benefit — every hosting platform supports monorepo layouts natively. Keep one repo.

**Change workflow: OpenSpec.** Every subsystem, new Analysis Agent, migration, and analysis pass starts as an OpenSpec change proposal in `openspec/changes/`. The master plan (this document) is the *architectural* source of truth — the *what and why*, resolved once. OpenSpec change specs are the *execution* layer — *how, in what order, tested how*, iterated as you build. Change specs reference plan sections; they do not duplicate them. See `CLAUDE.md` for the full workflow (propose → review → implement → archive) and the scope rule (when to create a change vs. skip). The archive folder is the permanent record of what was built, when, per which plan section — treat it as load-bearing project history, not clutter.

Recommended stack:

- Node.js
- TypeScript
- Express
- Drizzle
- PostgreSQL
- Redis
- BullMQ
- WebSockets
- OpenSpec (spec-driven change workflow)
- npm (npm workspaces, not pnpm)
- React + TypeScript on Vite for `apps/dashboard`
- Tailwind CSS + shadcn/ui for dashboard styling
- TanStack Query for server state; live surfaces over WebSocket, not polling
- lightweight-charts for candles, Recharts for statistical views

---

## 29. Concurrency / Idempotency


This system will have many race-condition opportunities.

Examples:

```text
same blockchain transaction arrives multiple times
multiple agents process same event
multiple workers update same score
multiple signals represent same underlying activity
```

Use database constraints and idempotency.

Example:

```ts
export const processedEvent = pgTable("processed_event", {
  eventId: text("event_id").primaryKey(),
  processedAt: timestamp("processed_at").defaultNow().notNull(),
});
```

And unique constraints such as:

```ts
txHash: text("tx_hash").unique(),
```

Do not rely on:

```text
SELECT
IF NOT EXISTS
INSERT
```

without database-level protection.

### Token claim must be atomic (resolved — the §9a claim under a simultaneous burst)

The platform-wide token claim (§9a) is exactly the kind of check-then-write that a sudden
simultaneous burst breaks: several agents contend in the same instant, all read "token
unclaimed," all pass their gates, all enter before any claim lands — a double-book, which is
the one thing the claim rule exists to prevent. The selection/assignment pass and the claim
write must therefore be **atomic against each other**, enforced at the **database level**, not
by an application-side check. A **unique constraint on the active claim per token** (e.g.
unique on `token_id` among rows where the claim is active) makes a second concurrent entry
fail on insert rather than silently succeed:

```ts
// only one active claim per token can exist at a time
activeTokenClaim: unique on (tokenId) where releasedAt is null
```

This is the general rule of this section applied specifically to the claim — it works in every
test and fails only on the one sudden convergence burst that matters, so it must be structural,
not conditional. Note the claim clock (seconds, per-trade, released on position close) is a
*different clock* from the funder-cluster dedup window (§5, 24–72h) — the two do different jobs
and must not be collapsed into one.

---

## 30. Initial Roadmap


## M0 — Planning

No production code.

Finalize:

- domain model
- Drizzle schema
- event taxonomy
- agent contracts
- agent configuration
- scoring formulas
- Brain design
- evaluation methodology
- provider requirements
- acceptance criteria

## M1 — Data Foundation

Build:

- Solana provider adapter
- market provider adapter
- ingestion
- normalization
- Postgres
- Redis
- BullMQ
- event system
- **core historical replay engine (moved earlier — see correction below)**

Goal:

Raw external data becomes clean internal events.

## M2 — Wallet Intelligence

Build:

- wallet profiles
- transaction reconstruction
- trade reconstruction
- historical performance
- early-entry metrics
- wallet scoring

Goal:

Objectively rank wallets.

## M3 — Smart Money Radar

Build:

- wallet discovery
- candidate filtering
- watchlists
- continuous monitoring
- convergence

Goal:

Automatically identify useful wallet activity.

## M4 — Agent Swarm

Build:

- Memecoin agents
- Perp agents
- agent configuration
- event-driven execution
- agent performance tracking

Goal:

Multiple specialized systems independently analyze opportunities.

## M5 — Brain

Build:

- wallet memory
- token memory
- agent memory
- setup memory
- historical edge
- domain-specific scoring

Goal:

Persistent intelligence based on outcomes.

## M6 — Predictions/Evaluation

Build:

- immutable predictions
- paper portfolios
- multi-horizon evaluation
- attribution
- full evaluation methodology, reporting, and dashboards on top of the core
  replay engine (already built at M1 — see correction below)

Goal:

Prove whether the intelligence has predictive value.

**Pre-launch gate (added — not a numbered milestone, a required checkpoint before going live):** using the core replay engine from M1, run Brain Seeding (§25) against available historical data for **perp only** (Bybit klines are cheap and available). Memecoin is explicitly scoped out of seeding in this MVP (§25) — its Brain builds up purely from live paper trading, with a correspondingly longer bootstrap window (§32). The system does not go live with an empty perp Brain, and does not attempt to seed the memecoin Brain at all.

## M7 — LLM/Judge

Build:

- structured evidence prompts
- LLM synthesis
- thesis
- risk explanation
- agent conflict resolution

Goal:

Use AI for reasoning/synthesis rather than data invention.

## M8 — Dashboard

Build:

- agent creation
- agent management
- smart-money radar
- token pages
- wallet pages
- agent room
- Brain visualization
- prediction pages
- performance
- backtesting (visualization/reporting only — the engine itself already exists from M1)

### Correction: replay/backtesting is a pre-launch requirement, not a late-stage feature

The milestones above originally treated backtesting as something built at M6, alongside evaluation, and visualized at M8. That undersold it: Brain Seeding (§25) depends on the replay engine, and seeding needs to happen *before* the system trades live to avoid the cold-start problem (Setup Memory sitting at `INSUFFICIENT` for most fingerprints for months). So the **core replay engine's build date moved to M1** — it's foundational data-layer infrastructure, not an evaluation nicety. M6 still owns the full evaluation methodology (attribution reporting, per-horizon breakdowns, dashboards) that's *built on top of* that core engine, and M8 still owns its visualization — but the engine itself, and the pre-launch Brain Seeding pass that uses it, both happen much earlier than originally sequenced.

---

## 31. What NOT to Build Initially


Do not start with:

- real-money execution
- exchange withdrawal/deposit handling
- 20+ agents
- reinforcement learning
- microservices everywhere
- fancy animations
- AI chat interface
- huge wallet universe
- complicated autonomous execution
- unvalidated scoring formulas

First prove:

```text
Data
 ↓
Wallet Intelligence
 ↓
Signals
 ↓
Brain
 ↓
Predictions
 ↓
Evaluation
```

---

## 32. Success Criteria


The project should not be judged by:

- number of agents
- number of signals
- number of API calls
- how impressive the LLM output sounds

The important question is:

> Does the system produce timestamped, reproducible intelligence that demonstrates useful predictive information in out-of-sample evaluation?

Important metrics:

- prediction accuracy
- median return
- benchmark-relative return
- alpha
- max drawdown
- precision/recall where appropriate
- calibration
- performance by horizon
- performance by market regime
- performance by agent
- performance by wallet cohort
- performance by setup

### Bootstrap window (resolved — was previously an unstated gap)

Even with Brain Seeding (§25), the metrics above — especially anything depending on `BrainSetupMemory`'s "historical edge" being trustworthy — are not fairly evaluable from day one of live trading, and this is asymmetric by design between domains: **perp is seeded pre-launch, memecoin is not** (§25, a deliberate MVP scope decision, not an unresolved risk). So perp's bootstrap window is shorter (seeded fingerprints already carry real stats); memecoin's is genuinely longer, since every fingerprint starts at `INSUFFICIENT` and only crosses the effective-n≥10 trust floor through real elapsed live volume. Memecoin has no seeding and no historical backtest, by design — it watches wallets and learns on the job. `maxConcurrentPositions` is **fixed at 1** for
memecoin — one agent, one token at a time, a domain rule rather than a tunable default.
That caps trade throughput, which with a 30-day half-life would still leave many of ~6,500
fingerprint cells below effective-n 10 for a long time even at the lower trust floor. The
lever pulled *in addition* is the fingerprint itself: memecoin Setup Memory uses a
**5-feature tuple → 243 cells** (Part II §8), 27× smaller, so the same trade volume
actually fills it. Users wanting more concurrent memecoin exposure create more
TradingAgents; that keeps each agent's portfolio, risk gates and track record cleanly
separable, which a multi-position single agent would blur.

**This is expected, correct behavior for memecoin specifically, not a system failure** — while a fingerprint is `INSUFFICIENT`, the system runs on deterministic agent signals with honestly wide uncertainty, which is exactly what it should do rather than pretending to know more than it does. But it means: don't judge either domain against these success criteria during its bootstrap window, and don't hold memecoin to the same maturity timeline as perp — define an explicit minimum-maturity bar per domain (e.g. a stated minimum fraction of live-encountered fingerprints crossing effective-n≥10, or a stated minimum elapsed live-trading period, evaluated separately for each domain) before treating these metrics as a fair verdict on the approach.

---

## 33. Planning Rules for Claude


When continuing this project, follow these rules:

1. **Do not start implementation immediately.**
2. First identify missing architectural decisions.
3. Ask for clarification only where the decision materially affects architecture.
4. Prefer modular monolith architecture initially.
5. Use TypeScript + Node + Drizzle + PostgreSQL + Redis + BullMQ.
6. Keep domain-specific intelligence separate between MEMECOIN and PERPETUAL.
7. Keep TradingAgent (user-created agent) separate from specialized Analysis Agents.
8. Treat blockchain/market facts as immutable source data.
9. Make signals and predictions traceable to their source evidence.
10. Make predictions immutable after creation.
11. Prevent look-ahead bias in all research/backtesting.
12. Use database constraints for correctness and idempotency.
13. Do not use an LLM for calculations that deterministic code can perform.
14. Do not let the LLM invent market data.
15. Every "learning" claim must be backed by measurable historical outcomes.
16. Version scoring configurations.
17. Keep provider-specific code behind adapters.
18. Do not introduce microservices unless there is a concrete operational reason.
19. Prefer events/queues for asynchronous agent processing.
20. Build the research/paper-trading layer before considering any real execution layer.
21. No code path may use "current wallet score" during backtesting or historical evaluation — only "wallet score as of T" via the score-change log (Wallet Scoring, Part II §4). This is a specific, structural instance of rule 11 and is easy to violate accidentally, so it gets its own explicit rule.
22. Trade Autopsy (Learning Loop, §24) may only use data from `T0` (signal) through `T2` (exit) for its post-mortem analysis — none of that `T0→T2` window may leak backward into the original prediction or any backtest of it, which remain restricted to data `<= T0`. Same discipline as rule 21, applied to autopsies.
23. Every sample-size gate is on recency-weighted **effective-n**, never a raw count (§24 / Part II §8).
24. Setup Memory fingerprints are computed from the full shared domain feature set, never from a TradingAgent's enabled-agent subset (§7). Toggles change scoring, never fingerprinting.
25. The paper engine never fabricates a fill or an exit. No last-price fallback in memecoin, no assumed TP when a candle is ambiguous — resolve pessimistically and record how it was resolved (§21/§25).

---

## 34. Immediate Next Planning Tasks


Before writing production code, work through these in order:

### Task 1 — Define the exact product requirements

Decide:

- What a TradingAgent is
- What users can configure
- ~~What a Brain belongs to~~ / ~~whether multiple agents can share a Brain~~ / ~~whether each TradingAgent gets an isolated Brain~~ — **resolved, see §15**: Brain is shared per domain; agents get config + own outcome memory only.
- How agents are versioned
- How agent configurations are versioned

**Resolved.** Two independent version axes, both keyed into attribution/performance so a
change never silently blends track records:

- **Analysis-Agent code version** — a monotonic **integer** `agentVersion` per agent
  (integer, not semver — the system only needs "is this the same behavior?"), bumped **only
  on a behavioral change** with a changelog line. `AgentPerformance` and `AgentMemory` are
  keyed by `(agentKey, agentVersion)`, so changing an agent's math starts a fresh track
  record instead of poisoning the old one.
- **Config version** — `ScoringConfig` (§13) is **append-only, immutable rows**, one per
  change, with a monotonic `version` per TradingAgent. The active config is the latest row;
  a promoted `LearningHypothesis` (§24) **writes a new row, never mutates**. Every
  `Prediction` FKs the exact row (`configVersion`, §13/§19).

TradingAgent identity (`{ id, domain, universe, tradingStyle }`) is immutable; all tunable
knobs live in the versioned `ScoringConfig` (schema listed in Agent Creation §8).

### Task 2 — Design the complete domain model

Produce the final entity relationship diagram and Drizzle schema.

**Decided: deferred to build time, not this planning doc.** Rather than fully hand-specifying every column and relation here, this doc's entity list (Database Design, §13) plus a well-documented `CLAUDE.md` handed to Claude Code is treated as sufficient context for it to derive and write the actual Drizzle schema as it builds — the entities, their key fields, and their relationships to each other are already established throughout this doc (§13 plus every domain-specific field called out inline, e.g. `configVersion`, `WalletScoreEvent`, `TradeAutopsy`). This task is closed as "sufficiently specified," not "still open."

### Task 3 — Define event contracts

For every event, specify:

- name
- version
- producer
- consumers
- payload
- idempotency key
- retry behavior

**Decided: same approach as Task 2 — deferred to build time.** Event names, the standard envelope (`DomainEvent`, §10), and each event's rough purpose are already established throughout this doc. Exact per-event payload shapes are left for Claude Code to derive from the documented `CLAUDE.md` context as it implements each producer/consumer, rather than pre-specifying every field here.

### Task 4 — Define provider abstraction

Specify:

- Solana data interface
- market data interface
- perp data interface
- historical data interface
- real-time data interface
- **Solana provider requirement (resolved, reduced scope):** memecoin does not use Brain Seeding or historical backtest replay in MVP (§25) — that requirement, and the open provenance risk it created, is scoped out. The Solana provider only needs to support **live wallet/token watching**: webhooks or real-time streaming, parsed swaps/transactions, and account monitoring. **Helius (free tier, 30M CU/month)** meets this MVP bar — webhooks for wallet activity, enhanced parsed transaction APIs. The historical-data interface above applies to the perp provider (Bybit) only for this MVP.

### Task 5 — Define every specialized agent

For each:

- purpose
- inputs
- outputs
- calculations
- database access
- events consumed
- events produced
- whether LLM is needed
- **trigger type** (CADENCE / EVENT / CONDITIONAL — see Agent Types §7) and its specific condition
- **default weight** in the Signal Scoring composite (agent access is weighting, not a compute toggle — see Agent Types §7)

Also finalize as part of this task: the trading-style → timeframe/horizon/ATR-window mapping (Agent Creation §8) — now finalized there.

**Resolved.** The trading-style mapping is finalized in §8. Every Analysis Agent is
**deterministic (no LLM)** and emits `{ score ∈ [−1,+1], confidence ∈ [0,1], features{} }`;
non-directional agents (Regime, Risk) are special-cased below.

**Perp roster + default composite weights** (from Part III §3):

```text
Agent            Wt   Trigger                 Core calculation
Momentum         20   CADENCE, CONDITIONAL¹   EMA(9/21/50) alignment+slope, RSI(14), MACD hist
Open Interest    20   CADENCE                 price×OI 2×2 (rising/rising=trend confirm,
                                              rising/falling=short-covering, falling/rising=new shorts)
Market Regime    15   CADENCE                 ADX+EMA slope+vol → BULL/BEAR/RANGE/HIGH_VOL enum + bias
Liquidation      15   EVENT + CADENCE roll-up net liquidation imbalance/intensity; contrarian at extremes
Funding          10   CADENCE                 funding percentile → contrarian (crowded longs = bearish)
Positioning      10   CADENCE (on L/S poll)   long/short account-ratio skew → contrarian
Volume            5   aggregator feature      vol-weighted candle direction (confirmation)
Historical Edge   5   from Brain              Setup Memory win-rate skew × Wilson-width confidence
```

¹ CONDITIONAL skips a candle when range < 0.25×ATR **and** volume < 0.5×avg (dead candle).

- **Risk Agent** (common) — not in the composite; a post-aggregation veto/quality gate
  (S/R proximity, funding/OI/vol extremity, price extension) → risk level + optional
  `INVALIDATED`.
- **Setup/Pattern Agent — deferred** to a later phase (pattern detection, like breakout
  entries); "historical setup edge" is served by the Brain for MVP.

**Memecoin roster + default weights** (from Part II §9; direction is always LONG — see §18):

```text
Agent/Feature     Wt   Trigger                    Core calculation
Smart Money       25   EVENT (high-score wallet buy)  weighted buyer wallet-quality (score as-of-T)
Convergence       20   EVENT (multi-buy in window)    funder-cluster count × quality × independence × time-compression
Early-Entry Edge  15   aggregator                     converging wallets' historical early-entry forward-return stats
Momentum          15   CADENCE/CONDITIONAL            token OHLCV momentum
Token Quality     10   EVENT (token profile update)   liquidity / age / holder-concentration score
Market Regime      5   CADENCE                        SOL/broad-market regime
Signal Freshness   5   aggregator                     decay since triggering wallet activity
Historical Edge    5   from Brain                     Setup Memory
```

- **Token Risk = hard veto**, independent of its 10% quality score: a rug flag (mint
  authority live, honeypot, LP unlocked, extreme holder concentration) kills the signal
  regardless of everything else.

**`maxCorrelatedExposure` (§37) computation.** Rolling Pearson correlation of returns over
30 primary candles between the candidate symbol and each currently-held symbol; if
correlation ≥ 0.7 the candidate's notional joins a "correlated bucket" whose total is capped
at 1× a single full-risk position. Enforced at the Trade Planner / Risk gate (same point as
the leverage/liquidation and min-R:R checks). Rarely binds while `maxConcurrentPositions`
defaults to 1; exists for when it's raised.

**Memecoin depth-aware fill model (§20) — live paper only** (memecoin historical backtest is
scoped out, Task 4). Constant-product AMM slippage against the pool's **actual reserves at
execution tick** (from Helius): `tokensOut = R_base − (R_base·R_quote)/(R_quote + qIn·(1−fee))`,
fee 0.25% (Raydium default). **If reserves are unavailable the position does not fill** —
the engine never fabricates a price.

### Task 6 — Define Brain mathematically

Specify:

- wallet score formula
- token score formula
- convergence formula
- agent weighting
- historical setup edge
- confidence calculation
- statistical smoothing
- minimum sample sizes

**Resolved.**

- **Wallet score** (weights per Part II §4). Every *rate* sub-metric uses **Beta-Binomial
  shrinkage** toward the wallet-universe base rate — `shrunk = (wins + α₀)/(n + α₀ + β₀)` —
  so 2-for-2 can't outrank 350-for-500. Sub-metrics are normalized to [0,100] by
  **percentile across the wallet universe**. Below **n < 10 trades a wallet is "unrated"**
  and excluded from convergence weighting. Recompute trigger: every **25 new trades or a
  daily job**, appended to `WalletScoreEvent` (point-in-time, §Part II §4 / rule 21).
- **Token score** — liquidity / age / holder-concentration / volume, percentile-normalized;
  safety is a separate hard gate (Token Risk veto), not a soft score input.
- **Convergence** — `Σ_clusters (clusterQuality × independenceWeight) × timeCompression`,
  where clusters are funder-deduped (Part II §5), `clusterQuality` is capped so one cluster
  can't dominate, and **≥ 2 independent clusters** are required to register.
- **Historical setup edge** — from Setup Memory: signed by win-rate-vs-0.5 and median-return
  sign, magnitude weighted by Wilson interval width; returns `INSUFFICIENT` → parent bucket
  below effective-n 10 (Part II §8).
- **Confidence** (Part III §3) = `0.30·signalStrength + 0.30·agentAgreement +
  0.25·historicalEvidence + 0.15·dataQuality`, each ∈ [0,1]. `signalStrength = |composite|`;
  `agentAgreement = 1 − normalized dispersion of agent scores`; `historicalEvidence =
  f(effective-n, Wilson width)`, low when INSUFFICIENT; `dataQuality = 1 − penalties`
  (stale feed, missing agent, thin liquidity). Weights live in the versioned ScoringConfig.
- **Statistical smoothing** — Beta-Binomial for rates; recency-weighted effective-n for
  Setup Memory; Wilson intervals stored on every row (Part II §8).
- **Recency decay** — exponential, `weight = 0.5^(age / halflife)`, `effectiveN = Σ weights`.
  Half-lives: perp setups **90d**, wallet metrics **60d**, memecoin setups **30d**.
- **Minimum sample sizes** — Setup Memory trust at **effective-n ≥ 10** (else INSUFFICIENT,
  falls back to parent bucket); hypothesis eligibility at **effective-n ≥ 20** (the higher
  bar guards weight-change proposals, §24); wallet rating ≥ 10 trades; convergence ≥ 2
  independent clusters.

### Task 7 — Define evaluation methodology

Specify:

- prediction horizons
- benchmark
- outcome rules
- fees/slippage assumptions
- train/test separation
- walk-forward evaluation
- look-ahead prevention
- calibration metrics

**Resolved.**

- **Prediction horizons** — the **style's three horizons** (§8) are the evaluation set. This
  resolves the §8-vs-§21 conflict: §21's fixed per-domain lists are retained only as a single
  **reference horizon** for cross-style comparability — **1h for both domains**.
- **Benchmark / alpha** — perp: underlying buy-&-hold over the window (plus BTC beta);
  memecoin: SOL return over the window. `alpha = directional return − benchmark`.
- **Outcome rules** — WIN = hit TP before SL within the horizon; record
  hitTarget / hitInvalidation / MFE / MAE / return / alpha / holdingPeriod (§21), all
  **anchored at T1** (§21).
- **Fees/slippage** — perp: flat 5.5bps taker + 1 tick; memecoin: the AMM depth model
  (Task 5) + DEX fee.
- **Train/test + walk-forward** (perp only — memecoin backtest is scoped out, Task 4):
  hypotheses (§24) train on a window and must confirm **out-of-sample on a held-out later
  window** before promotion; rolling folds of train 60d / test 20d. Never tune and test on
  the same window.
- **Look-ahead prevention** — structural: the backtest data-access layer exposes only data
  with timestamp ≤ T and "wallet score as of T" (rules 21/22); no "current score" method
  exists to call by mistake.
- **Calibration** — first-class: reliability diagram + **Brier score**, bucketed by
  confidence × horizon × regime ("when we say 0.7, do we hit ~70%?").

### Task 8 — Define dashboard UX

Specify:

- Create Agent flow
- agent detail page
- Brain page
- wallet radar
- token page
- prediction page
- performance page
- backtesting page

**Decided: deferred to build time.** Detailed UX/visual design for these pages is handled by a dedicated design skill/tool at implementation time rather than fully spec'd in this planning doc — this doc has already established what data and concepts each page needs to surface (Dashboard, §26; Agent Room, §27), which is sufficient input for that stage.

### Task 9 — Define MVP boundaries

Explicitly decide what is:

- M0
- M1
- M2
- etc.

Only after these decisions are locked should implementation begin.

**Decided: the entire contents of this document, as written, is the MVP.** No further scope-trimming pass — the milestone breakdown already in the Initial Roadmap (§30) stands as the MVP boundary. This task is closed.

---

## 35. Trade Planner (Common) — Position Sizing & Leverage

The Trade Planner (Perp domain detail: Part III §4) produces entry/SL/TP. Position sizing is the natural next output, and it's domain-generic — it applies whether or not leverage exists:

```text
Risk Budget   = Account Balance × Risk% per trade   (Risk% is a fixed config value — NEVER scaled by confidence)
Position Size = Risk Budget / |Entry − Stop Loss|
```

This works for memecoin (spot, no leverage — buying the token outright) exactly as it does for perps — **but only once memecoin has a stop to divide by.** Memecoin stops are a fixed percentage of fill price rather than an ATR/structure derivation, so `|Entry − Stop Loss| = Entry × stopPct` and the formula above is used unchanged. See Part II §10 for the memecoin Trade Planner in full; the perp planner (Part III §4) is unaffected.

### Leverage does not determine risk — it's a derived output, not a chosen input (perp-only)

Earlier drafts implied leverage is picked upfront (e.g. as an agent config value) and then merely *checked* against the stop distance after the fact. That ordering is backwards, and it's the exact anti-pattern to avoid: **an agent must never scale leverage by confidence** — "confidence 90% → use 20x" is not a valid reasoning step anywhere in this system. Confidence affects nothing about position size, margin, or leverage; it only ever affects the Judge's own direction/override behavior (§18).

Correct causal order — leverage is the *last* thing computed, derived from where the stop already is, not chosen first and validated second:

```text
Risk Budget
     ↓
Position Size          (from Risk Budget and stop distance, above — confidence plays no role)
     ↓
Notional Value = Position Size × Entry Price
     ↓
Max Safe Leverage      = the highest leverage at which Liquidation Price still sits no
                          closer to entry than the Stop-Loss distance (derived from entry,
                          stop distance, and the exchange's maintenance margin formula)
     ↓
Allowed Leverage       = min(Max Safe Leverage, exchange max leverage, user-configured max leverage)
     ↓
Required Margin        = Notional Value / Allowed Leverage
```

If `Max Safe Leverage` is below some usability floor (e.g. the position would need more margin than the account has, even at the lowest sensible leverage), the Trade Planner outputs `NO TRADE — cannot size safely within account constraints`, same veto pattern as the min-R:R gate — leverage is never force-raised to make a trade fit; the trade is rejected instead.

This reframing doesn't change the actual liquidation-vs-stop check from before (still: liquidation must never sit closer than the stop) — it changes *when* leverage gets decided: as an output of the risk math, not an input to it.

---

## 36. Signal Lifecycle

A signal shouldn't remain valid forever — the doc previously conflated **signal TTL** (how long a signal stays actionable before it's stale) with **prediction horizon** (how far out we're predicting once acted on). These are distinct and must be tracked separately.

States:

```text
ACTIVE        → signal just created, within its TTL, not yet acted on
EXPIRED       → TTL elapsed with no entry — nobody acted on it
INVALIDATED   → an invalidation condition fired before entry (market moved against the
                 thesis), OR the Judge stood aside on a confident-signal/weak-dissent
                 disagreement (§18) — both produce a deterministic shadow trade
CONSUMED      → converted into an actual Prediction / trade setup
```

TTL is style-driven, the same way timeframe is (Agent Creation §8) — a scalp signal can be stale within minutes, a swing signal can stay live for hours; the exact mapping is part of Task 5.

**No new subsystem needed.** The Judge already produces `invalidators` (§18) as narrative text (e.g. "momentum breakdown + significant OI unwind"). Promote these into the same structured condition format already used for retrigger conditions (`{ type: "price_below", value: X }`, Event Architecture §10), and the existing tick monitor — already watching for retriggers and TP/SL hits — watches signal invalidation conditions too. Same monitor, third responsibility.

---

## 37. Trading Agent Lifecycle

Each TradingAgent created by a user has its own lifecycle — this is a single state machine per agent (not per symbol it watches), because a TradingAgent owns one shared paper portfolio (§14) across every symbol in its universe, not one portfolio per symbol.

```text
IDLE           → default baseline state. No active signal on any watched symbol.
                 Running its normal per-symbol analysis triggers (CADENCE/EVENT/
                 CONDITIONAL, §7), waiting for something to fire.

WATCHING       → a signal exists on one of its watched symbols (Signal Lifecycle
                 §36, ACTIVE state) and hasn't been converted to a trade setup yet.
                 The agent is now watching that signal's specific lifecycle
                 conditions — TTL, invalidators, retriggers — via the tick monitor,
                 not just running baseline analysis. Returns to IDLE if the signal
                 EXPIREs or is INVALIDATED without reaching entry.

PENDING_ENTRY  → Trade Planner produced a setup with entryType LIMIT (Part III §4);
                 entry not yet filled. Order expires and reverts to WATCHING if
                 unfilled within the configured window. MARKET entries skip
                 straight to IN_TRADE.

IN_TRADE       → holding a position. Which symbol is an attribute of this state,
                 not a separate lifecycle — the agent keeps analyzing its other
                 watched symbols in the background while IN_TRADE, so it doesn't
                 miss signals elsewhere, but the Trade Planner can't convert a new
                 signal into an actual position on another symbol until the agent
                 has capacity again (see max concurrent positions below).

COOLDOWN       → position just closed; pausing before returning to IDLE.

BLOCKED        → external stop (daily loss limit hit, risk kill-switch, data feed
                 down) — independent of any single symbol.
```

**Max concurrent positions** (config field, default 1) governs capacity: while `IN_TRADE`, the agent can still open a second position on a different watched symbol only if under this limit; otherwise it stays `WATCHING` on that symbol (`SIGNAL_ACTIVE` was a stray name; the state list above is authoritative) until capacity frees up (current trade closes, or it's below the configured max). *(MVP resolution, audit-2 sync: for the initial release both `maxConcurrentPositions` and `universe.length` are FIXED at 1 per perp agent — one agent, one coin, one open position. The multi-position semantics above stay valid as documentation and will apply again when the fixed constraints are relaxed. Consequences: the `maxCorrelatedExposure` cap below rarely binds, and the capacity-refusal branch in the entry orchestrator is defensive for future scale rather than a common path today.)*

### Portfolio-level risk (resolved — was previously per-trade only, and referenced but unspecified)

Two gaps here. First: max concurrent positions is a raw count, and a raw count is misleading when the watched universe is correlated — BTC/ETH/SOL perps commonly move together (~0.8 correlation isn't unusual), so "3 concurrent positions" can functionally be one oversized leveraged bet, not three independent ones. **Required addition**: a `maxCorrelatedExposure` config, capping total notional (or total risk budget, §35) across positions whose underlying symbols exceed a configured correlation threshold — not just capping position *count*. Exact correlation computation/threshold is a Task 5 detail; the requirement is that the cap exists and is enforced at the Trade Planner / Risk Engine gate, same enforcement point as the leverage/liquidation and min-R:R checks.

Second: `BLOCKED` already names "daily loss limit hit" as a trigger, but that limit was never actually specified as a real config field anywhere. **Resolved**: `dailyLossLimit` (a config field on TradingAgent, e.g. as % of account balance or absolute $) is tracked cumulatively across the agent's paper portfolio per trading day; crossing it transitions the agent to `BLOCKED` for the remainder of that day regardless of any individual trade's own R:R being fine. This is a portfolio-level circuit breaker, independent of and in addition to the per-trade risk gates already defined in the Trade Planner (§35).

---

## 38. Working Name


Temporary name:

**Trading Intelligence Platform**

Do not spend time branding yet.

The architecture and research methodology are more important.

---

## 39. Final Mental Model


The entire platform can be reduced to:

```text
                OBSERVE
                   ↓
                DISCOVER
                   ↓
                 RANK
                   ↓
               MONITOR
                   ↓
                SIGNAL
                   ↓
               CORRELATE
                   ↓
                ANALYZE
                   ↓
                 SCORE
                   ↓
                PREDICT
                   ↓
               SIMULATE
                   ↓
                MEASURE
                   ↓
               ATTRIBUTE
                   ↓
                 LEARN
                   ↓
                UPDATE
                   │
                   └──────────→ OBSERVE
```

The objective is to build a **measurable intelligence system**, not merely an LLM wrapper or a collection of bots.


# PART II — MEMECOIN DOMAIN

## 1. Memecoin Agents
Initial candidates:

1. Smart Money Agent
2. Wallet Intelligence Agent
3. Convergence Agent
4. Token Risk Agent
5. Momentum Agent

Potential future agents:

- New Launch Agent
- Liquidity Agent
- Volume Anomaly Agent
- Holder Distribution Agent
- Social/Sentiment Agent

(Common agents like Risk, Momentum, and Market Regime — potentially reusable across domains — are defined in the general Agent Types section.)
## 2. Wallet Intelligence


This is the primary memecoin intelligence subsystem.

The system should answer:

> Who is worth watching?

Initially, wallets can be manually seeded.

Later, wallet discovery should be automated.

Pipeline:

```text
Observed blockchain activity
        ↓
Candidate wallet
        ↓
Historical reconstruction
        ↓
Performance analysis
        ↓
Wallet scoring
        ↓
Smart-money universe
        ↓
Continuous monitoring
```

Do not blindly copy whales.

A large wallet is not necessarily a useful wallet.

The system should measure:

- total trades
- wins/losses
- win rate
- median return
- average return
- profit factor
- holding time
- early-entry edge
- trade size
- consistency
- drawdown
- memecoin specialization
- behavior by market regime
- behavior by token age
- behavior by holding horizon

---

## 3. Early-Entry Edge


This should be a first-class metric.

For each wallet trade, evaluate future market behavior at multiple horizons:

- 5m
- 15m
- 30m
- 1h
- 6h
- 24h

Example:

```text
Wallet enters
5m  → +4%
15m → +13%
1h  → +31%
6h  → +8%
24h → -12%
```

This tells us that the wallet may be useful as an early-entry signal even if a 24h holding period is poor.

Do not reduce wallet quality to win rate alone.

---

## 4. Wallet Scoring


Initial conceptual score:

```text
Profitability              20%
Win Rate                   15%
Early Entry Edge           25%
Consistency                15%
Memecoin Specialization    10%
Trade Quality              10%
Corroboration               5%
                           ----
                           100%
```

These weights are NOT final.

The system should make scoring configurations versioned and testable.

We should eventually validate weights against out-of-sample historical performance.

Avoid over-trusting tiny samples.

Use statistical smoothing / Bayesian-style adjustment where appropriate.

Example problem:

```text
Wallet A:
2 trades
2 wins
100%

Wallet B:
500 trades
350 wins
70%
```

Wallet A should not automatically outrank Wallet B.

### Backfill on add (fixes a gap — new wallets do not start blank)

When a wallet address is added (manually, per Wallet Discovery Roadmap §11), the system pulls that wallet's existing historical transaction/trade record from the provider (Helius supports historical parsed transactions per address on demand — this is a normal per-wallet lookup for **wallet scoring**, entirely distinct from the bulk market-wide historical-archival replay that Setup Memory seeding would need, which is scoped out for memecoin, §25 — see the "two different uses of historical" block there) and runs the Wallet Scoring formula above against it immediately, writing the first `WalletScoreEvent` at add time. A newly-added wallet is scored from whatever real history it already has, not from zero. From that point on, the normal trigger (N new trades, or a scheduled recompute) takes over and keeps the score current as the wallet keeps trading.

**The seed set is also a behavioral dataset, not just a scoring input.** An initial roster of
~100 wallets is being seeded at launch. Beyond scoring each wallet, that same backfilled history
is the empirical basis for four tunables the doc otherwise leaves as guesses — measure them
from the seed data rather than picking blind:

- **Selection batching window (§9a)** — when these wallets converge, over what time span do the
  buys actually land (median gap between first and last buy in a real convergence cluster)? That
  span *is* the debounce window; too short fragments a genuine convergence into weak partials,
  too long burns a tight TTL (10–30m, §8). Default 5000ms is a placeholder.
- **`walletExitThreshold` (§10)** — how often does a partial cluster-sell precede a full dump
  versus resolve as a false alarm? Sets where the exit accumulator should trigger. Default 0.9
  is a placeholder chosen for the "hold until essentially the whole cluster gives up" style.
- **Design-1-vs-Design-2/3 exit (§10)** — do these wallets dump all at once (binary Design 1
  captures it correctly) or trim in stages (proportional Design 2 / re-analyze Design 3 would
  capture real edge)? Currently on Design 1; Design 2/3 remain open, decidable from this data.
- **Profit-ladder rung levels (§10)** — for each historical wallet-cluster buy that reached
  ≥ 2×, what fraction went on to reach 3×, 5×, 10×? Distributions like "38% reached 2×, 17%
  reached 3×, 6% reached 5×" tell you where the rungs should sit (a rung at a level almost no
  trade reaches contributes nothing; a rung too close to entry gives up too much upside).
  Default rungs 2×/3×/5× with 50%/25%/15% sellFractions are placeholders.

A one-off analysis pass over the seed history feeds concrete numbers into all four before the
live path is built.

### Point-in-time scores (required for correct backtesting)

Backtesting requires "wallet X's score as of time T" — but scores get updated from outcomes over time, so evaluating a historical prediction at T using today's score would leak future information into the backtest (silent look-ahead bias). Neither snapshotting a full score per raw event (too much storage — scores don't change nearly as often as raw trade events arrive) nor re-deriving from scratch on every query (too slow) is the right fix.

**Resolved approach: append-only score-change log**, not a snapshot-per-event and not full re-derivation:

```ts
interface WalletScoreEvent {
  walletId: string;
  timestamp: string;
  newScore: number;
  inputsUsed: Record<string, number>;  // the feature values that produced this score
}
```

A new row is written only when a wallet's score is actually recomputed (on a trigger — e.g. after N new trades, or on a daily job — not per raw event), so this log is naturally sparse relative to raw trade volume. **"Wallet X's score as of T" = the latest `WalletScoreEvent` for that wallet with `timestamp <= T`** — a fast indexed lookup, not a replay of raw trades.

**Hard rule** (also added to Planning Rules, §33): no code path may use "current wallet score" during backtesting or historical evaluation — only "wallet score as of T" via this log. This needs to be enforced structurally (e.g. the backtesting data-access layer should not expose a "current score" method at all), since it's easy to violate accidentally from any code path that does a live lookup by mistake.

---

## 5. Wallet Convergence


A major memecoin feature.

Example:

```text
Wallet A ─┐
Wallet B ─┤
Wallet C ─┼──> TOKEN X
Wallet D ─┤
Wallet E ─┘
```

The system should detect:

- number of wallets
- wallet quality
- total capital/value
- time window
- independence/correlation
- average wallet score
- weighted convergence score

Important:

Do not count ten related wallets as ten independent signals.

### Interim heuristic: funder clustering (needed before convergence means anything)

Full coordinated-wallet detection (ML-based clustering) is deferred, but convergence scoring is meaningless without *some* dedup from day one — this can't wait for a later milestone. Interim heuristic, buildable now from data already being ingested (no new provider needed):

**Funder clustering**: walk back each wallet's first-hop SOL funding source (the address that sent it its initial/most recent funding). Wallets sharing a funder within a time window (e.g. 24–72h) are grouped into one cluster. Convergence counts **funder clusters**, not raw wallet addresses — five wallets funded from the same source buying the same token collapses to one signal, weighted by the cluster's combined quality, not five independent ones.

A secondary heuristic worth adding once the primary is working: shared first-hop CEX withdrawal address (wallets that all withdrew from the same exchange account). Full ML-based coordination detection remains a future feature on top of this.

---

## 6. Token Intelligence


Each token should have a continuously updated profile.

Metrics may include:

- age
- liquidity
- volume
- market cap
- price
- volatility
- unique buyers
- unique sellers
- holder concentration
- smart-money activity
- wallet convergence
- momentum
- signal freshness
- abnormal activity

For memecoins, token risk should be a first-class part of the score.

---

## 7. Memecoin Data Providers
For Solana/memecoin research, we need a blockchain data provider/RPC layer capable of:

- wallet activity
- transaction history
- parsed swaps
- token transfers
- token metadata
- account monitoring
- real-time event delivery where possible

Potential provider categories include Solana RPC/data providers such as Helius, QuickNode, Alchemy, Triton, etc.

### MVP provider decision: Helius, free tier

Since memecoin does not use historical backtesting/Brain Seeding in this MVP (§25, Task 4 §34) — that requirement is scoped out entirely — provider selection only needs to satisfy **live watching**, which is a meaningfully lighter bar than originally scoped. **Resolved: Helius, free tier (30M compute units/month)** — Solana-native, webhooks for wallet activity monitoring, enhanced/parsed transaction APIs (decoded swaps, not raw instruction data). This directly covers Wallet Intelligence's (Part II §2) needs for MVP. Revisit provider choice (and re-open the historical-data question) only if memecoin backtesting/seeding is taken up as a future-phase decision.

Provider selection was researched based on:

- parsed transaction quality
- WebSocket/webhook support
- rate limits
- pricing
- reliability
- Solana support
- token/DEX coverage

Do not hard-code provider-specific responses throughout the application.

Create a provider adapter interface.

## 8. Memecoin Brain Memory Types
## Wallet Memory

Historical wallet behavior.

## Token Memory

Historical token/setup behavior.

## Setup Memory

Performance of combinations of features.

Example:

```text
walletScore > 80
+
convergence >= 5
+
strong momentum
+
bullish regime
```

Then store:

```text
Occurrences
Success rate
Median outcome
Drawdown
Horizon-specific performance
```

### Fingerprinting method (resolved — applies to both memecoin and perp Setup Memory)

"Feature combinations" was previously undefined. With ~8 features × 3 buckets each, that's ~6,500 possible setup cells, most of which will have n<5 — not enough samples to trust. Two options existed: a discretized hash key with shrinkage, or continuous k-NN over feature vectors — these are very different databases and only one should be built.

**Resolved: discretized hash + hierarchical shrinkage**, not k-NN, for the initial version. k-NN is more precise eventually but is a second database and a distance-metric design problem not needed yet — same reasoning as deferring adaptive per-regime scoring weights (Perp Signal Scoring Pipeline, Part III §3).

Mechanism:

1. Bucket each feature into tertiles (low/med/high) or similar. **Memecoin
   uses a 5-feature tuple**: smart-money quality, convergence, momentum, token quality,
   market regime. Early-Entry Edge, Signal Freshness and Historical Edge remain in the
   Opportunity Score composite but are dropped from the fingerprint, giving 3⁵ = 243 cells
   instead of ~6,500. Combined with the lowered trust floor (effective-n ≥ 10, below),
   this is what makes cell-level trust reachable given one position at a time (§32) and a
   30-day half-life. Perp keeps its full tuple — it is seeded and has no concurrency cap of 1.
2. `setupId` = hash of the bucketed feature tuple.
3. When a cell has **effective-n < 10** (recency-weighted effective-n, the same unit Wilson uses below; never the raw occurrence count), back off recursively to a coarser fingerprint — drop the least-informative feature or widen buckets — down to a global base rate if nothing else has enough samples. **The n≥10 floor is Setup Memory's own trust bar; hypothesis eligibility (§24) uses a separate, higher n≥20 bar — see the split rationale there.**

This is a single deterministic function, easy to test, and consistent with the doc's general bias toward shipping the deterministic version first and adding continuous/ML refinements later once there's enough data volume to justify them.

**Explicitly rejected: a separate weighted-similarity-score system** (empirically-tuned per-feature weights, continuous `similarity >= 0.80` threshold). This is functionally the same complexity as the k-NN option already rejected above, just dressed as a score instead of a distance metric — it requires validating a weight vector before anything can ship, and the hierarchical backoff already solves "how similar is close enough" as a discrete staircase (exact fingerprint → drop least-informative feature → coarser bucket → global base rate) at a fraction of the cost. Backoff remains the *only* similarity mechanism for the initial version.

**Regime requires no separate handling** — `REGIME` (bull/bear/range) is already one of the bucketed dimensions in the fingerprint tuple itself, so a bull-market setup and an otherwise-identical bear-market setup already hash to different `setupId`s. This falls out of the fingerprint design for free.

### Confidence intervals, not bare win rates

A bare win rate is misleading at low sample sizes — "74% from 18 trades" and "67.5% from 1,842 trades" are not comparable confidence, even though the first number looks higher. Every `BrainSetupMemory` row (Database Design, §13) stores a **Wilson score interval** alongside the point estimate (Wilson, not a naive normal approximation — it stays well-behaved at small n and near 0%/100%, which a normal approximation doesn't). The Signal Scoring Engine and Judge read the interval, not just the point estimate, when weighing historical edge — a wide interval should carry less weight in the composite score than a narrow one, even at the same win rate.

### Wilson CI must use effective-n, not raw occurrence count (resolved — was previously an unreconciled conflict with recency decay)

Wilson's interval math is defined on integer win/loss counts, but Recency decay (below) means occurrences don't count equally — an old occurrence contributes less than a fresh one. Feeding Wilson the raw occurrence count while the win rate itself is computed from recency-weighted contributions is inconsistent and silently understates uncertainty (raw n looks bigger than the data actually supports). **Resolved**: Wilson's `n` and win count must both be the **recency-weighted effective values** — `effectiveN = sum of recency weights across all occurrences`, `effectiveWins = sum of recency weights for winning occurrences only` — not raw counts. This keeps the interval honest: a fingerprint with 1,000 old, heavily-decayed occurrences and 20 recent ones should report a CI closer to what 20-ish fresh samples would justify, not what 1,020 raw samples would.

### Recency decay

Setup Memory currently has no time dimension — a 2019 occurrence and last week's occurrence count identically. Fixed: each occurrence contributes to `BrainSetupMemory`'s aggregate stats with a recency weight (older occurrences count less, not deleted — the full history stays queryable, only its influence on the current live estimate decays). Exact decay function (e.g. exponential half-life) is left to Task 6 (Define Brain mathematically).

### Explicit "insufficient evidence" state

Below the `n < 10` backoff threshold, the Brain must not silently return the exact fingerprint's thin numbers dressed up as confident. It returns an explicit state:

```json
{
  "evidence": "INSUFFICIENT",
  "exactOccurrences": 7,
  "observedWinRate": 0.86,
  "fallback": "parent-bucket (BULL + STRONG_MOMENTUM)",
  "fallbackWinRate": 0.66
}
```

rather than surfacing `86%` on its own — this is what actually prevents the Brain from being fooled by a small, lucky sample, and it's a visible, distinct output state, not a silent internal backoff the rest of the system can't observe.

(Agent Memory and Market Memory are shared platform concepts — see the general Brain Memory Types section.)
## 9. Opportunity Score


Conceptual memecoin score:

```text
Smart-money quality       25%
Convergence               20%
Early-entry edge          15%
Momentum                  15%
Token quality             10%
Market regime              5%
Signal freshness           5%
Historical setup edge      5%
                           ----
                           100%
```

Scores should be explainable:

```text
TOKEN X
Score: 87

Smart Money       +22
Convergence       +18
Early Entry       +14
Momentum          +12
Token Quality      +8
Market Regime      +5
Freshness          +4
Historical Edge    +4
```

(The perp domain uses its own Signal Scoring Pipeline instead — see the Perp Signal Scoring Pipeline section.)

---

## 9a. Multi-Agent Selection & Token Claim (resolved — was previously unspecified)

The scoring sections (§9 above / Part III §3) define how *one* TradingAgent scores *one*
opportunity. They never defined what happens when several opportunities arrive at once, or
when several TradingAgents compete for the same one. Three concrete scenarios exposed the gap:
N idle agents facing one converged token, N idle agents facing many distinct tokens, and a
mixed batch. This section resolves all of them with one fan-out model, one selection policy,
and one platform-wide claim rule.

### Buy events fan out; there is no central allocator

A `memecoin.wallet.buy.detected` event is **offered to every TradingAgent whose domain and
universe match** — it is not routed to a single "chosen" agent. Each agent decides
independently against its own config. The platform never picks a global "best token"; it
only ever asks, per agent, "does *this* agent take *this* signal?"

Eligibility cascade, applied per agent, in order:

```text
1. DOMAIN filter   → a memecoin event never reaches a perp agent (canHandle, §6).
2. UNIVERSE filter → the token's chain must be in the agent's universe.
3. HARD GATES      → Token Risk veto (§9), maxPoolShare cap (§10), min-position-size floor.
                     A signal that trips any of these for this agent is dropped for this
                     agent only.
4. THRESHOLD       → the agent's own signalThreshold on OpportunityScore.
```

Only signals surviving all four are candidates for that agent.

### Wallet buys collapse into signals before any of this runs

Selection operates on **signals, not raw buys.** Funder-cluster dedup (§5) runs across the
whole event batch first:

- Many wallets buying the **same** token → **one** signal, with convergence strengthened by
  the independent-cluster count. Ten wallets into one token is one strong signal, not ten.
- Wallets buying **distinct** tokens → **one signal each**, convergence thin (single cluster),
  leaning on smart-money quality / momentum / token quality instead.
- Dedup is **batch-wide, not per-token**: a wallet in the "distinct tokens" group that shares
  a funder cluster with a wallet in a converged token does not create independent evidence —
  it folds into the existing cluster. (Test case worth writing explicitly.)

### Claimed-token pre-filter runs before the batching window (resolved — explicit pipeline stage, not just implied by the claim rule)

The platform-wide token claim (§9a, further down) prevents two agents from *holding* the same
token concurrently, but that rule is enforced at the assignment step — by then the buy has
already ridden through the batching window and the funder-cluster dedup pass. That's wasted
work when the answer is guaranteed to be "drop": if the token is already claimed (some agent
is holding it right now), no eligible agent can take it regardless of score, so processing
the buy at all is pointless.

**Add an explicit pre-filter, at the front door**, before the buy enters the batching pen:

```text
memecoin.wallet.buy.detected arrives
      ↓
IS THE TOKEN ALREADY CLAIMED PLATFORM-WIDE?
   ├─ YES → drop immediately, do not enter the batching pen
   └─ NO  → drop into batching pen (window below)
```

This is cheap — a single indexed lookup on the active-claim table (§29 unique constraint on
`token_id` where `releasedAt is null`). Dropping here saves the buy from consuming batching
window slots, funder-cluster dedup work, scoring cycles, and — most importantly — from
falsely inflating the convergence count on a token no agent could enter anyway.

**What this does NOT filter:**

- Buys on a token that some agent is *watching* but not yet holding (Signal Lifecycle
  ACTIVE state, §36) — those still enter the pen, because a `WATCHING` state does not
  hold the token claim (the claim is only taken at IN_TRADE, §9a).
- Buys on a token whose claim was just released this same tick (position closed) —
  those correctly re-enter the pipeline as new opportunities, no special-case handling.

The pre-filter is purely a "someone is currently holding this" check, nothing more.

### Per-agent selection policy (the §9 gap)

An agent with a free slot (`maxConcurrentPositions`, §32 — memecoin default 1) that sees
several eligible signals in one TTL window picks deterministically:

```text
gate-filter (cascade above)
      ↓
rank survivors by  OpportunityScore × confidence
      ↓
take top 1 → MARKET entry → WATCHING → IN_TRADE
      ↓
remaining survivors stay ACTIVE; agent may claim one later if a slot frees before their TTLs
```

`confidence` already folds in agent-agreement and Setup Memory Wilson-width (§8), so the
ranking key rewards both strength and evidential reliability. **No speculative waiting:** an
agent acts on the best *currently eligible* signal or takes nothing — it never holds a slot
open hoping for a better signal later in the window. Speculative waiting is unbacktestable
(replay can't reconstruct what it was hoping for) and violates the deterministic-action bias.
The LLM is **not** in this path — selection is ranking, ranking is arithmetic (Rule 13).

### Two ways to run multiple agents — deliberately distinct

- **Same config, multiple agents = a capacity pool.** This is how a user trades N memecoins
  at once under **one** risk profile, given memecoin's one-position-at-a-time rule (§32).
  Five identical agents = five concurrent slots. (Chosen over raising memecoin
  `maxConcurrentPositions` above 1, which §32 keeps load-bearing for Setup Memory
  attribution.)
- **Different configs, multiple agents = competing strategies (A/B).** Each answers "did
  *this* config work?" via its own clean track record (§14/§32).

Both are legitimate and both are subject to the same claim rule below.

### Single platform-wide token claim (product rule)

**No two of the user's TradingAgents may hold the same token at the same time, regardless of
config.** Two agents sitting in the same coin is accidental doubling, not diversification, and
is not a book the user wants to see. Mechanism:

- One claim table, **token-keyed, held platform-wide across all TradingAgents.** Entering a
  token claims it; the claim releases the instant the position closes on **any** of the four
  exit conditions (§10) — a token is locked only while actually held, never for its whole TTL.
- Every agent — same-config sibling or different-config — treats a claimed token as
  unavailable and drops to its next-best eligible signal.

This makes the same-config-fleet case and the different-config case **one mechanism**, not two.

### Contention: highest-ranked-for-that-token wins, resolved as a global assignment

When several agents contend for the same token in the same instant, the agent that **ranks
that token highest** wins it; losers cascade to their next-best eligible signal. This must be
resolved as an assignment across the **whole contended set**, not token-by-token — greedy
per-token resolution strands agents:

```text
Agent 1: X=0.90, Y=0.85     Agent 2: X=0.80, Y=0.40

Token-by-token (WRONG): resolve X → Agent 1 wins X; Y left for Agent 2 @ 0.40.  total 1.30
Global assignment (RIGHT): Agent 1 → Y (0.85), Agent 2 → X (0.80).              total 1.65
```

Resolution rule (deterministic greedy assignment):

```text
repeat:
  take the single highest (agent, token, score) pair still available
  assign it — agent enters token, token is claimed
  remove that agent AND that token from the pool
until no eligible (agent, token) pair remains
```

Tiebreak on equal scores: creation order (fully reproducible). This is greedy, not the
theoretical optimum a full bipartite matching would give — deliberately, per the doc's
ship-deterministic-first bias. Optimal matching is a later refinement that almost certainly
never matters at ~5 agents.

Edge cases:

- **Every token an agent ranks above threshold is already claimed** → the agent takes nothing
  this cycle, stays IDLE/WATCHING, remains eligible for the next signal. It is never forced
  into a token it didn't actually want.
- **Different-config over-exposure** is handled separately by `maxCorrelatedExposure` (§37) at
  the account level — the claim rule prevents *same-token* overlap; the correlation cap
  prevents *different-but-correlated-token* over-concentration. They are complementary, not
  redundant.

### Batching window (resolved with placeholder default, revisit after seed-history analysis)

Global assignment assumes the contending signals are evaluated together as a batch, but buys
arrive as a stream. A short debounce window on `memecoin.wallet.buy.detected` — collect for a
few seconds, then resolve one assignment pass — is the intended approach; resolving
incrementally per arrival reintroduces the greedy-stranding above.

**Placeholder default: `batchingWindowMs = 5000` (5 seconds).** Lives in `ScoringConfig`
(§8), tunable per TradingAgent, versioned like every other scoring input. This is a starting
number to unblock the selector build — not the answer. The empirically-correct value comes
from the 100-wallet seed-history analysis pass (Part II §4 backfill): measure the distribution
of `last_buy_time − first_buy_time` across historical convergences of 3+ seed wallets on the
same token, and pick a window that captures the bulk of that distribution (e.g. the 80th or
90th percentile) without burning more than a small fraction of the memecoin Signal TTL
(10–30m, §8). If that analysis says 6s or 8s catches most real convergences, update the
default there. The 5s starting value is a defensible round number in the middle of the
expected range, no more.

Bounded below by the domain's tight Signal TTL — a window of 30s+ eats meaningful edge on a
signal that decays in minutes. Bounded above by detection cost — a window of 1s effectively
disables batching. Anywhere in the 3–15s range is reasonable pending real data.

### The four scenarios under this rule

```text
1. 5 idle agents, 10 wallets → 1 token
   → dedup to ONE strong converged signal. One agent claims it (highest-ranked wins).
     The other four find other live signals or stay idle. No overlap.

2. 5 idle agents, 10 wallets → 10 distinct tokens
   → 10 signals. Global assignment hands each of up to 5 agents a DISTINCT token,
     each the best still-unclaimed fit for that agent. 5 tokens covered, no overlap.

3. 5 idle agents; 2 wallets→A, 3 wallets→B, 5 wallets→5 distinct tokens
   → dedup to 7 signals (A converged, B converged-stronger, + 5 thin singles).
     A and B tend to out-rank the singles (convergence weight, §9), so agents cluster
     onto the strongest distinct signals; assignment guarantees no two share a token.

4. Same-config capacity pool (5 identical agents), any of the above
   → identical rankings, but the claim rule + global assignment still spread them across
     distinct tokens instead of all piling onto the single #1. This is what makes
     "5 agents = 5 different tokens, one risk profile" actually work — without the claim
     rule, identical agents would all pick the same token.
```

Note: `PENDING_ENTRY` is structurally unreachable in memecoin (MARKET-only entry, §10), so a
claimed token goes `WATCHING → IN_TRADE` directly and the claim is held from fill to close.


## 10. Memecoin Trade Planner (entry, exit, sizing)

Part I §35 and Part III §4 assumed a planner that derives entry zones, stops and targets
from ATR and recent support/resistance. **Neither exists for a token that is minutes old**,
and there are no limit orders on an AMM without a keeper. Memecoin therefore gets its own
planner. It is deliberately simpler than the perp one, because the wallets *are* the
thesis: they tell us when to get in and, more usefully, when to get out.

### Entry — MARKET only

No entry zone, no LIMIT, no `PENDING_ENTRY`. Convergence edge decays within minutes
(Signal TTL is 10–30m for a reason), so waiting for a better price is self-defeating, and an
AMM has no resting-order primitive to wait with. A memecoin TradingAgent transitions
`WATCHING → IN_TRADE` directly; `PENDING_ENTRY` is structurally unreachable in this domain
and that is expected, not a missing feature.

Fill price comes from the depth-aware AMM model (§20 / Task 5) against actual reserves at
the execution tick. If reserves are unavailable the position does not fill.

### Exit — five conditions, in strict precedence order (resolved — profit ladder added between wallet-exit and horizon)

```text
1. STOP LOSS       price ≤ current_stop_price                  [tick monitor]
                   (initially fill × (1 − stopPct); may be raised
                    by profit-ladder postTakeAction)
2. WALLET EXIT     ≥ walletExitThreshold of the triggering     [event pipeline]
                   funder-clusters' weighted position has sold
                   default walletExitThreshold = 0.9
3. PROFIT LADDER   price crosses the next unfired ladder rung  [tick monitor]
                   → partial close, may adjust stop
4. TAKE PROFIT     price ≥ fill × (1 + takeProfitPct)          [tick monitor]
                   (single-level TP; only active if profitLadder is null)
5. HORIZON EXPIRY  the style horizon elapses                   [scheduler]
```

**"Full close" semantics** (applies to STOP LOSS, WALLET EXIT, TAKE PROFIT, HORIZON EXPIRY):
"full close" means **close 100% of what is currently held**, not 100% of the original entry
notional. After the profit ladder has taken partial fills, "full close" closes only the
remainder. This must be explicit in the paper-engine code to prevent negative-size fills.

**Wallet exit is the primary downside-thesis exit, and it is the whole point of this domain.**
We already ingest wallet sells; a system that watches smart money in and ignores smart money
out is throwing away its best signal. It fires on cluster *weight* sold, not wallet count —
the same funder-cluster dedup used for convergence (§5), so one funder dumping through five
addresses is one exit, not five. Requires a new event: `memecoin.wallet.exit.detected`,
consumed by the event pipeline rather than the tick monitor, since sells arrive as provider
webhooks.

Stop loss ranks above wallet exit because a rug or a dump can outrun webhook latency. Wallet
exit ranks above the profit ladder deliberately: if the smart wallets have essentially given
up, close everything remaining now — do not leave a "moon bag" that no smart money is
watching. The profit ladder sits above the single-level TP because when a ladder is
configured, TP is null (they are mutually exclusive), and above horizon because in-flight
partial closes should happen before the wall-clock timer fires.

**Default `walletExitThreshold = 0.9`** (resolved). Interpretation: "essentially the whole
cluster has given up." Rationale for 0.9 rather than 1.0: real wallets sometimes keep a
5–10% moon bag indefinitely; requiring 100% weight-exit would leave your position open
forever in the common case. Rationale for 0.9 rather than 0.5: the profit ladder now handles
upside profit-taking (see below), so wallet-exit no longer needs to fire early to lock in
gains — it can stay conservative and function as "the smart money has bailed" thesis-death
signal only. Trade-off: with a threshold this high, a slow bleed with wallets trimming (but
none fully exiting) will not fire wallet-exit — it will ride down to the stop instead. That
is deliberate; the stop is designed to catch it.

### Profit ladder — tiered profit-taking based on your own P&L (resolved — replaces single-level TP)

The single-level `takeProfitPct` model has an obvious weakness for memecoin: many runners
that reach 2× keep going to 5× or 10×, and a naive 60% TP clips those winners at the worst
possible moment. Conversely, holding entirely until wallet-exit or a stop leaves realized
P&L to chance in extremely volatile tokens. The plan resolves this with a **configured
profit ladder**: a list of rungs, each specifying a price multiple, a fraction to sell when
reached, and an optional stop adjustment.

**Config shape** (`ScoringConfig.profitLadder`, memecoin only):

```json
[
  { "at": 2.0, "sellFraction": 0.50, "postTakeAction": "move_stop_to_breakeven" },
  { "at": 3.0, "sellFraction": 0.25, "postTakeAction": null },
  { "at": 5.0, "sellFraction": 0.15, "postTakeAction": null }
]
```

Reading the default: at 2× fill price, sell half the position and raise the stop to entry
price (the remaining half is now a risk-free ride — worst case, breakeven). At 3×, sell
another quarter. At 5×, sell another 15%. Cumulative sold across all rungs: 90%. Remaining
10% is the "moon bag," held until wallet-exit, stop, or horizon fires.

**`postTakeAction` values supported in MVP:**

```text
null                       → no stop adjustment; keep prior stop
move_stop_to_breakeven     → raise stop to entry price (protects remainder from becoming a loss)
trail_stop_pct: X          → after this rung fires, stop trails price by X% (follows up, never down)
```

`trail_stop_pct` is optional and more sophisticated than `move_stop_to_breakeven`; both are
valid MVP behaviours.

**Rung firing rules:**

- Rungs fire in ascending `at` order, each at most once per position.
- The tick monitor watches for `price ≥ fill × rung.at` on every tick, same infrastructure
  that watches SL / TP (§20).
- When a rung fires: sell `rung.sellFraction × original_position_size`, then apply
  `postTakeAction` to the stop if defined, then mark the rung as fired on this position.
- Skipping rungs is allowed — if price gaps from 1× directly to 2.5×, only the 2× rung
  fires on that tick (the 3× rung is still unfired and waits for `price ≥ 3×`).
- Multiple rungs firing on the same tick (a big gap up past several) fire in ascending order,
  each closing its own fraction of the *original* position size — cumulative
  `sellFraction` across all rungs cannot exceed 1.0 (validated at config-write time).

**Backward compatibility with single-level TP.** When `profitLadder` is `null`, the old
`takeProfitPct` behaviour applies unchanged — a one-rung `[{ at: 1 + takeProfitPct,
sellFraction: 1.0, postTakeAction: null }]` and the position full-closes at the target.
Existing configs migrate implicitly; no schema break.

**Interaction with `minRR`.** With a laddered TP, "reward" for R:R purposes is the
size-weighted average of the ladder rungs. `minRR` still validates once at agent creation as
before, but against the weighted-average target implied by the ladder rather than a single
level. If the ladder is malformed (rungs out of order, cumulative `sellFraction > 1.0`), the
Trade Planner rejects the config at creation, not at trade time.

**Interaction with wallet-exit after partial ladder fills.** If a ladder rung has fired and
subsequently wallet-exit crosses threshold, wallet-exit full-closes the *remainder*, not
the original position. Worked example: entry at 1×, price hits 2× → rung 1 fires, sell 50%,
stop moves to breakeven, 50% held. Wallets dump. Wallet-exit fires and closes the remaining
50% at the detection-lag-priced price. Final position record:

```
Fill 1: 2.0×  size 50%  reason: LADDER_RUNG_1
Fill 2: X×    size 50%  reason: WALLET_EXIT      (X = price at detection)

exitReason on the PaperPosition row: WALLET_EXIT (the closing reason)
weighted_avg_exit = 0.5 × 2.0 + 0.5 × X
```

Same shape for a stop that fires after ladder rungs — the moved-to-breakeven stop closes the
remainder at 1× in the worst case, giving a size-weighted average of `0.5 × 2.0 + 0.5 × 1.0 =
1.5×`, still a winner overall. That is the entire point of the breakeven-stop pattern.

**Default ladder rung levels are placeholders** — same status as `batchingWindowMs` and
`walletExitThreshold`. Concrete values come from the 100-wallet seed-history analysis pass
(Part II §4 backfill): for each historical wallet-cluster buy that reached ≥ 2×, what
fraction went on to reach 3×, 5×, 10×? Distributions like "38% reached 2×, 17% reached 3×,
6% reached 5×, 1.8% reached 10×" tell you where the rungs should sit (a rung at a level
almost no trade reaches contributes nothing; a rung too close to entry gives up too much
upside). See Part II §4 backfill for the full seed-analysis question list.

### Partial-exit awareness (resolved — Design 1: partial *wallet-sell* detection, binary action)

The profit ladder above handles **your** partial exits based on your P&L. This subsection
handles the separate concern of detecting **wallet** partial sells so `walletExitThreshold`
knows what to accumulate. The two are independent — a ladder rung firing does not consume
wallet-sell information, and a wallet partial-sell does not automatically move your position.

"Cluster weight sold" must account for partial sells, not just whole-position dumps. Two
kinds of partial exist and both are detectable for free from the Helius parsed-swap webhooks
already ingested (a sell is a swap in the opposite direction, and the parsed transaction
carries the **amount**):

```text
(a) one wallet in the cluster sells while others hold
(b) a single wallet sells PART of its own position (e.g. 40%, keeps 60%)
```

Detecting (b) requires **per-wallet in-trade position tracking**: when the cluster bought in,
each wallet's entry size was recorded; each subsequent sell is compared against that wallet's
tracked remaining balance to compute the fraction sold. This turns "a wallet sold (boolean)"
into "a wallet sold 40%," which is what the accumulator needs.

**The tracking table** (`PaperPositionOriginatingWallet`, §13): every wallet that
contributed to the entry signal creates a row on the position, storing `entryUsd`,
`entryWeight`, `entryScore` (point-in-time, rule 21), and `currentHeldFraction` (starts at
1.0, decrements as the wallet sells). This is the permanent per-wallet record — retained
after the position closes for autopsy, performance attribution ("which wallets historically
produced our best trades?"), and future re-analysis if Design 2/3 is ever adopted.

**Mechanism — a running weight accumulator, binary action (Design 1):**

```text
wallet sell webhook (parsed swap, with amount)
   ↓
lookup this wallet's row in PaperPositionOriginatingWallet for each open position
    where this wallet was an originator
   ↓
compare sell amount vs currentHeldFraction × entryUsd (converted to token units)
   → fraction sold this transaction, decrement currentHeldFraction
   ↓
recompute cluster_weight_exited = Σ entryWeight × (1 − currentHeldFraction)
    across all rows for this position
   ↓
cluster_weight_exited / Σ entryWeight  ≥  walletExitThreshold?
   ├─ NO  → record the partial as an OBSERVATION on the position, keep holding,
            no Telegram
   └─ YES → full-close the paper position (whatever is still held after any prior
            ladder fills), exitReason = WALLET_EXIT, Telegram alert
```

So partial *awareness* is everywhere (needed to compute the accumulator correctly, and a
single wallet selling its whole bag or two wallets each selling half both move the
accumulator proportionally), but the wallet-exit *action* stays **binary**: when accumulated
exited weight crosses `walletExitThreshold`, close whatever is still held. A partial that
does not cross the threshold is a recorded observation the dashboard and learning loop can
see — never a Telegram ping (per the clean-feed rule, §11).

**Explicitly deferred — Design 2 (proportional wallet-mirror) and Design 3 (re-analyze on
wallet partial):** mirroring the cluster's sell fraction, or re-scoring the open position when
a partial arrives, would compete with the profit ladder for the "when to sell part" decision
and introduce two separate systems trying to trim the same position on different signals.
Design 1 keeps a clean separation: profit ladder is your P&L exit, wallet-exit is the
thesis-death exit, and never the twain shall cross. Whether Design 2 or Design 3 earns its
complexity is measurable from the seed history (Part II §4) and re-openable as a future
refinement — the observation logs make the counterfactual analysis possible without needing
to have chosen the alternate design.

### Stops and targets — fixed percentage stop, laddered target

```text
stopLoss   = fill × (1 − stopPct)          stopPct default 0.30
                                            (may be raised by ladder postTakeAction, above)
profitLadder                                default: see above (2×/3×/5× default rungs)
takeProfitPct                               default null when profitLadder is set;
                                            single-level TP mode when profitLadder is null
```

All three are `ScoringConfig` fields (§8). Because R:R is fixed by configuration rather than
discovered from market structure, `minRR` in this domain degrades to a config consistency
check (validated once at agent creation — see profit-ladder subsection above for the
laddered R:R interpretation). It is not a per-trade gate and can never veto a memecoin
signal. The vetoes that *do* apply here are the Token Risk hard veto (§9) and the pool-share
cap below.

### Sizing — Part I §35 unchanged, plus a liquidity cap

```text
Risk Budget   = Account Balance × riskPercent
Position Size = Risk Budget / (Entry × stopPct)
```

No leverage — spot. But one memecoin-specific gate that perps do not need:

```text
Notional ≤ maxPoolShare × quote-side pool reserves     maxPoolShare default 0.01
```

Without this, the sizing formula will happily ask for a position that is a meaningful
fraction of a thin pool, and the depth-aware fill model will honestly report catastrophic
slippage on it. Cap first, then fill. If the capped size falls below a usable minimum,
output `NO TRADE — insufficient pool liquidity for a meaningful position`.

### Outcome accounting

WIN/LOSS follows §21. `hitTarget = true` iff the position touched the highest profit-ladder
rung (or the single-level `takeProfitPct`, if ladder is null) before any other exit closed
it out. A wallet-exit, stop, or horizon close records `hitTarget = false` regardless of how
many ladder rungs fired — reaching rung 1 (say 2×) is a partial win, not a target hit; the
`hitTarget` metric is reserved for the trade fully playing out to its highest configured
target.

The realized return is the **size-weighted average across all fills** — each ladder rung
contributes its `sellFraction × exit_price`, and the final full-close contributes its
`(1 − Σ prior sellFractions) × exit_price`. Stored on `PredictionOutcome` as
`weightedAvgExitPrice` alongside the individual fills.

`holdingPeriod` is anchored at T1 (entry) as everywhere else. `exitReason` is recorded on
the position (`STOP | WALLET_EXIT | LADDER_COMPLETE | TAKE_PROFIT | HORIZON`) — first-class
field, since "which exit condition actually earns its keep" is a question the learning loop
must answer directly from Setup Memory + `exitReason` aggregates (no autopsy in MVP for
memecoin — see §24 memecoin scope note; this SQL-level aggregate is the substitute).
`LADDER_COMPLETE` is the exit reason when the ladder's cumulative `sellFraction` sums to
exactly 1.0 (i.e. the ladder was configured to fully exit the position across its rungs and
did so) — distinct from `WALLET_EXIT` or `STOP` closing a leftover moon-bag.

Every individual fill also gets its own row on `PaperPositionFill` (§13):
`{ positionId, fillAt, sizeFraction, price, reason: LADDER_RUNG_N | STOP_LOSS | WALLET_EXIT
| TAKE_PROFIT | HORIZON, isFinal }`. This is what makes the per-fill audit trail complete
and what makes the size-weighted return computable rather than approximated.

The wallet-exit close is priced at **detection time including webhook lag** (§20
detection-lag pricing), not at the wallet's on-chain sell time. Partial wallet-sells that
did **not** cross `walletExitThreshold` (the Design 1 accumulator above) are recorded as
observations on the trade — they are not exits, but logging every one gives the learning
loop the raw material to answer both "does a partial cluster-sell precede a full dump or is
it a false alarm?" and the Design 2/3 questions above. `walletExitThreshold` itself
(default 0.9) and the ladder rung levels (default 2×/3×/5×) are all tunables the 100-wallet
seed-history analysis (§4 backfill) is expected to settle before shipping.

---

## 11. Wallet Discovery Roadmap


## MVP

Manually seed wallets. Each added address is backfilled and scored immediately from its existing history (Wallet Scoring, §4) — not left blank until new trades accrue.

## Later

Automatically discover candidate wallets:

```text
Blockchain activity
      ↓
Candidate wallets
      ↓
Trade reconstruction
      ↓
Performance filtering
      ↓
Scoring
      ↓
Top wallet universe
      ↓
Continuous monitoring
```

Eventually support wallet clustering to detect related wallets and avoid counting coordinated wallets as independent evidence.


# PART III — PERP DOMAIN

## 1. Perp Agents
Initial candidates:

1. Funding Agent
2. Open Interest Agent
3. Liquidation Agent
4. Momentum Agent
5. Market Regime Agent

Potential future agents:

- Basis Agent
- Long/Short Positioning Agent
- Volatility Agent
- Order Flow Agent
- Sentiment Agent

Note: the perp agent roster was later expanded further (see the Perp Signal Scoring Pipeline section) to include Positioning, Setup/Pattern, and a dedicated Judge Agent role.

(Common agents like Risk, Momentum, and Market Regime — potentially reusable across domains — are defined in the general Agent Types section.)
## 2. Perp Intelligence


Perp agents should have their own data model and Brain.

Important data:

- symbol
- price
- OHLCV
- funding rate
- open interest
- liquidation activity
- long/short ratio
- basis
- volatility
- volume
- market regime

The architecture should allow multiple exchanges/providers eventually.

---

## 3. Perp Signal Scoring Pipeline


This is how raw perp agent outputs become a market signal. The Signal Engine stays fully deterministic — no LLM involvement. The LLM/Judge layer only interprets a signal after it has been calculated; it never computes the score itself. This keeps the system reproducible, backtestable, and debuggable.

Full chain:

```text
Raw Market Data
      ↓
Specialized Agents (Momentum, Funding, OI, Liquidation, Positioning, Regime, ...)
      ↓
Agent Outputs (structured, not prose)
      ↓
Feature Aggregator
      ↓
Signal Scoring Engine
      ↓
Market Signal
      ↓
Brain + Risk Agent
      ↓
Judge Agent
      ↓
Prediction
```

## Agents produce structured output, not prose

Each agent returns a machine-readable observation, e.g.:

```json
{
  "agent": "momentum",
  "direction": "LONG",
  "score": 84,
  "confidence": 0.88,
  "features": {
    "trend": "bullish",
    "ema_alignment": 0.91,
    "volume_confirmation": 0.76
  }
}
```

## Normalize to a common scale

All agent directions/scores are normalized to a shared range before aggregation:

```text
-1.0  = strongly bearish
 0.0  = neutral
+1.0  = strongly bullish
```

## Feature Aggregator

Collects every agent's normalized output into one market-state snapshot per symbol/timestamp:

```json
{
  "symbol": "BTCUSDT",
  "timestamp": "2026-08-29T16:00:00Z",
  "momentum": 0.84,
  "funding": -0.25,
  "open_interest": 0.76,
  "liquidations": 0.68,
  "positioning": -0.40,
  "market_regime": 0.81,
  "price": 110000,
  "volume": 0.73,
  "volatility": 0.62
}
```

## Signal Scoring Engine

Weighted composite across normalized features. Initial/starting weights (not fixed forever — see adaptive scoring below):

```text
Momentum          20%
Open Interest     20%
Market Regime     15%
Liquidations      15%
Funding           10%
Positioning       10%
Volume             5%
Historical Edge    5%
```

Composite score is thresholded into a signal:

```text
+0.70 → STRONG LONG
+0.45 → LONG
+0.20 → WEAK LONG
-0.20 → NEUTRAL
-0.45 → SHORT
-0.70 → STRONG SHORT
```

## Confidence is separate from direction/score

A signal score alone doesn't say how reliable it is. Two setups can share the same score with very different reliability:

```text
Setup A: LONG score +0.72, agent agreement 92%, historical sample 4,000
Setup B: LONG score +0.72, agent agreement 51%, historical sample 23
```

Confidence is calculated from:

```text
Signal Strength
+ Agent Agreement
+ Historical Evidence
+ Data Quality
= Confidence
```

## Agent disagreement is signal, not noise

Naive vote-counting (3 bullish vs 3 bearish → neutral) throws away information. Example: strongly bullish momentum/OI/regime alongside strongly bearish funding/positioning/risk isn't a wash — it can mean price is bullish but the market is dangerously long-crowded, which the Brain may recognize as a historical precursor to a long squeeze.

## Brain adds historical context

Once a market state is scored, the Brain searches historical states for similar conditions and returns win rates / median returns per horizon (e.g. "1,842 similar historical states → 61% win rate at 15m, 68% at 1h, 72% at 4h, median 4h return +1.9%").

## Risk Agent gets the full feature set, not raw data

Its job is to try to invalidate the signal — checking things like funding extremity, OI extremity, volatility extremity, price extension, and proximity to major support/resistance — and producing a risk score/level (e.g. `MEDIUM-HIGH`).

## Judge Agent — narrative by default, conditional veto on directional disagreement

The Judge receives structured evidence (not raw WebSocket data) — momentum/OI/funding/positioning/regime summaries, historical setup win rate, risk level — and always states its own `direction` and `confidence` alongside its thesis, named risks, and invalidation condition. In the normal case (Judge agrees with the deterministic Signal Scoring Engine's direction), the Judge's output is purely narrative context attached to the deterministic prediction, exactly as before.

When the Judge's direction disagrees with the deterministic signal, the conditional-override rule in the general LLM/Judge Layer section (Part I §18) applies identically here: override + a full parallel shadow trade fire only when the confidence gap is ≥0.2 *and* the Judge's own confidence is <0.7; otherwise the deterministic direction wins by default and the disagreement is just logged. See Part I §18 for the full worked examples and rationale, and §23 for how override outcomes get evaluated. The Prediction recorded is whichever direction wins under that rule, combined with the Trade Planner output; the Judge's thesis/risks/invalidators attach as narrative context either way, timestamped and locked.

## Signal vs Prediction

```text
SIGNAL     → what does the current market state suggest?
PREDICTION → what do we expect to happen over a specific future horizon?
```

## Adaptive scoring (later phase)

The initial feature weights above are starting assumptions. After enough historical predictions, the system can discover which features are actually predictive per regime and select a different weighting model accordingly:

```text
BULL TREND        → trend-oriented weights (momentum, OI more predictive)
RANGE             → mean-reversion / positioning weights (funding, liquidations more predictive)
HIGH VOLATILITY   → liquidation + volatility weights
```

This is explicitly a later-phase refinement, not part of the initial scoring engine.

---

## 4. Trade Planner


The Signal Engine decides direction. A separate Trade Planner converts a signal into an actual trade setup — these stay as distinct layers with distinct responsibilities:

```text
SIGNAL ENGINE   → "What direction does the evidence favor?"
TRADE PLANNER   → "Where should we enter, where are we wrong, where is the reward?"
RISK ENGINE     → "Is this trade actually acceptable?"
PAPER ENGINE    → "What would have happened if we took it?"
```

Important: TP/SL are never produced by the LLM. They're calculated from market structure (ATR, recent support/resistance) plus the trading agent's own risk configuration.

Example:

```text
BTC current price: $65,789
Signal: LONG, score 0.73, confidence 76%
ATR: $620
Recent support: $64,850
Recent resistance: $67,400

Entry: $65,789
SL: $64,850  → Risk = $939
TP: $67,400  → Reward = $1,611
Risk/Reward = 1 : 1.72
```

If the agent's configuration requires a minimum R:R (e.g. 1.5) and the setup doesn't clear it, the Trade Planner outputs `NO TRADE — insufficient reward/risk` even if direction and confidence were fine. The R:R gate can veto a directionally-correct signal.

Final structured output:

```json
{
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "entry": 65789,
  "stopLoss": 64850,
  "takeProfit": 67400,
  "riskReward": 1.72,
  "signalScore": 0.73,
  "confidence": 0.76,
  "horizon": "4h"
}
```

This structured setup is what the Paper Engine consumes to simulate the outcome.

## Position sizing & leverage (perp-specific detail — see Part I §35 for the general formula and the derived-not-chosen ordering)

Position size uses the general formula from Part I §35: `Risk Budget / |Entry − Stop Loss|`. Leverage is computed last, as a derived output — never picked upfront and never scaled by confidence:

```text
Position Size (from Part I §35 formula): 0.5 BTC
Notional Value = 0.5 × 65,789 = $32,894.50

Max Safe Leverage = highest leverage where Liquidation Price stays no closer
                    to entry than the Stop-Loss distance ($939) →
                    computed as ≈10x for this stop distance (depends on
                    exchange maintenance margin rate)

Allowed Leverage = min(Max Safe Leverage ≈10x, exchange max, user-configured max) = 10x

Required Margin = 32,894.50 / 10 = $3,289.45
Liquidation Price ≈ $63,100 (derived from the allowed leverage above)
```

**Check on this example:** SL is at $64,850 (distance $939), liquidation is at ≈$63,100 (distance $2,689) — liquidation sits *further* than the stop by construction, since leverage was derived specifically to satisfy this, not chosen first and validated after. If even the lowest sensible leverage couldn't keep liquidation safely beyond the stop (e.g. account too small for this position size), the Trade Planner outputs `NO TRADE — cannot size safely within account constraints` rather than raising leverage to force the trade to fit.

Final structured output (updated to include sizing/leverage/entry type):

```json
{
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "entryType": "LIMIT",
  "entry": 65789,
  "stopLoss": 64850,
  "takeProfit": 67400,
  "riskReward": 1.72,
  "positionSize": 0.5,
  "leverage": 10,
  "marginRequired": 3289.45,
  "liquidationPrice": 63100,
  "signalScore": 0.73,
  "confidence": 0.76,
  "horizon": "4h"
}
```

Note: `confidence` in this output has no bearing on `leverage` or `positionSize` above it — they were fully determined before confidence enters the picture at all.

## Entry types (Market and Limit are part of the initial version)

Rather than always using current price as entry, the Trade Planner must choose between two entry types from the initial version — not deferred:

```text
MARKET  → enter immediately at current price.
LIMIT   → enter only if price reaches a specified level; unfilled orders expire
          after a timeout.
```

**Decision rule (initial version):** the Trade Planner computes an entry zone from market structure (ATR, recent support/resistance — same inputs already used for SL/TP). If current price is already inside that zone, use `MARKET` — waiting risks missing the move. If current price sits outside the zone (extended from it by more than some ATR-based buffer), use `LIMIT`, placed at the edge of the zone, with an expiry (e.g. N candles of the TradingAgent's timeframe, §8) after which the order is cancelled and the **agent** reverts to `WATCHING`/`IDLE` (Trading Agent Lifecycle, §37) rather than staying `PENDING_ENTRY` indefinitely. *(Cross-reference corrected during audit #13: `WATCHING` and `PENDING_ENTRY` are §37 agent-lifecycle states, not §36 signal states — §36's authoritative list is ACTIVE/EXPIRED/INVALIDATED/CONSUMED, and a signal whose LIMIT expires unfilled stays CONSUMED; the unfilled entry is recorded on the position as EXPIRED/LIMIT_EXPIRY.)*

Example:

```text
Signal: LONG, current price $65,789
Entry zone (from structure): $65,200–$65,500

Current price is outside the zone (extended above it)
  → LIMIT order at $65,500, expires after 6 candles if unfilled

vs.

Signal: LONG, current price $65,350
Entry zone: $65,200–$65,500

Current price is inside the zone
  → MARKET order, enter immediately
```

This directly determines the Trading Agent Lifecycle transition (§37): a `LIMIT` order sits in `PENDING_ENTRY` until filled or expired; a `MARKET` order goes straight to `IN_TRADE`.

**Deferred to a later refinement:** breakout and pullback entry types (pattern-based, more complex than a static zone check) and multiple take-profit levels (TP1/TP2). Market and Limit alone are sufficient for the initial version and cover the two cases that actually matter — "act now" vs "wait for a better price."

---

## 5. Perp Data Providers
Perp market data is planned to come from **Bybit's public WebSocket** (already the exchange in use elsewhere in this ecosystem), wrapped behind a provider adapter — raw Bybit payloads never reach agents directly.

Relevant Bybit WS topics:

```text
tickers.{symbol}      → last/mark/index price, funding rate, open interest, 24h volume
kline.{interval}.{symbol} → OHLCV, per timeframe
publicTrade.{symbol}  → individual trades (price, size, taker side)
orderbook.{depth}.{symbol} → bids/asks
liquidation.{symbol}  → forced liquidations (separate subscription per symbol)
```

Not available over Bybit's WebSocket:

- **Long/short ratio** — REST-only (`/v5/market/account-ratio`), updates on a fixed interval, must be polled on a scheduled job rather than streamed.
- **Basis** and **volatility** — not fetched at all; both are derived downstream from data already available (basis = perp mark price − index price; volatility = computed from the kline/trade stream).

So ingestion has two lanes: **streamed** (ticker, kline, public trades, orderbook, liquidations via WS) and **polled** (long/short ratio via scheduled REST job).

The architecture should still allow multiple exchanges/providers eventually — Bybit is the first target, not the only one.
## 6. Perp Brain Memory Types
```text
Funding Memory
Open Interest Memory
Market Memory
Setup Memory
Outcome Memory
```

Setup Memory here stores performance of perp-specific feature combinations (e.g. momentum + OI + funding + regime), the same way memecoin Setup Memory stores wallet/convergence/momentum combinations, and uses the same fingerprinting method (discretized hash + hierarchical shrinkage) defined in Part II §8 — see the general Brain Memory Types section for the shared Agent Memory / Market Memory concepts.

---


# PART IV — AGENT CATALOG

## 40. Agent Catalog


Full per-agent specifications derived from Task 5 (§34). Trigger types are defined in §7; scoring/aggregation contract in Part III §3 (perp) and Part II §9 (memecoin); confidence math in Task 6 (§34). This section fills in the numeric specifics per agent — EMA periods, RSI windows, thresholds, veto conditions — that Task 5 called for. Where a parameter is specified with a concrete number (e.g. `EMA(9,21,50)`), that is the MVP default and lives in a versioned config so it's tunable without a code change; where a parameter is deliberately left as a range or as "TBD from seed analysis," the seed-history analysis (Part II §4) is expected to settle it before the corresponding subsystem ships.

**Common contract for every Agent** (Task 5): deterministic (no LLM except Judge, §40.14). Emits `{ score ∈ [−1,+1], confidence ∈ [0,1], features{} }`. Non-directional agents (Regime, Risk, Token Risk) are special-cased where noted. Every Agent carries an `agentVersion` (integer, monotonic per agent, bumped only on behavioral change — Task 1), owns an `AgentPerformance` row keyed `(agentKey, agentVersion)`, and a `BrainAgentMemory` standalone-accuracy row keyed the same way.

**Agents vs Features** (§7): the composite weight tables list some rows that are *Features* rather than Agents — no trigger, no version, no performance record, no user toggle. Features are spec'd in §40.15–40.19; Agents are §40.1–40.14.

**Section index:**

```
Perp Agents
  40.1  Perp Momentum Agent
  40.2  Perp Open Interest Agent
  40.3  Perp Market Regime Agent
  40.4  Perp Liquidation Agent
  40.5  Perp Funding Agent
  40.6  Perp Positioning Agent

Memecoin Agents
  40.7  Memecoin Smart Money Agent
  40.8  Memecoin Convergence Agent
  40.9  Memecoin Momentum Agent
  40.10 Memecoin Token Quality Agent
  40.11 Memecoin Market Regime Agent

Common / Cross-Domain Agents
  40.12 Risk Agent (perp + memecoin variants)
  40.13 Token Risk Agent (memecoin hard-veto)
  40.14 Judge Agent (LLM, perp-only in MVP)

Features (no trigger, no version, no performance record)
  40.15 Perp Volume feature
  40.16 Perp Historical Edge feature
  40.17 Memecoin Early-Entry Edge feature
  40.18 Memecoin Signal Freshness feature
  40.19 Memecoin Historical Edge feature
```

---

### 40.1 Perp Momentum Agent

**Purpose:** Detect directional momentum from price action alone (trend structure + oscillator confirmation). The trend-following counterweight to the perp domain's contrarian agents (Funding, Positioning).

**Weight:** 20% of the perp composite (Part III §3).

**Trigger:** CADENCE + CONDITIONAL — fires on primary-TF candle close; skips a candle when `range < 0.25 × ATR(14)` AND `volume < 0.5 × avg_volume(20)` (dead candle, per §7).

**Domain:** Perp. **Timeframe:** primary TF from the TradingAgent's trading style (§8) — 5m / 1h / 4h for scalp / day / swing.

**Inputs:**
- OHLCV rolling buffer, primary TF, minimum 60 candles (EMA(50) warmup + slope calc).
- ATR(14) on the primary TF for the CONDITIONAL skip check.

**Calculations:**
1. **EMA stack:** EMA(9), EMA(21), EMA(50) on close. Alignment score = `+1.0` if EMA9 > EMA21 > EMA50; `−1.0` if reversed; proportional in between based on the ordered-pair count.
2. **EMA(21) slope:** slope over the last 5 candles as % of price. Normalized to [−1, +1] by dividing by an expected max slope (2% per candle).
3. **RSI(14):** current value. Contributes bullish for RSI < 30 (oversold), bearish for RSI > 70 (overbought), neutral in 40–60. Linear interpolation outside the neutral band.
4. **MACD(12,26,9) histogram:** sign = direction, magnitude normalized against rolling histogram range (last 50 candles).

Composite: `0.4·alignment + 0.3·slope + 0.15·rsi + 0.15·macd`, clamped to [−1, +1].

**Confidence:** `1 − stddev(sub_signs)/2` — high when all four sub-signals agree, drops toward 0.4 when they conflict.

**Output:**
```json
{
  "agent": "perp.momentum",
  "agentVersion": 1,
  "direction": "LONG",
  "score": 0.74,
  "confidence": 0.82,
  "features": {
    "ema_alignment": 0.9,
    "ema_slope": 0.65,
    "rsi": 62,
    "macd_hist_normalized": 0.44,
    "skipped": false
  }
}
```

**Events consumed:** `perp.kline.closed` (primary TF).

**Events produced:** `agent.analysis.completed`.

**LLM used:** No.

**Edge cases:**
- Missing candles in buffer → `INSUFFICIENT_DATA` (score 0, confidence 0, `skipped: true`). No interpolation.
- Dead candle skip → `{skipped: true}`, no composite contribution, does not update `AgentPerformance`.
- Underlying kline feed BLOCKED (§10) → agent inherits BLOCKED, no compute.

**Setup Memory contribution:** raw score bucketed as MOMENTUM ∈ {LOW, MED, HIGH} by `|score|` (< 0.3 / 0.3–0.65 / > 0.65). Sign lives in the DIRECTION dimension separately.

---

### 40.2 Perp Open Interest Agent

**Purpose:** Distinguish real directional conviction (new positions opening in trend direction) from mechanical squeezes (position unwinding). OI is one of the most predictive perp features because price alone can't tell "buyers stepping in" from "shorts covering."

**Weight:** 20% of the perp composite.

**Trigger:** CADENCE — primary-TF candle close.

**Domain:** Perp. **Timeframe:** primary TF.

**Inputs:**
- Close price buffer, last 4 primary-TF candles.
- OI buffer, last 4 primary-TF candles.
- Latest OI from `tickers.{symbol}` WS stream.

**Calculations:**
1. `price_delta = (close[t] − close[t−4]) / close[t−4]`.
2. `oi_delta = (oi[t] − oi[t−4]) / oi[t−4]`.
3. Classify into the 2×2 matrix:

```
                    Price ↑                    Price ↓
   OI ↑     TREND_CONFIRM_BULL          NEW_SHORTS_BEAR
              score: +0.7 to +1.0         score: −0.7 to −1.0

   OI ↓     SHORT_COVERING (weak long)  LONG_UNWIND (weak short)
              score: +0.2 to +0.5         score: −0.2 to −0.5
```

Magnitude within each quadrant scaled by `|price_delta| + |oi_delta|`, normalized against rolling volatility of both series (larger simultaneous moves = stronger signal).

**Confidence:** high (> 0.85) when both `|price_delta| > 0.5%` and `|oi_delta| > 1%`; drops sharply if either is near zero (a flat state carries no OI signal).

**Output:**
```json
{
  "agent": "perp.open_interest",
  "agentVersion": 1,
  "direction": "LONG",
  "score": 0.78,
  "confidence": 0.86,
  "features": {
    "price_delta_pct": 1.4,
    "oi_delta_pct": 3.2,
    "quadrant": "TREND_CONFIRM_BULL"
  }
}
```

**Events consumed:** `perp.kline.closed`, `perp.open_interest.updated`.

**Events produced:** `agent.analysis.completed`.

**LLM used:** No.

**Edge cases:**
- OI feed BLOCKED → agent BLOCKED (OI is the whole signal, no proceed).
- Buffer < 4 candles on startup → NEUTRAL, confidence 0.
- Non-positive OI value (data glitch) → reject tick, retain prior value, log warning.

**Setup Memory contribution:** OI_STATE ∈ {TREND_CONFIRM_BULL, SHORT_COVERING, NEW_SHORTS_BEAR, LONG_UNWIND, NEUTRAL}.

---

### 40.3 Perp Market Regime Agent

**Purpose:** Classify the current market state into a small set of regimes so the Signal Scoring Engine and the Judge can weight other signals appropriately (contrarian in RANGE, trend-following in BULL/BEAR, risk-off in HIGH_VOL). Also produces a directional bias that participates in the composite.

**Weight:** 15% of the perp composite.

**Trigger:** CADENCE — primary-TF candle close.

**Domain:** Perp. **Timeframe:** primary TF plus one higher (e.g. day-style reads 1h primary + 4h context).

**Inputs:**
- OHLCV buffer for primary TF (minimum 50 candles).
- OHLCV buffer for the next-higher TF (minimum 30 candles).

**Calculations:**
1. **Trend strength:** ADX(14) on primary TF.
2. **Trend direction:** EMA(50) slope on higher TF (%/candle).
3. **Volatility state:** current ATR(14) / rolling ATR average (30 candles). Values > 1.5 flag elevated vol.

Regime enum (special-cased — not a plain score):

```
ATR ratio > 1.5                   → HIGH_VOL      (overrides trend classification)
ADX < 20                          → RANGE
ADX ≥ 20 AND higher-TF slope > 0  → BULL
ADX ≥ 20 AND higher-TF slope < 0  → BEAR
```

Directional bias score:
- BULL → +0.6 to +1.0 (scaled by ADX and slope steepness)
- BEAR → −0.6 to −1.0
- RANGE → 0.0 (regime itself is directionally neutral)
- HIGH_VOL → 0.0 (risk-off; downstream regime-aware scoring may penalize other signals, but Regime itself contributes zero direction)

**Confidence:** high when ADX is unambiguously above or below the 20 threshold and higher-TF slope has a clear sign; lower near threshold boundaries or during transitions.

**Output (non-directional dual-emission — special case):**
```json
{
  "agent": "perp.market_regime",
  "agentVersion": 1,
  "regime": "BULL",
  "direction": "LONG",
  "score": 0.72,
  "confidence": 0.85,
  "features": {
    "adx": 28,
    "higher_tf_slope_pct": 1.4,
    "atr_ratio": 0.9
  }
}
```

**Events consumed:** `perp.kline.closed` (both primary + higher TF).

**Events produced:** `agent.analysis.completed`, `perp.regime.classified` (broadcast so other agents that condition on regime can subscribe).

**LLM used:** No.

**Edge cases:**
- Higher-TF buffer not warm → agent runs on primary TF alone, confidence capped at 0.5, regime tagged `LOW_CONFIDENCE`.
- Rolling ATR mean is zero (dead market) → report `regime: RANGE`, skip vol classification.

**Setup Memory contribution:** REGIME is a **first-class dimension** of the perp fingerprint tuple (Part II §8 rejects handling regime separately — it's baked into the fingerprint by design). Bucketed into {BULL, BEAR, RANGE, HIGH_VOL}.

**Agent Memory (§16):** tracks the bias only, not the enum — the enum is categorical, not a directional lean whose "standalone accuracy" is meaningful.

---

### 40.4 Perp Liquidation Agent

**Purpose:** Detect when forced liquidations are creating short-term contrarian setups (cascade of forced sells → local bottom; cascade of forced buys → local top). Also captures pure liquidation-intensity spikes as risk-off signals.

**Weight:** 15% of the perp composite.

**Trigger:** EVENT (`perp.liquidation.detected`) with CADENCE roll-up on primary-TF candle close.
- EVENT trigger fires on any large individual liquidation for real-time reaction.
- CADENCE roll-up aggregates all liquidations within the primary-TF window into a summary score.

**Domain:** Perp. **Timeframe:** primary TF for roll-up.

**Inputs:**
- Liquidation event stream (`liquidation.{symbol}`) — per-event `{ size, side, price, timestamp }`.
- Rolling buffer of liquidations over the last 3 primary-TF candles.

**Calculations:**
1. Aggregate `long_liq_vol` and `short_liq_vol` over the rolling window.
2. **Imbalance:** `(long_liq_vol − short_liq_vol) / (long_liq_vol + short_liq_vol)`, range [−1, +1]. Long liqs → contrarian bullish (bottom likely near); short liqs → contrarian bearish.
3. **Intensity:** total liquidation volume in window / rolling 30-candle average. > 3× is a spike.

Score:
- Imbalance decisive (|imbalance| > 0.5) AND intensity > 2× → contrarian score = `+imbalance × min(intensity/3, 1.0)`. Note the *sign flip*: long liquidations → LONG signal.
- Intensity > 3× regardless of imbalance → NEUTRAL direction, but `RISK_FLAG: HIGH_LIQ_SPIKE` set for Risk Agent to consume.
- Otherwise → NEUTRAL.

**Confidence:** proportional to intensity and imbalance clarity — a single big liquidation with no clear imbalance is low confidence.

**Output:**
```json
{
  "agent": "perp.liquidation",
  "agentVersion": 1,
  "direction": "LONG",
  "score": 0.55,
  "confidence": 0.72,
  "features": {
    "imbalance": 0.68,
    "intensity_ratio": 2.4,
    "long_liq_usd": 4200000,
    "short_liq_usd": 800000,
    "risk_flag": null
  }
}
```

**Events consumed:** `perp.liquidation.detected`, `perp.kline.closed`.

**Events produced:** `agent.analysis.completed`.

**LLM used:** No.

**Edge cases:**
- Liquidation feed BLOCKED → agent BLOCKED.
- Zero liquidations in window → NEUTRAL with confidence 0 (no evidence in either direction, not "no signal at all").
- EVENT trigger fires but CADENCE hasn't rolled up yet → EVENT emits a provisional score based on the individual liquidation; CADENCE overwrites with rolled-up view on next candle close.

**Setup Memory contribution:** LIQ_STATE ∈ {NEUTRAL, LONG_LIQ_CASCADE, SHORT_LIQ_CASCADE, HIGH_INTENSITY}.

---

### 40.5 Perp Funding Agent

**Purpose:** Detect crowded positioning via funding rate extremes. Elevated funding = many people paying to be long = crowded longs = contrarian bearish. Same in reverse.

**Weight:** 10% of the perp composite.

**Trigger:** CADENCE — primary-TF candle close (funding refreshes ~8-hourly on Bybit, but the agent evaluates the current published funding on every primary-TF close).

**Domain:** Perp. **Timeframe:** primary TF for evaluation.

**Inputs:**
- Current funding rate from `tickers.{symbol}` WS.
- Rolling 30-day funding rate history (for percentile computation).

**Calculations:**
1. Compute the percentile of current funding within the rolling 30-day distribution.
2. Score:
   - percentile > 90 → strong contrarian short (−0.7 to −1.0)
   - percentile > 75 → moderate contrarian short (−0.3 to −0.7)
   - percentile 25–75 → NEUTRAL (0)
   - percentile < 25 → moderate contrarian long (+0.3 to +0.7)
   - percentile < 10 → strong contrarian long (+0.7 to +1.0)

**Confidence:** high at extremes (< 10 or > 90 percentile), lower in the middle.

**Output:**
```json
{
  "agent": "perp.funding",
  "agentVersion": 1,
  "direction": "SHORT",
  "score": -0.78,
  "confidence": 0.88,
  "features": {
    "funding_rate": 0.0165,
    "funding_percentile_30d": 94,
    "annualized_pct": 18.05
  }
}
```

**Events consumed:** `perp.kline.closed` (evaluation trigger), `perp.funding.updated` (updates the current funding value).

**Events produced:** `agent.analysis.completed`.

**LLM used:** No.

**Edge cases:**
- Rolling 30d history not populated (fresh symbol / first month post-launch) → confidence capped at 0.5 until 30 days of funding observations accumulate.
- Funding feed BLOCKED → agent BLOCKED.

**Setup Memory contribution:** FUNDING_STATE ∈ {EXTREME_LOW, LOW, NEUTRAL, HIGH, EXTREME_HIGH} by percentile buckets.

---

### 40.6 Perp Positioning Agent

**Purpose:** Detect crowded positioning via retail long/short account ratio. Similar contrarian read to Funding but reads a different data source (Bybit REST poll), giving an independent view.

**Weight:** 10% of the perp composite.

**Trigger:** CADENCE — fires on each successful long/short ratio poll (Bybit REST `/v5/market/account-ratio`, per Part III §5). Polling cadence separate from primary TF — the endpoint's own refresh interval.

**Domain:** Perp.

**Inputs:**
- Latest long/short ratio from the polled endpoint.
- Rolling 30-day ratio history for percentile normalization.

**Calculations:**
1. Percentile of current ratio within the rolling 30-day distribution.
2. Symmetric contrarian score, same shape as Funding:
   - ratio percentile > 90 → contrarian short
   - percentile 25–75 → NEUTRAL
   - percentile < 10 → contrarian long

**Confidence:** same rule as Funding — high at extremes, lower in middle. Additional degradation if the polling job has been failing (stale value).

**Output:**
```json
{
  "agent": "perp.positioning",
  "agentVersion": 1,
  "direction": "SHORT",
  "score": -0.66,
  "confidence": 0.82,
  "features": {
    "long_short_ratio": 1.94,
    "ratio_percentile_30d": 91,
    "poll_age_seconds": 42
  }
}
```

**Events consumed:** internal `perp.positioning.polled` (produced by the scheduled REST poll job).

**Events produced:** `agent.analysis.completed`.

**LLM used:** No.

**Edge cases:**
- Polling job failing (`poll_age` > 3× normal interval) → agent BLOCKED, dependent TradingAgents inherit BLOCKED per §10 feed staleness rule.
- 30d rolling history not populated → confidence capped at 0.5.

**Setup Memory contribution:** POSITIONING_STATE ∈ {EXTREME_LOW, LOW, NEUTRAL, HIGH, EXTREME_HIGH}.

---

### 40.7 Memecoin Smart Money Agent

**Purpose:** Score a buy event by the historical quality of the wallet (or wallets) triggering it. The primary "who bought" signal for memecoin, weighted highest in the composite.

**Weight:** 25% of the memecoin composite (Part II §9).

**Trigger:** EVENT — fires on `memecoin.wallet.buy.detected` where the buying wallet's rated score (Part II §4) is above the minimum quality floor. Wallets below the floor (or unrated with n < 10 trades) do not trigger this agent.

**Domain:** Memecoin.

**Inputs:**
- Each triggering wallet's point-in-time score via `WalletScoreEvent` lookup ("wallet X score as of T", rule 21 — never live-lookup).
- For any additional wallets in the same batching window (§9a) on the same token, their point-in-time scores too.
- Wallet buy size (USD).

**Calculations:**
1. Look up each buying wallet's score as of the event timestamp — never today's score (rule 21).
2. Weighted average of wallet scores, weighted by USD buy size:
   ```
   smart_money_score = Σ(wallet_score_i × usd_size_i) / Σ(usd_size_i)
   ```
3. Normalize to [−1, +1] where the wallet-universe median maps to 0 and the top decile maps to +1. Memecoin is long-only per §18 memecoin scoping note — this agent only produces LONG or NEUTRAL, never SHORT.

**Confidence:** function of total USD in the batch (larger money = higher confidence) and number of independent wallets (single-wallet lower than 3-wallet, but not zero — see the single-buy note in Part II §9).

**Output:**
```json
{
  "agent": "memecoin.smart_money",
  "agentVersion": 1,
  "direction": "LONG",
  "score": 0.82,
  "confidence": 0.74,
  "features": {
    "weighted_avg_wallet_score": 87,
    "total_usd": 42000,
    "wallet_count": 3,
    "top_wallet_score": 94
  }
}
```

**Events consumed:** `memecoin.wallet.buy.detected`.

**Events produced:** `agent.analysis.completed`.

**LLM used:** No.

**Edge cases:**
- Triggering wallet unrated (n < 10 trades) → agent does not fire.
- `WalletScoreEvent` lookup finds no row with `timestamp ≤ T` (wallet added mid-session before backfill completed) → treat as unrated, do not fire.
- All buying wallets below quality floor → NEUTRAL, confidence 0.

**Setup Memory contribution:** SMART_MONEY_QUALITY ∈ {LOW, MED, HIGH} bucketed by weighted average score (< 60 / 60–80 / > 80).

---

### 40.8 Memecoin Convergence Agent

**Purpose:** Detect when multiple independent smart-money wallets buy the same token in a short window — the highest-conviction memecoin signal available before any price/volume follow-through has occurred.

**Weight:** 20% of the memecoin composite.

**Trigger:** EVENT — fires when the batching window closes (§9a) on a token that received ≥ 2 buys from independent funder clusters (funder-cluster dedup rule, Part II §5). Single-cluster batches still get scored, but Convergence contributes thin (see the single-buy note in Part II §9).

**Domain:** Memecoin.

**Inputs:**
- Full batch of buys on the token (from the closed batching window).
- Funder-cluster assignments for each buying wallet (Part II §5 clustering pass runs first).
- Each cluster's `clusterQuality` (capped aggregate of member wallet scores — Task 6).
- Timestamps of first and last buy in the batch (for time-compression).

**Calculations:**
1. Group wallets by funder cluster (Part II §5).
2. For each cluster:
   - `clusterQuality` = capped aggregate of member wallet scores (Task 6 caps so one cluster can't dominate).
   - `independenceWeight` = 1.0 for a fully independent cluster; reduced when clusters share a secondary funding-tree overlap (e.g. same CEX withdrawal source per §5 secondary heuristic).
3. `time_compression` = 1.0 for very tight windows (all buys within 5s), tapering to 0.5 at the batching-window boundary.
4. Composite (from Task 6):
   ```
   convergence_score = Σ_clusters (clusterQuality × independenceWeight) × time_compression
   ```
5. Normalize to [−1, +1]. Long-only domain — LONG or NEUTRAL.

**Confidence:** proportional to independent cluster count and time compression. Single cluster → confidence ~0.3. Five independent clusters in 2 seconds → confidence ~0.95.

**Output:**
```json
{
  "agent": "memecoin.convergence",
  "agentVersion": 1,
  "direction": "LONG",
  "score": 0.88,
  "confidence": 0.91,
  "features": {
    "independent_clusters": 4,
    "total_wallets": 7,
    "time_span_seconds": 3.2,
    "top_cluster_quality": 89,
    "time_compression": 0.94
  }
}
```

**Events consumed:** batch of `memecoin.wallet.buy.detected` events on the same token, at window close.

**Events produced:** `agent.analysis.completed`, `memecoin.wallet.convergence.detected` (broadcast for Agent Room / dashboards).

**LLM used:** No.

**Edge cases:**
- Single cluster in batch → still produces a score (thin contribution), does not fail the batch.
- No independent cluster (one cluster's members all share a funder) → convergence = 0 despite multiple wallet addresses, exactly as §5 requires.
- Batching window closed with zero eligible buys (all filtered by claimed-token pre-filter, §9a) → agent does not fire.

**Setup Memory contribution:** CONVERGENCE ∈ {NONE, THIN, STRONG} by independent cluster count (1 / 2–3 / ≥ 4).

---

### 40.9 Memecoin Momentum Agent

**Purpose:** Confirm smart-money entry with actual price/volume follow-through. Guards against following a wallet into a token that's already extended or that the market isn't validating.

**Weight:** 15% of the memecoin composite.

**Trigger:** CADENCE + CONDITIONAL — fires on the memecoin token's OHLCV candle close (aggregated from Helius parsed swaps at the primary TF from trading style). CONDITIONAL skip on dead candles (same threshold as perp Momentum).

**Domain:** Memecoin. **Timeframe:** primary TF from trading style.

**Inputs:**
- OHLCV buffer for the token, primary TF (derived from Helius parsed swaps aggregated to candles).
- Rolling volume average.
- Recent price extension (% move from a rolling low).

**Calculations:**
1. **Volume acceleration:** current-candle volume / rolling 10-candle average. > 2× = strong acceleration.
2. **Price momentum:** slope of close over last 5 candles.
3. **Price extension penalty:** if price is > 30% above the rolling 20-candle low, apply a diminishing multiplier (the wallet may be late; we would be later).

Score:
```
raw = 0.5 × slope_normalized + 0.5 × min(vol_ratio / 3, 1.0)
score = raw × extension_penalty      # extension_penalty ∈ [0.3, 1.0]
```

Long-only domain.

**Confidence:** high when both slope and volume acceleration point up together; lower when one is present without the other.

**Output:**
```json
{
  "agent": "memecoin.momentum",
  "agentVersion": 1,
  "direction": "LONG",
  "score": 0.61,
  "confidence": 0.72,
  "features": {
    "slope_pct_per_candle": 4.2,
    "vol_ratio": 2.6,
    "extension_from_low_pct": 18,
    "extension_penalty": 0.85
  }
}
```

**Events consumed:** aggregated token-candle-close event (derived from Helius parsed swaps by the ingestion layer).

**Events produced:** `agent.analysis.completed`.

**LLM used:** No.

**Edge cases:**
- Token is minutes old — insufficient candle history for slope/volume normalization → confidence capped at 0.4 with feature `insufficient_history: true`. Signal can still fire but Momentum's composite contribution is muted.
- Helius swap parsing fails for a specific swap → skip that swap, do not fail the candle.
- Very thin token (few trades per candle) → volume average unstable → confidence capped at 0.5.

**Setup Memory contribution:** MOMENTUM ∈ {LOW, MED, HIGH} by `|score|`.

---

### 40.10 Memecoin Token Quality Agent

**Purpose:** Evaluate token *fundamentals* — liquidity depth, age, holder concentration. Provides a soft quality score in the composite. Separate and distinct from Token Risk (§40.13), which is a hard veto for rug indicators.

**Weight:** 10% of the memecoin composite.

**Trigger:** EVENT — fires on `token.profile.updated` (typically first sight of the token + periodic refresh).

**Domain:** Memecoin.

**Inputs:**
- Token metadata from Helius (age, LP status, holder list).
- Pool reserves from Helius (liquidity).

**Calculations:**
1. **Liquidity score:** percentile of current pool USD liquidity within a rolling recent-tokens distribution. Higher = better.
2. **Age score:** age in minutes, capped at 24h. Fresh tokens score lower (more risk); tokens > a few hours old score higher.
3. **Holder concentration:** `1 − (top-10-holder % of supply)`. Higher = less concentrated = better.

Composite: weighted average (0.5·liquidity + 0.3·age + 0.2·concentration), normalized to [0, +1]. This agent is unipolar — a "high" quality token contributes bullishly, a "low" quality token contributes 0, never negative.

**Confidence:** high when all three sub-features are populated and non-noisy; low if any input is missing.

**Output:**
```json
{
  "agent": "memecoin.token_quality",
  "agentVersion": 1,
  "direction": "LONG",
  "score": 0.68,
  "confidence": 0.85,
  "features": {
    "liquidity_usd": 240000,
    "liquidity_percentile": 82,
    "age_minutes": 145,
    "top10_holder_pct": 34
  }
}
```

**Events consumed:** `token.profile.updated`.

**Events produced:** `agent.analysis.completed`.

**LLM used:** No.

**Edge cases:**
- Holder list unavailable from Helius → skip concentration, redistribute weight to remaining two features, cap confidence at 0.6.
- Pool reserves missing at execution tick → score is still computed (this is the quality read, not the fill), but downstream Trade Planner will `NO TRADE` regardless (Part II §10 requires reserves at fill time).

**Setup Memory contribution:** TOKEN_QUALITY ∈ {LOW, MED, HIGH}.

---

### 40.11 Memecoin Market Regime Agent

**Purpose:** SOL / broad-market regime — same conceptual role as perp Market Regime but scoped to Solana as the base market. Memecoin performance correlates strongly with SOL regime: bull SOL provides tailwind, bear SOL punishes even good setups.

**Weight:** 5% of the memecoin composite.

**Trigger:** CADENCE — fires on SOL primary-TF candle close (matching TradingAgent's trading style).

**Domain:** Memecoin.

**Inputs:**
- SOL/USDT OHLCV from an external market data source (Bybit, for consistency with perp).
- Same ADX / EMA slope / vol inputs as perp Market Regime.

**Calculations:** mechanics identical to §40.3 perp Market Regime, applied to SOL. Regime enum {BULL, BEAR, RANGE, HIGH_VOL} plus a directional bias score.

**Confidence:** same rules as perp Market Regime.

**Output:** same shape as perp Market Regime, `agent: "memecoin.market_regime"`.

**Events consumed:** SOL kline stream (from the market data adapter).

**Events produced:** `agent.analysis.completed`, `memecoin.regime.classified`.

**LLM used:** No.

**Edge cases:**
- Bybit SOL feed BLOCKED → agent BLOCKED (Solana price data is essential; no fallback derives it from Helius alone in MVP).

**Setup Memory contribution:** REGIME dimension of the memecoin fingerprint (Part II §8 5-feature tuple).

---

### 40.12 Risk Agent (perp + memecoin variants)

**Purpose:** Post-aggregation quality gate. Sits *outside* the composite (has no weight) — its job is to try to invalidate the signal after the scoring engine has produced one, catching setups that look good on their individual features but sit in dangerous market conditions.

**Weight:** N/A — not in the composite. Post-aggregation veto (§7).

**Trigger:** EVENT — fires on `signal.created` (after the composite is scored, before the Judge runs).

**Domain:** Both. Different specifics per domain.

**Inputs (perp variant):**
- Full aggregated feature snapshot from Signal Scoring Engine.
- Distance to nearest support/resistance (from rolling structure computation).
- Current volatility state (from Market Regime).
- Position sizing / leverage from the Trade Planner's preliminary compute.

**Inputs (memecoin variant):**
- Full aggregated feature snapshot.
- Pool reserves (for `maxPoolShare` cross-check).
- Token age (very fresh tokens flagged for higher scrutiny).

**Calculations:** runs a set of independent checks, each producing a risk contribution.

Perp checks:
- **S/R proximity:** entry within 0.3× ATR of a major level *against* the trade direction (near resistance for LONG, near support for SHORT) → adds risk.
- **Funding extremity:** funding > 95th percentile against the trade direction → adds risk.
- **OI extremity:** OI at 90th percentile of rolling → moderate risk (crowded book).
- **Volatility extremity:** ATR ratio > 2.0 → adds risk (HIGH_VOL regime).
- **Price extension:** price > 2 ATR from EMA(50) → adds risk (extended, mean-reversion concern).

Memecoin checks:
- Extreme freshness (< 5 min old token) → adds risk.
- Position notional > 50% of `maxPoolShare` limit → adds risk (near-cap, thin fill).
- Wallet quality below median for the domain → adds risk.

Aggregate into `risk_level ∈ {LOW, MEDIUM, MEDIUM_HIGH, HIGH, INVALIDATED}`.

Veto rule: if `risk_level = INVALIDATED`, the signal transitions to INVALIDATED (§36) — no trade taken. Any other level attaches as narrative context to the Prediction but does not block.

**Output (non-directional special case):**
```json
{
  "agent": "risk",
  "agentVersion": 1,
  "risk_level": "MEDIUM_HIGH",
  "invalidated": false,
  "risk_flags": ["FUNDING_EXTREME", "PRICE_EXTENDED"],
  "score": null,
  "confidence": 0.92
}
```

`score` is deliberately null — Risk doesn't participate in the composite directionally.

**Events consumed:** `signal.created`.

**Events produced:** `agent.analysis.completed`; if `invalidated: true`, additionally `signal.invalidated`.

**LLM used:** No.

**Edge cases:**
- Missing S/R data (fresh token or insufficient history) → skip S/R check, do not fail the signal.
- Risk Agent has an `AgentPerformance` record even though not in the composite — its accuracy metric is "how often did INVALIDATED signals turn out to have been correctly invalidated?" measured via shadow trades (§23 STAND_ASIDE mechanism, perp only in MVP since memecoin has no Judge invalidations).

---

### 40.13 Token Risk Agent (memecoin hard-veto)

**Purpose:** Kill obviously-toxic memecoin signals (rug pulls, honeypots, unlocked LP, mint authority still live) *before* they can enter the composite. Distinct from Token Quality (§40.10, a soft 10% score) and from Risk Agent (§40.12, a post-aggregation gate).

**Weight:** N/A — hard veto, independent of Token Quality's 10% score. Vetoes at the eligibility cascade (§9a hard gates).

**Trigger:** EVENT — fires on `token.activity.detected` (first sighting) and `token.profile.updated`.

**Domain:** Memecoin only.

**Inputs:**
- Token mint metadata (mint authority present? freeze authority present?).
- LP status (locked? burned? unlocked?).
- Top-holder distribution.
- Honeypot pattern match (basic pattern list, maintained as versioned config).

**Calculations:** boolean checks; any TRUE triggers veto:
- Mint authority not renounced.
- Freeze authority present.
- LP not locked and not burned.
- Top single holder > 40% of supply.
- Honeypot pattern match (sell tax > 30%, transfer blacklist function present, other known-bad templates).

**Output:**
```json
{
  "agent": "memecoin.token_risk",
  "agentVersion": 1,
  "vetoed": true,
  "reasons": ["MINT_AUTHORITY_LIVE", "TOP_HOLDER_47PCT"],
  "score": null,
  "confidence": 1.0
}
```

**Events consumed:** `token.activity.detected`, `token.profile.updated`.

**Events produced:** `agent.analysis.completed`; if vetoed, `token.risk.vetoed`.

**LLM used:** No.

**Edge cases:**
- Token program is a known-safe standard (e.g. SPL-2022 with locked mint) → skip most checks, still validate holder distribution.
- Unable to fetch mint metadata (Helius error) → treat as VETO (fail-closed — better a missed trade than a rug).

**Setup Memory contribution:** none — vetoed signals never reach scoring, so their fingerprints are never recorded. Deliberate; Setup Memory should not contain rug-tainted samples.

---

### 40.14 Judge Agent (LLM, perp-only in MVP)

**Purpose:** LLM-driven qualitative synthesis over the structured evidence from all deterministic agents. Produces a narrative thesis, key risks, invalidators, and — critically — an independent direction/confidence read that can trigger the FLIP / STAND_ASIDE / DEFER gate (§18).

**Weight:** N/A — the Judge does not participate in the composite. It runs after the composite is scored, and can only override direction via the narrow §18 gate.

**Trigger:** EVENT — fires on `signal.created` after the Risk Agent has approved it (Risk INVALIDATED short-circuits — no Judge call on invalidated signals).

**Domain:** Perp in MVP. Memecoin scoped out — long-only domain, near-zero surface for the FLIP mechanism to fire, so the LLM cost isn't justified there (§18 memecoin scoping note).

**Inputs:** structured evidence package per §18:
- Every agent's normalized score, confidence, and key features.
- Composite Signal Score, deterministic direction/confidence.
- `historicalEdge` from Brain.
- Risk Agent's `risk_level` and flags.

**Calculations:** LLM synthesis. Model: DeepSeek V4-Flash (§18). Output must conform to structured JSON.

**Output:**
```json
{
  "agent": "judge",
  "agentVersion": 1,
  "direction": "SHORT",
  "confidence": 0.75,
  "thesis": "...",
  "keyRisks": ["..."],
  "invalidators": [
    { "type": "price_above", "value": 67200 }
  ],
  "confidenceTag": "moderate",
  "judgeAction": "FLIP"
}
```

`judgeAction` records the §18 gate outcome (FLIP / STAND_ASIDE / DEFER / AGREE) — the grouping key for §23 evaluation.

**Events consumed:** `signal.created` (post-Risk-approval).

**Events produced:** `agent.analysis.completed`, `judge.evaluation.completed` (triggers Prediction creation in the §18 flow).

**LLM used:** Yes — every fire is an `LLMCallLog` entry (§23).

**Edge cases:**
- LLM call fails / times out → Prediction still creates, deterministic-only, thesis/keyRisks/invalidators/judgeAction null. Structural graceful degradation, not an error state (§18 LLM failure section).
- LLM returns invalid JSON → treat as failure above.
- Memecoin — registered but disabled; the calling code short-circuits before invoking it, no cost incurred.

---

## Features (not Agents)

The composite weight tables (Part II §9, Part III §3) include a handful of rows that are Features rather than Agents (§7). They contribute a weighted scalar but have no trigger, no `agentVersion`, no `AgentPerformance` record, no `BrainAgentMemory`, and no user-facing toggle. Weights are settable (including to 0) but the feature computation itself isn't skippable.

---

### 40.15 Perp Volume Feature

**Purpose:** Volume-weighted candle-direction confirmation. Low-weight (5%) input — the *sign* of recent moves weighted by their volume.

**Weight:** 5% of perp composite.

**Computation:** on primary-TF candle close, over the last 10 candles:
```
volume_signed_direction = Σ (sign(close_i − open_i) × volume_i) / Σ volume_i
```
Range [−1, +1].

**Consumers:** Feature Aggregator only.

**Edge cases:** buffer < 10 candles → contribute 0, do not degrade the composite.

---

### 40.16 Perp Historical Edge Feature

**Purpose:** Reads `BrainSetupMemory` for the current fingerprint and contributes the domain's historical win-rate signal for setups that look like this one.

**Weight:** 5% of perp composite.

**Computation:**
1. Compute current fingerprint hash from the aggregated feature snapshot.
2. Lookup `BrainSetupMemory` row.
3. If `evidence: INSUFFICIENT` (effective-n < 10, Part II §8) → recurse to parent bucket per §8 backoff rule. If nothing has ≥ 10 → global base rate.
4. Signed contribution:
   - Sign from `sign(winRate − 0.5)` (win rate above 50% = bullish contribution in the trade's direction, so this feature amplifies rather than counters).
   - Magnitude scaled by Wilson CI width (narrow CI = strong contribution, wide CI = weak).

**Consumers:** Feature Aggregator, Judge Agent (as `historicalEdge` input to §18).

**Edge cases:** every layer of backoff reduces confidence attributed to this feature — a global-base-rate fallback contributes near-zero.

---

### 40.17 Memecoin Early-Entry Edge Feature

**Purpose:** For each buying wallet in a memecoin signal, aggregate its historical *early-entry* forward-return statistics (5m, 15m, 30m, 1h, 6h, 24h returns from historical entries). Rewards wallets that consistently get in early on winners even if their 24h holding-period P&L is mediocre.

**Weight:** 15% of memecoin composite.

**Computation:**
1. For each triggering wallet, read its stored early-entry stats from `BrainWalletMemory` (populated by the Wallet Intelligence pipeline, Part II §3).
2. Weight by wallet score × USD contribution.
3. Peak forward return across horizons is the primary signal (a wallet whose entries typically peak at +30% within 1h scores higher than one whose entries drift up +5% over 24h).

**Consumers:** Feature Aggregator.

**Edge cases:** unrated wallet (n < 10) contributes zero, doesn't skew the aggregate.

---

### 40.18 Memecoin Signal Freshness Feature

**Purpose:** Time-decay function since triggering wallet activity. A signal acted on 2 seconds after the wallet buy is worth more than one acted on 20 seconds later, because early wallets have already gotten better prices.

**Weight:** 5% of memecoin composite.

**Computation:**
```
freshness = exp(−Δt / τ)     where τ = 15 seconds (default, TBD from seed analysis)
```
Δt is elapsed time from the earliest triggering wallet buy to the signal creation time (includes detection lag + batching window). Range (0, 1].

**Consumers:** Feature Aggregator.

**Edge cases:** signal from a retriggered condition (§10 tick monitor retrigger) → Δt measured from the retrigger event, not the original wallet buy, otherwise every retrigger would trivially score 0.

---

### 40.19 Memecoin Historical Edge Feature

Same as Perp Historical Edge (§40.16) but reads memecoin `BrainSetupMemory` fingerprints (5-feature tuple, 243 cells, Part II §8). All other mechanics identical.

**Weight:** 5% of memecoin composite.

**Notable difference from perp:** memecoin has no historical seeding (§25), so this feature contributes `INSUFFICIENT`-driven parent-bucket or base-rate values much more often in the domain's early operation than perp does. The composite tolerates this by design — Historical Edge is only 5%, so early operation with mostly-INSUFFICIENT reads doesn't cripple decision-making, it just means the other 95% carries more of the load until Setup Memory fills.

---

## Cross-reference: what this section did NOT change

The Agent Catalog spells out the *numeric implementation details* of agents that were already named and weighted in earlier sections. It did **not**:

- Change any weights (Part II §9, Part III §3 stand).
- Change any trigger types (§7 taxonomy stands).
- Change any veto rules (Token Risk hard veto, Risk Agent post-aggregation gate, R:R veto, leverage-safety veto all stand).
- Change the Judge's §18 gate or the memecoin scoping note there.
- Change any Setup Memory fingerprint dimension (Part II §8 5-feature tuple stands; perp fingerprint stands).

Where a numeric parameter is specified concretely (e.g. `EMA(9,21,50)`, funding percentile > 90 for extreme), that number is the MVP default and lives in a versioned config so tuning doesn't require code changes. Where a parameter is deliberately left ranged (e.g. `batchingWindowMs` default 5000, freshness τ = 15s, profit-ladder rungs), the seed-history analysis pass (Part II §4) is expected to settle it before the corresponding subsystem ships.

---

## 41. Reference Function: BrainSetupMemory Update


Called on every closed prediction (from the outcome-resolution event handler in the paper
engine). Cross-referenced by both domains: perp uses the full 8-feature fingerprint (Part
III §6), memecoin uses the 5-feature tuple (Part II §8), but the update math is identical —
only the `halflifeDays` lookup differs.

**Why this is written out concretely.** The math is fiddly and easy to get subtly wrong.
The most common failure mode I want to preempt: applying recency decay to `wins` but not to
`n` (or vice versa) corrupts the Wilson interval silently — the point estimate looks fine,
the confidence bounds are nonsense, and nothing surfaces the bug until Setup Memory
recommendations start looking inexplicably confident. Both domains calling the same tested
function eliminates this whole class of drift.

**Wilson score interval** — well-behaved at small n and near 0/1, unlike the naive normal
approximation. For observations `X` (wins) out of `n` (trials), with confidence level
giving `z` (1.96 for 95%):

```
p̂         = X / n
denominator = 1 + z²/n
center     = (p̂ + z²/(2n)) / denominator
margin     = z × √[(p̂(1-p̂) + z²/(4n)) / n] / denominator
lower      = center - margin
upper      = center + margin
```

Wilson's derivation does **not** require integer counts, so passing effective-n (fractional,
recency-weighted) is mathematically valid — this is what Part II §8 refers to when it
mandates "Wilson's `n` and win count must both be the recency-weighted effective values."

### Reference implementation (TypeScript)

```typescript
// ─────────────────────────────────────────────────────────────
// Wilson score interval on effective (fractional) counts.
// ─────────────────────────────────────────────────────────────
function wilsonInterval(
    effectiveWins: number,
    effectiveN: number,
    confidence: number = 0.95,
): { lower: number; upper: number; center: number } {
    if (effectiveN <= 0) {
        return { lower: 0, upper: 1, center: 0.5 };
    }

    const z = confidenceToZ(confidence);        // 1.96 for 95%
    const p = effectiveWins / effectiveN;
    const z2 = z * z;

    const denominator = 1 + z2 / effectiveN;
    const center = (p + z2 / (2 * effectiveN)) / denominator;
    const margin =
        (z * Math.sqrt((p * (1 - p) + z2 / (4 * effectiveN)) / effectiveN)) /
        denominator;

    return {
        lower: Math.max(0, center - margin),
        upper: Math.min(1, center + margin),
        center,
    };
}

function confidenceToZ(confidence: number): number {
    // Lookup for common levels; use inverse normal CDF (via jStat or similar)
    // if arbitrary confidence levels are needed.
    const table: Record<string, number> = {
        '0.90': 1.6449,
        '0.95': 1.9600,
        '0.99': 2.5758,
    };
    const key = confidence.toFixed(2);
    if (!(key in table)) {
        throw new Error(
            `Uncommon confidence level ${confidence}, extend the lookup or use inverse-normal CDF`,
        );
    }
    return table[key];
}

// ─────────────────────────────────────────────────────────────
// BrainSetupMemory update — one call per closed prediction.
// Called from the outcome-resolution event handler in the paper engine
// (paper_trade.tp_hit / paper_trade.sl_hit / prediction.resolved).
// ─────────────────────────────────────────────────────────────

interface TradeOutcome {
    predictionId: string;
    setupId: string;
    domain: 'perp' | 'memecoin';
    closedAt: Date;
    won: boolean;
    returnPct: number;
    // Note: outcomeResolution (TICK | CANDLE_1M_CONSERVATIVE) lives on
    // PredictionOutcome separately, not needed here.
}

const HALFLIFE_DAYS: Record<TradeOutcome['domain'], number> = {
    perp: 90,       // Task 6 resolution
    memecoin: 30,   // Task 6 resolution
};

const TRUST_THRESHOLD_EFFECTIVE_N = 10;   // §25/§8 — Setup Memory trust bar
                                          // (hypothesis eligibility uses 20 separately, §24)

async function updateSetupMemory(outcome: TradeOutcome): Promise<void> {
    const halflifeDays = HALFLIFE_DAYS[outcome.domain];

    // Fetch existing row, or start fresh for a new fingerprint.
    // (No pre-flight "does this exist" check — the first close on a
    // fingerprint we've never seen is a normal case, not an error.)
    let row = await db.brainSetupMemory.findOne({ setupId: outcome.setupId });
    if (!row) {
        row = {
            setupId: outcome.setupId,
            domain: outcome.domain,
            occurrences: [],
            effectiveN: 0,
            effectiveWins: 0,
            winRate: null,
            medianReturn: null,
            wilsonLower: null,
            wilsonUpper: null,
            evidence: 'INSUFFICIENT',
            lastUpdatedAt: outcome.closedAt,
        };
    }

    // Append the new occurrence. History is never deleted; only its
    // influence on the current live estimate decays via the weights below.
    row.occurrences.push({
        timestamp: outcome.closedAt,
        won: outcome.won,
        return: outcome.returnPct,
        predictionId: outcome.predictionId,
    });

    // Recompute recency-weighted aggregates across ALL occurrences.
    // O(N) per update — N stays small in practice: memecoin runs one position
    // at a time with a 30d half-life, so old occurrences contribute ~0 to
    // effectiveN and stop mattering long before the row grows unwieldy.
    // Perp is broader but same shape. Optimize later (materialized aggregates,
    // periodic reindex) only if profiling shows this is a hot spot.
    const now = outcome.closedAt;   // "as of the newest outcome" — deterministic
    let effectiveN = 0;
    let effectiveWins = 0;
    const weightedReturns: Array<{ value: number; weight: number }> = [];

    for (const occ of row.occurrences) {
        const ageDays =
            (now.getTime() - occ.timestamp.getTime()) / (1000 * 60 * 60 * 24);
        const weight = Math.pow(0.5, ageDays / halflifeDays);

        effectiveN += weight;
        if (occ.won) effectiveWins += weight;
        weightedReturns.push({ value: occ.return, weight });
    }

    row.effectiveN = effectiveN;
    row.effectiveWins = effectiveWins;
    row.winRate = effectiveN > 0 ? effectiveWins / effectiveN : null;
    row.medianReturn = weightedMedian(weightedReturns);
    row.lastUpdatedAt = now;

    // Wilson CI on effective-n, not raw count (Part II §8 correction).
    if (effectiveN >= TRUST_THRESHOLD_EFFECTIVE_N) {
        const ci = wilsonInterval(effectiveWins, effectiveN, 0.95);
        row.wilsonLower = ci.lower;
        row.wilsonUpper = ci.upper;
        row.evidence = 'SUFFICIENT';
    } else {
        // Point estimate stored (row.winRate above), but flagged INSUFFICIENT.
        // Parent-bucket fallback happens at READ time — see the Historical
        // Edge feature (§40.16 perp / §40.19 memecoin). This function's job
        // is to keep this exact fingerprint's stats current; hierarchical
        // backoff is a read-side concern, kept out of the write path
        // deliberately so cached reads and future backfills stay consistent.
        row.wilsonLower = null;
        row.wilsonUpper = null;
        row.evidence = 'INSUFFICIENT';
    }

    await db.brainSetupMemory.upsert(row);
}

/**
 * Weighted median — value at which cumulative weight crosses half of total.
 * Standard algorithm for weighted samples.
 */
function weightedMedian(
    items: Array<{ value: number; weight: number }>,
): number | null {
    if (items.length === 0) return null;

    const sorted = [...items].sort((a, b) => a.value - b.value);
    const totalWeight = sorted.reduce((sum, x) => sum + x.weight, 0);
    if (totalWeight === 0) return null;

    const half = totalWeight / 2;
    let cumulative = 0;
    for (const item of sorted) {
        cumulative += item.weight;
        if (cumulative >= half) return item.value;
    }
    return sorted[sorted.length - 1].value;
}
```

### Notes for the implementer

- **Both domains call the same function**, differing only via `HALFLIFE_DAYS`. Do not fork
  it per domain; a bug in one is a bug in both, which is easier to catch than two subtly
  different bugs.
- **`TRUST_THRESHOLD_EFFECTIVE_N = 10`** is Setup Memory's own trust bar (§25/§8, lowered
  from 20). Hypothesis eligibility (§24) uses a separate `n ≥ 20` check at a different call
  site — do not conflate; if you find yourself considering "shouldn't these be the same
  constant?", re-read the split-rationale block in §24.
- **Parent-bucket backoff is a READ-side concern, not a write-side one.** This function
  never dips into the parent bucket, never recurses, and never writes fallback stats to
  the exact-fingerprint row. When `evidence: INSUFFICIENT`, the Historical Edge feature
  (§40.16 / §40.19) is the one that walks up the hierarchy. Keeping this split means
  cached reads stay consistent and future backtest replays produce the same numbers.
- **Store `effectiveWins` on the row**, not just `winRate`. The former is needed to
  recompute Wilson if we ever want to re-derive at a different confidence level; the
  latter is a convenience field derivable from the two `effective*` values.
- **`weightedReturns` list is transient** — recomputed per update. `medianReturn` is
  stored on the row directly since it's what downstream reads want. Do not store the
  full weighted list on the row; that grows unboundedly, unlike `occurrences` which
  can be periodically compacted if it ever needs to be (compaction is a future
  refinement — MVP writes the append and moves on).
- **The `now = outcome.closedAt` choice matters.** Recomputing weights "as of the newest
  outcome" (rather than "as of wall-clock time") means the update is deterministic and
  reproducible — a backtest replaying the same outcomes in the same order produces
  bit-identical Wilson intervals. Using wall-clock `now` would introduce drift between
  live and replay.
