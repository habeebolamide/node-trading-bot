# Change: audit-gap-remediation

**Status:** COMPLETED — archived 2026-09-02
**Original status:** PROPOSED (from a strict plan re-audit)

> **COMPLETED.** Closes the ten highest-severity gaps found in a strict section-by-section
> re-audit of `trading-intelligence-master-plan.md` after the Telegram omission was discovered.
> The audit produced a severity-ranked list of ~21 partial/deferred/missing items; this change
> lands #1–#10. Items #11–#21 (lower severity — memecoin fill orchestrator, Telegram alerts,
> autopsy/hypothesis pipeline live wiring, dashboard WS deltas, etc.) remain open and are noted
> at the bottom of `tasks.md`.
>
> **Verified:** `npm run typecheck` green; full suite **690 passed / 3 skipped** (the 3 skips
> are live-API integration tests — Bybit REST + Helius REST — that require keys). No real-money
> paths introduced (rule 20). Config changes remain versioned/append-only (rule 16).

## Why

A strict re-audit was commissioned after the plan's Telegram requirement was found un-built —
the operator's concern being "if you missed that, what else did you miss?" The audit walked
every plan section and classified each requirement as built / partial / deferred / missing.
This change remediates the ten most load-bearing gaps, in severity order.

## What ships (severity order)

Landed across three commits:

**Commit 1 (audit #3/#4/#5)** — `§37 agent lifecycle + dailyLossLimit + feed-staleness`
- **#3** §37 Trading Agent Lifecycle state machine (IDLE/WATCHING/PENDING_ENTRY/IN_TRADE/
  COOLDOWN/BLOCKED), derived vs sticky states, `tickLifecycle` sweep.
- **#4** `dailyLossLimit` circuit breaker — UTC-day realized-P&L accumulator trips a timed BLOCK
  to next UTC day.
- **#5** Feed-staleness → BLOCKED (§10). Stale feed blocks the affected symbol's agents
  indefinitely; recovery clears only indefinite blocks, never a timed daily-loss block.

**Commit 2 (audit #1/#2)** — `live analysis tier: perp pipeline + Judge wiring + tick monitor`
- **#1** Perp analysis tier consumes `perp.kline.closed`, runs the perp agents per eligible
  agent on its primary-TF close, admits to a per-agent SignalEngine; Judge tier consumes
  `signal.created` → Judge → `judge.evaluation.completed` → override gate / flip planner
  (no-op without `DEEPSEEK_API_KEY`).
- **#2** Tick monitor drives `evalTick` (STOP/TP/HORIZON) + `evalPendingTick` (LIMIT fill/expiry)
  per perp kline close; IN_TRADE → COOLDOWN on close.

**Commit 3 (audit #6–#10)** — this commit
- **#6** Helius AMM reserve resolution (`packages/ingestion/src/helius/reserves.ts`) — pool-vault
  identification heuristic + RPC `getTokenAccountBalance` read behind an injectable `FetchLike`;
  returns `null` → the fill model NO_FILLs (rule 25). The vault heuristic is documented as needing
  real-fixture validation before it drives live fills.
- **#7** Platform-wide atomic token claim (`packages/agents/src/memecoin/token-claim.ts`, §9a) —
  `claimToken` via `onConflictDoNothing` on the `active_token_claim` PK (mint) = atomic;
  `resolveContention` does greedy global assignment (score desc, agentRank asc, mint). Migration
  `0022` adds the table.
- **#8** Multi-TF analysis (§8). Momentum now reads its style's analysis-TF stack (scalp
  1m/5m/15m · day 15m/1h/4h · swing 4h/1d) and scales confidence by cross-TF agreement. Also
  replaced the Historical-Edge *stub* in the perp analysis tier with the real §40.16 Brain read:
  the tier now assembles the full 8-dimension perp fingerprint tuple (rule 24) from the agents'
  outputs and calls `perpHistoricalEdge`.
- **#9** Fast-lane priority actually used (§11). `PRIORITY.FAST` now rides the reaction-path
  emitters that exist: paper-fill SL/TP hits (tick monitor), smart-money wallet detection
  (Helius ingest), and the Judge/override emitters (judge evaluation, STAND_ASIDE, FLIP).
- **#10** `maxPoolShare` enforced at fill time (§10). `memecoinBuyFill` now caps the notional to
  `maxPoolShare × ySol` ("cap first, then fill") and NO_FILLs `BELOW_MIN_AFTER_CAP` when the cap
  pushes size under a usable minimum. Fill time is the only point with actual reserves (§20 reads
  reserves at detection time; the planner never saw them).

## Deviations / resolved ambiguities

- **#8 volume & volatility dimensions.** Six of the eight perp fingerprint dimensions are direct
  agent scores. The other two are derived from fields those agents already emit: volatility from
  Market Regime's `atrRatio` (1.0→MED, 1.5→HIGH, 0.5→LOW), volume from Momentum's
  `currentVol/avgVol` expansion signed by the momentum direction — a documented proxy for the
  §40.15 Volume feature, which needs a candle buffer the tier doesn't assemble. If any dimension
  is absent the tuple is partial (rule 24 forbids fingerprinting it), so the tier omits the 5%
  Historical-Edge term rather than aliasing into a wrong cell.
- **#9 Telegram not yet emitting.** §11's canonical fast path is detection → fill → *telegram*.
  No Telegram emitter exists yet (that is audit item #11+), so FAST was applied to the reaction
  emitters that do exist. When Telegram lands it inherits FAST.
- **#10 no live memecoin caller.** The memecoin fill *orchestrator* isn't wired (perp is the live
  MVP path), so the cap lives in the pure `memecoinBuyFill` and is unit-tested there; the live
  path threads `config.maxPoolShare` when it lands.

## Plan sections implemented

§8 (multi-TF), §9a (token claim), §10 (pool-share cap, eligibility HARD GATES), §11 (fast lane),
§20 (depth-aware fills, detection-time reserves), §37 (agent lifecycle), §40.16 (Historical Edge),
rules 21/22/24/25.
