# Database Reference

Every table in the platform, what it holds, and how it fits into the live loop. Grouped by
purpose. Schema definitions live in [`packages/database/src/schema.ts`](../packages/database/src/schema.ts).

**Two universal rules that apply to nearly every table:**

- **Rule 8 (immutability)** — facts (transactions, scores, predictions, config) are never updated
  in place. A correction writes a new row; the old row stays as history.
- **Rule 12 (DB-level correctness)** — every idempotency guarantee is a DB constraint (unique
  index, PK, `onConflictDoNothing`), never a check-then-write in application code.

---

## Group 1 — Event backbone

### `domain_event`
Durable log of every event that crossed the message bus. Every wallet transaction, every kline
close, every signal — they all leave a row here.
- **Why:** replay, debugging, and per-event auditing. Also the storage layer for the seeder's
  checkpoint markers (rows of type `brain-seeding.checkpoint`).
- **Written by:** the `EventBus` on every `publish`.
- **Never deleted** except by `reset-brain` (which only clears checkpoint markers).

### `processed_event`
The idempotency ledger. A consumer claims an event by inserting its `event_id` into this table
inside the same transaction as its effects.
- **Why:** exactly-once delivery. A duplicate BullMQ delivery hits the PK conflict and the
  handler skips. This is the structural enforcement of "at-least-once → exactly-once."
- **Written by:** `withIdempotency` wrapper + `withEventDedup` dispatcher wrapper (worker).

---

## Group 2 — Raw market data (backfill + live ingestion)

### `market_candle`
OHLCV bars for every perp symbol × timeframe. Composite PK on `(symbol, timeframe, open_time)`
makes backfills idempotent — re-running inserts zero duplicates.
- **Written by:** Bybit live WS on candle confirm + `npm run backfill` for history.
- **Read by:** every perp agent (via `recentCandlesAsOf`), the planner (pivot detection), the
  outcome resolver (`CANDLE_1M_CONSERVATIVE` mode reads 1m bars).

### `funding_rate`
Perp funding-rate history per symbol per stamp (usually every 8 hours).
- **Written by:** Bybit live adapter on-change + backfill.
- **Read by:** `perp.funding` agent (§40.5) — computes 30-day percentile → contrarian score.

### `open_interest`
OI snapshots per symbol per interval (default 1h).
- **Written by:** Bybit adapter (per-minute snapshot) + backfill (hourly).
- **Read by:** `perp.open_interest` agent (§40.2) — 5-bar delta vs price delta → 2×2 quadrant.

---

## Group 3 — Wallet intelligence (memecoin path)

### `wallet_transaction`
Normalized on-chain wallet actions from Helius. Provider-specific shapes never reach here
(rule 17 — normalization at the ingestion boundary).
- **Why:** the raw source of every wallet-behavior derivation. `tx_hash` unique = §29 dedup.
- **Written by:** Helius webhook → `packages/ingestion/src/helius/parse.ts`.
- **Read by:** trade reconstruction, wallet scoring, wallet-exit accumulator.

### `token`
Continuously-updated token profile — mint, symbol, name, decimals, first-seen, metadata JSON.
Keyed by `mint`.
- **Written by:** `upsertToken` on any new mint the parser encounters.

### `wallet_trade`
Reconstructed round-trip trades (M2). One row per (wallet × mint × open→close cycle) with
realized SOL P&L, buy/sell counts, holding period, won flag.
- **NOT a fact — it's a deterministic VIEW.** Whenever a wallet's `wallet_transaction` rows
  change, the reconstruction runs delete-then-insert for that (wallet, mint). Rule 8 doesn't
  apply here because the view is fully derivable.

### `wallet`
Wallet identity + rating status. Keyed by `address`. Small: `trade_count`, `status`
('rated'|'unrated'), `first_seen_at`, `last_scored_at`.
- **Written by:** the scoring pass every time a wallet is graded.

### `wallet_score_event`
**Append-only log of wallet scores** (§4, rules 8/16/21). "Score as of T" = the latest row with
`timestamp ≤ T`. Never updated in place; a re-score writes a new row.
- **Why:** no look-ahead. A backtest at T=January must read the score that was live at that
  moment, not today's. `configVersion` pins the exact `wallet_scoring_config` that produced it,
  so a weight change never rewrites history.
- **Written by:** `scoreAllWallets` (the 6h scheduled pass in the worker).

### `brain_wallet_memory`
Cached behavioral profile per wallet — the live "smart money" facts the Brain lookups need.
Updated when wallet scoring runs.
- **Why:** point-in-time reads without recomputing.

### `wallet_scoring_config`
Domain-level versioned config for wallet scoring (weights of the 7 sub-metrics, half-life,
trust threshold). Append-only. Every `wallet_score_event` FKs the version that produced it.
- **Why:** a weight change is a new row, never a mutation. Historical scores stay reproducible.

### `trade_outcome`
Wallet-level trade outcome analytics — per-wallet win rate, average early-entry edge, etc.
Feeds the wallet scoring composite.

### `watched_wallet`
The bot's watchlist. Address + optional note + soft-delete `unwatched_at`. Populated via the
`/wallets` API or `scripts/seed-wallets`.
- **Read by:** `BuyDetector` to gate incoming wallet transactions.

### `wallet_funder`
Cached mapping wallet → its first-hop SOL funder (M3 §5 heuristic). Cached once — a wallet's
original funder doesn't change.
- **Read by:** clustering — same funder = same cluster.

### `cluster_run`
One row per clustering pass. Versioned. Every recompute writes a new run and flips prior runs'
`status` from `active` → `superseded` in one transaction.
- **Why:** readers filtering on `status='active'` never see partial mid-flight data.

### `wallet_cluster`
Cluster membership for one run. `cluster_id` is shared across all members of one cluster.
- **Read by:** convergence emitter — collapses N wallets from one cluster into one signal.

---

## Group 4 — Trading agents & config

### `trading_agent`
User-created strategy entities (§14). Identity fields (`domain`, `universe`, `tradingStyle`)
are immutable per §8; everything tunable lives in `scoring_config` this row FKs to.
- **Also stores:** lifecycle state (§37: `IDLE`/`WATCHING`/`PENDING_ENTRY`/`IN_TRADE`/
  `COOLDOWN`/`BLOCKED`) with an optional `lifecycle_until` for timed states.

### `scoring_config`
Append-only versioned config. Every `Prediction` FKs the exact `(agentId, version)` that was
active when it was created (rule 16 — never blend versions).
- **Why:** changing a weight writes a new row. Old predictions stay attributable to the config
  they were made under. "Did this change help?" becomes answerable.

### `agent_performance`
Per (agentKey, agentVersion) live scorecard — fired count, agreement rate with composite,
version-scoped so a version bump starts a clean slate.

---

## Group 5 — Brain memory (the learning layer)

### `brain_setup_memory` — the SETUP cheat sheet
One row per **unique fingerprint** (the discretized hash of the domain's 8-dim perp / 5-dim
memecoin feature tuple, per §8). Primary key IS the `setup_id` (fingerprint hash).
- **Holds:** effective-n (recency-weighted count), effective-wins, win rate, Wilson 95% CI,
  median return, evidence tier (SUFFICIENT if effective-n ≥ 10, else INSUFFICIENT).
- **Read by:** Historical Edge feature (§40.16) — live signals compute the current fingerprint,
  look it up here, and the composite scores gets a "based on N similar past trades, hit rate
  was X" boost.
- **Rebuilt from:** `brain_setup_occurrence` (the journal).

### `brain_setup_occurrence` — the SETUP journal
**Append-only log — one row per (prediction × fingerprint rung)**. Multiple rows per prediction
because of the backoff ladder (the same prediction contributes to the exact fingerprint AND
progressively coarser sub-fingerprints).
- **Why:** the plan is emphatic — "older occurrences count less, not deleted; the full history
  stays queryable, only its influence on the current live estimate decays" (Part II §8).
- **Unique on (prediction_id, setup_id)** — the rule-12 idempotency guard against replayed
  outcome events double-counting.

### `brain_agent_memory` — the AGENT scorecard
One row per **(agentKey, agentVersion)** — the analyst's report card:
- fired count, effective-n, win rate when this agent was directionally correct, confidence
  calibration.
- **Read by:** Attribution page (§22) — "which factors actually had predictive value";
  Confidence formula (Task 6) — down-weights an agent that's been individually wrong lately.
- **Rebuilt from:** `brain_agent_occurrence` on each seed/live outcome via `persistAgentMemory`.

### `brain_agent_occurrence` — the AGENT journal
**Append-only log — one row per (prediction × contributing agent)**. Records what each agent
said (direction + score + confidence) and what actually happened (realized direction). ~6 rows
per prediction (one per participating perp agent).
- **Why:** enables "did the Momentum agent's HIGH-contribution predictions actually win more
  often?" — the whole §22 attribution question.

### `brain_wallet_memory` — see Group 3 (memecoin-specific)

### `brain_token_memory` — the TOKEN cheat sheet
One row per mint. Profile + composite quality score + outcomes stats + evidence tier.
- **Written by:** `upsertTokenMemory` when a token profile updates.
- **Read by:** `memecoin.token_quality` agent (§40.10) at signal time.

---

## Group 6 — Signals

### `signal`
Every direction-carrying signal the composite produces (§9). One row per fired signal.
- **State machine (§36):** `ACTIVE → EXPIRED | INVALIDATED | CONSUMED`. TTL enforced by the
  60s expiry sweep in the worker.
- **Fingerprint dedup** — `(tradingAgentId, symbol, direction, tfCloseMinute)` unique. Two
  agents' composites landing on the same fingerprint in the same candle count as one signal
  each.

### `signal_feature`
**One row per (signal × contributing agent).** Persists every agent's raw output — direction,
score, confidence, full features JSON.
- **Why:** the source of truth for §22 attribution AND the input the fingerprint tuple gets
  assembled from (rule 24 — Brain writes read `signal_feature`, not any stored fingerprint).

### `signal_risk`
The §40.12 Risk Agent's verdict per signal — level (`LOW`/`MEDIUM`/`MEDIUM_HIGH`/`HIGH`/
`INVALIDATED`) + flags array. `INVALIDATED` transitions the parent signal.

### `signal_no_trade`
Records WHY the planner refused a signal (`INSUFFICIENT_RR` / `CANNOT_SIZE_SAFELY` /
`NO_STOP_DERIVABLE` / `STALE_OR_MISSING_DATA` / `CORRELATED_EXPOSURE_CAP`) + optional detail.
- **Why:** the signal is INVALIDATED but WHY matters — the operator wants to see whether the
  bot is refusing lots of trades because of the R:R gate or because of missing data.

---

## Group 7 — Predictions & outcomes

### `prediction`
**Immutable trade decisions.** INSERT-only, enforced by a Postgres trigger (`prediction_no_delete`)
that physically rejects DELETE and UPDATE.
- **Holds:** every field of the trade setup (entry, SL, TP, size, leverage, R:R, horizon),
  plus a `configVersion` FK (rule 16) and shadow columns for §18 counterfactuals.
- **`brain_written_at`** is the at-most-once marker for feeding this prediction's outcome into
  the Brain. Once stamped, `feedBrainOnce` short-circuits — a replayed sweep can't double-count.

### `prediction_outcome`
**One row per (prediction × horizon)** — Task-7's multi-horizon evaluation. For each style,
the resolver writes outcomes at every horizon (scalp: 5m/15m/30m/1h).
- **Holds:** won bool, return %, benchmark return %, alpha, MFE/MAE, hit-target flag,
  hit-invalidation flag, holding period, resolution mode (`TICK` or `CANDLE_1M_CONSERVATIVE`).
- **PK on (prediction_id, horizon)** — idempotent, a re-run inserts zero.

---

## Group 8 — Paper trading

### `paper_portfolio`
One per trading agent. Cash, equity, peak equity, max drawdown, realized P&L. Get-or-created
on first entry by the entry orchestrator (or up-front by the API on agent creation).

### `paper_position`
One row per opened position. State machine: `PENDING_ENTRY` (LIMIT waiting) → `OPEN` → `CLOSED`
(with `close_reason`: STOP_LOSS / TAKE_PROFIT / HORIZON_EXPIRY / WALLET_EXIT / LIMIT_EXPIRY)
or → `EXPIRED` (LIMIT window elapsed).
- **Unique on prediction_id** — one prediction, one position (real). Shadows (`is_shadow=true`)
  share the same signal but are counted separately for capacity.
- **Both clocks** (§20 detection-lag): `opened_at_event` vs `opened_at_processing`.

### `paper_position_fill`
**One row per fill.** Entry, then per-rung ladder fills (memecoin), then the final close.
`sizeFraction` is the fraction of the ORIGINAL notional this fill covered. `isFinal=true` on
the row that fully closes the position.
- **Why:** every close-price calculation reads a fill row — no fabricated prices.

### `paper_position_originating_wallet`
**One row per (position × originating wallet)** for memecoin positions. Records what fraction
each wallet contributed to the entry signal + how much of its position it still holds
(`current_held_fraction`).
- **Read by:** the wallet-exit accumulator — "the cluster has sold X% of its aggregate stake,
  cross the threshold and dump."

### `wallet_sell_observation`
**Append-only log of every wallet SELL** observed while an originating wallet's memecoin
position is open. Whether or not it crosses the exit threshold, it's recorded.
- **Why:** the learning loop needs the full raw signal to answer "does a partial cluster-sell
  usually precede a full dump, or is it a false alarm?"
- **Unique on (position, wallet, tx_signature)** = §29 dedup against redelivered webhooks.

### `active_token_claim`
**One row per currently-held memecoin mint (§9a).** Primary key IS the mint — the PK is the
atomicity. Two agents trying to claim the same mint = one succeeds, one gets a DB conflict.
- **Lifetime:** row exists only while a position is HELD; released on every close route
  (`releaseTokenByPosition` in tick monitor + wallet-exit monitor + entry-orchestrator error
  paths).

---

## Group 9 — LLM / Judge / Learning loop

### `llm_call_log`
**Every LLM call** — Judge, autopsy, anything future. `predictionId` / `signalId` FK-shaped
back for cost-per-thing attribution. Prompt tokens, completion tokens, USD cost (computed at
call time from the code-side pricing table — a future price change never rewrites history),
latency, success/errorKind.
- **Written by:** `callWithLog` in `@tip/llm` — the ONLY writer, by design. A caller that
  bypasses it would collapse §23's cost-vs-value question.

### `judge_decision`
One row per Judge evaluation. Records deterministic direction + confidence, Judge direction +
confidence, the confidence gap, the resulting `judgeAction` (`AGREE` / `DEFER` / `FLIP` /
`STAND_ASIDE`), and whether the flip was refused by the planner. Version-scoped so the
override-gate thresholds it ran under are known later.

### `trade_autopsy`
**One row per closed prediction the autopsy runner processed** (perp only in MVP).
`root_cause`, `failure_category` OR `success_factor`, LLM-generated explanation +
recommendation. `llm_call_log_id` FK back to the call that produced it.
- **Unique on prediction_id** — one autopsy per closed prediction.

### `learning_hypothesis`
The hypothesis pipeline's queue. State machine: `PROPOSED` → `BACKTEST_PASSED` → `OOS_PENDING`
→ `PROMOTED` | `REJECTED` | `DEFERRED_BOOTSTRAP`.
- **Why:** autopsies aggregate into hypotheses ("category X keeps failing — try changing
  agentWeight[Y] by delta Z"); each hypothesis is a candidate config change with a full
  backtest audit trail before it can promote.

---

## Group 10 — Governance / cross-cutting

### `active_token_claim` — see Group 8 (§9a atomicity guard)

### `processed_event` — see Group 1 (§29 idempotency ledger)

---

## Quick cheat sheet — where to look for what

| I want to know… | Look at… |
|---|---|
| Did we trade this bar? | `signal` (fired?), `prediction` (planned?), `paper_position` (opened?) |
| Why didn't we trade this signal? | `signal_no_trade` (planner veto) or `signal_risk` level=INVALIDATED |
| What did each agent contribute to this signal? | `signal_feature` |
| Did this prediction win? | `prediction_outcome` at the planning horizon |
| What's the Brain's opinion on THIS market condition? | `brain_setup_memory` at the fingerprint |
| Is agent X actually predictive? | `brain_agent_memory` / Attribution page |
| Who's holding this mint right now? | `active_token_claim` |
| What did the Judge say + how much did it cost? | `judge_decision` joined with `llm_call_log` |
| Was this position force-closed by the cluster dumping? | `paper_position.close_reason='WALLET_EXIT'` + `wallet_sell_observation` |
| Full audit trail from raw event → outcome | `domain_event` → `wallet_transaction` OR `market_candle` → `signal` → `signal_feature` → `prediction` → `paper_position` → `paper_position_fill` → `prediction_outcome` → `brain_setup_occurrence` → `brain_setup_memory` |

---

## Two mental models for the flow

**Live path (what your worker does):**
```
kline close                                              paper_position
   ↓                                                          ↑ opens
domain_event                                             prediction
   ↓                                                          ↑ creates
market_candle  →  analysis agents  →  signal_feature  →  signal
                                                          (Risk gate + Judge)
```

**Learning path (what seed and outcome sweep do):**
```
prediction (with its signal_feature contributions)
   ↓ resolved
prediction_outcome (at each horizon)
   ↓ feedBrainOnce at the planning horizon
brain_setup_occurrence  +  brain_agent_occurrence   (journals)
   ↓ aggregate
brain_setup_memory      +  brain_agent_memory       (cheat sheets)
   ↓ read at signal time by
Historical Edge feature (§40.16)  →  future signals get smarter
```

Everything else — wallet intelligence, cluster runs, Judge decisions, autopsies, hypotheses —
attaches to these two axes.
