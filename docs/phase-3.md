# Phase 3 — Deterministic strategy engine

## Delivered interfaces

`packages/strategies` defines `StrategyDefinition`, `StrategyRequirements`, `StrategyContext`, `StrategyTrigger`, `EntryDecision`, `PendingEntry`, `PositionSnapshot`, management policies, `EvaluationSnapshot` and `EvaluationRepository`. Strategies own timeframes, indicator requirements and management rules. Entry, pending-invalidation and position-assessment methods are synchronous and receive deeply readonly data; the built-in definitions and inputs are frozen at runtime.

`buildContext` selects contiguous, validated, fully closed native candle series and computes named TA-Lib snapshots. `preview` produces a deterministic decision and immutable evidence. `StrategyEngine` adds repository-backed idempotent recording. Strategies receive no database, credentials, exchange adapter, notification sender or order-placement interface. Static architecture tests reject network/database/execution imports and ambient clock/randomness in the pure implementation modules. Only the two reviewed built-in research definitions are registered; this is not a security sandbox for arbitrary user-supplied JavaScript.

`PostgresEvaluationRepository` commits against the current idle bot configuration and registered code hash. PostgreSQL uniquely keys `(bot, strategy version, trigger type, trigger event key)`, validates configuration/account/strategy metadata and makes evaluation history append-only. Concurrent replay returns the original record; it never rewrites the original input knowledge or decision. No order intent, risk reservation, fill, notification or capital posting is created by the engine, including for an actionable proposal.

## Research defaults selected for this phase

The PRD leaves concrete indicator presets open. The following **provisional research defaults** implement testable software behavior. They are not profitability-validated settings. Both definitions are version **0.1.0**, preset `research-default`, with database status **DRAFT** and `validationStatus: RESEARCH_UNVALIDATED`. Old 0.0.0 placeholders and existing bot assignments are preserved. Changes to a registered definition require a new immutable version.

| Rule                             | Trend following                                                                                                                    | Mean reversion                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Primary/confirmation             | 15m / most recent closed 1h                                                                                                        | 5m / none                                                                                   |
| Initial history                  | 500 complete bars per required frame, subject to indicator stability minimums                                                      | 500 complete 5m bars, subject to indicator stability minimums                               |
| Indicators                       | Primary EMA20/EMA50, ADX14, ATR14; hourly EMA50                                                                                    | RSI14, Bollinger20 with two deviations, ADX14, ATR14                                        |
| LONG                             | EMA20 above EMA50 and rising, close above EMA20, closed hourly close above EMA50, ADX >=25                                         | Close at/below lower band, RSI <=30, ADX <25                                                |
| SHORT                            | Symmetric bearish EMA, close and hourly confirmation; ADX >=25                                                                     | Close at/above upper band, RSI >=70, ADX <25                                                |
| Volatility                       | ATR/close between 0.001 and 0.05, inclusive                                                                                        | Same                                                                                        |
| Entry proposal                   | MARKET with closed-candle reference price; stop 2 ATR, target 2 initial R                                                          | MARKET with closed-candle reference price; stop 1.5 ATR, target current middle band         |
| Pending invalidation             | Expiry after two primary candles; cancel if directional/confirmation thesis or ADX >=25 entry requirement no longer holds          | Same expiry; cancel if ADX enters trend regime or price has already reverted to middle band |
| Position reassessment            | Exit on directional/confirmation invalidation or ADX <20; propose ATR2 stop only when it tightens; time exit at 32 primary candles | Exit on ADX >=25, middle-band reversion, or 12 primary candles                              |
| Declared price-management policy | Break-even at 1R, ATR2 trailing                                                                                                    | Break-even/trailing disabled                                                                |

Position assessment and stop proposals are pure suggestions. Actual pending-order cancellation, TP/SL monitoring, break-even/trailing activation, confirmation and state transitions arrive in Phase 4. They are not assumed executed. Minimum quantities, tick rounding, fees, execution prices and central risk approval arrive in Phase 5. MARKET reference prices are analysis inputs, not promised fills. Native indicator floats are converted to decimal with 12 significant digits for proposed monetary calculations; persisted proposal prices use at most 18 decimals. This does not replace instrument precision or risk checks.

`NO_TRADE` reasons include `NO_SETUP`, `WEAK_TREND`, `CONFLICTING_SIGNALS`, `MARKET_REGIME_UNSUITABLE`, `VOLATILITY_UNSUITABLE`, `INSUFFICIENT_DATA`, `DATA_GAP`, `STALE_DATA`, `INVALID_DATA` and `MARKET_DATA_UNHEALTHY`. These remain separate from downstream risk rejections, expired entries and executed trades.

## Event time, availability and reproducibility

A primary candle event has a source `eventTime` and an injected `observedAt` decision timestamp. Market history is limited to closes at/before source event time; knowledge is limited to candles actually available/observed by decision time. A 12:15 primary close may use a bar received at 12:15:01 for a 12:15:02 decision, while still excluding an unfinished 12:00–13:00 hourly bar and any later primary bar. The last completed confirmation timeframe is chosen independently. A primary event delayed until the next primary close yields `STALE_DATA`, preventing old signals from becoming fresh entries.

The Phase 2 `calculateIndicator` contract gains an optional fourth argument `availableAsOf` (defaulting to its prior cutoff behavior). `asOf` still limits candle closes; `availableAsOf` separately limits knowledge arrival. Existing three-argument callers remain compatible. No wall-clock calls occur inside strategy decisions. All meaningful timestamps are injected.

Snapshots retain exact selected closed-candle inputs, named latest/previous indicators and native engine version, quality reasons, trigger, config version, research parameters, management policy and SHA-256 code identity. The code identity hashes strategy contracts/context/helpers/rules/engine and the TA-Lib adapter sources. Builds copy those exact TypeScript sources alongside compiled JavaScript as evidence, making the source/compiled fingerprint stable. Native package versions are pinned in the lockfile. Registration refuses changed source or parameters under an existing version. The registry/composition layer performs file I/O; pure strategies do not.

Full input snapshots favor auditability in this first implementation and have storage cost. Later dataset manifests/retention work must preserve their reproducibility; do not silently discard or mutate evidence. Strategy evaluation remains advisory: Phase 4 must authorize only fresh decisions in an eligible, reconciled runtime, rather than treating historical evaluation rows as commands.

## Run and inspect

```sh
nvm use
npm ci
npm run db:migrate
npm run strategies:register
```

Registration adds immutable 0.1.0 research definitions without changing bot configuration, account funding, old strategy versions or any exposure. Bootstrap also registers these definitions for a new installation. Use the returned strategy-version UUID when creating a research bot. Future bot start/pause/resume controls remain unavailable until Phase 4.

An offline preview reads stored candles and calculates a proposal without persisting a bot evaluation or sending orders:

```sh
npm run market:seed -- --base BTC --timeframes 15m,1h --count 500
npm run strategy:preview -- --strategy trend-following --base BTC

npm run market:seed -- --base BTC --timeframes 5m --count 500
npm run strategy:preview -- --strategy mean-reversion --base BTC
```

These are software inspection examples, not recommended trades. Preview output clearly labels `OFFLINE_RESEARCH_PREVIEW`, `persisted: false` and `executionEnabled: false`. It checks stored candle completeness/availability, but intentionally does not claim live transport, account or execution readiness. A stale/missing dataset returns an explicit NO_TRADE. Continuous strategy scheduling and durable runtime dispatch are Phase 4 work.

Authenticated API additions:

- `GET /api/strategies` includes immutable `codeHash` and implemented research requirements/parameters/policy.
- `GET /api/bots/:id/evaluations?limit=20` returns the latest evaluation metadata/indicator snapshots. Limit is 1–100; full candle arrays are omitted from list results to bound response size.
- `GET /api/bots/:id/evaluations/:evaluationId` returns one full immutable snapshot, including input candles. Bot/account ownership and authorization are required for both routes.

The event-driven `MARKET_EVENT` contract supports exchange event IDs, event/observation time, positive price/quantity and explicit LAST reference. A controlled test strategy exercises this interface; no arbitrage strategy or executable arbitrage adapter is implemented.

## Verification and acceptance

Commands: `npm run check`, `npm run format:check`, `npm audit`, `npm run db:migrate`, `npm run db:generate`, `npm run strategies:register`, and offline source/compiled preview checks.

Reviewed golden scenarios in `tests/fixtures/strategy-golden.json` cover trend LONG/SHORT, weak trend, conflicting hourly confirmation, mean-reversion LONG/SHORT, no extreme and unsuitable trending regime. Their histories are explicitly **synthetic**, reproducible functional fixtures. Expected price levels and reason codes are reviewed against the documented rules; they do not constitute historical profitability validation. Backtests, walk-forward/holdout studies and forward paper results remain later gates.

Tests also cover future/unfinished higher-timeframe exclusion, arrival-time boundaries, delayed old signals, gaps/staleness, mixed markets, immutable snapshots, clock independence, event triggers, no entries in pending/open/closing/unresolved states, pending expiry/thesis invalidation, both directions of stop tightening, mean-reversion management and time exits. Native PostgreSQL tests verify concurrent duplicate recording, restart idempotency, immutable code/config linkage, NO_TRADE without capital/config side effects, rejected stale/miswired metadata, account-isolated history/detail APIs and SQL-level snapshot constraints. Earlier phase gates remain in the suite.

**Final result:** 46 unit/protocol/strategy tests and 19 PostgreSQL/process integration tests pass (65 total). TypeScript, formatting and production builds pass; dependency audit reports zero vulnerabilities, and migration generation reports no schema drift. Development registration was run twice and preserved strategy-version IDs. Source and compiled strategy code fingerprints match. Both source trend and compiled mean-reversion previews ran against freshly seeded public candle histories with execution disabled and no persisted preview evaluations.

No automated runtime, orders, positions, capital accounting or production LIVE capability is enabled by Phase 3. Next is Phase 4's runtime and position state machine against a strict fake execution adapter.
