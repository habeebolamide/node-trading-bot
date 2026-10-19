# Phase 6 — historical replay, validation and recovery

The replay worker uses the installed StrategyEngine/TA-Lib, BotRuntime/PositionManager, PostgreSQL runtime repository, PAPER execution adapter, risk sizing, capital reservations and append-only ledger from Phases 3–5. A virtual clock replaces wall-clock market time; lease/fencing authorization still uses PostgreSQL time. LIVE remains disabled.

## Isolation and reproducibility

Each run has a dedicated synthetic PAPER account, a separate synthetic user with no API token, and its own coin-ownership scope. Its report belongs to the authenticated user who queued it. The forward supervisor explicitly excludes replay accounts. Global forward coin exclusivity remains unchanged; a portfolio replay enforces coin exclusivity and all account allocation/exposure limits inside its own scope. Historical instruments are stored per replay account, and replay never writes historical assumptions into the forward instrument/candle caches.

Immutable run input includes dataset name/version, complete candle/event/instrument snapshots, seed, bot configuration, strategy identity, management variants, fee/slippage/liquidity policy and measured window. A manifest pins strategy source hashes, execution-model version, runtime/risk/accounting/replay source hashes and SQL migrations. Resuming under changed implementation bytes fails rather than silently mixing versions. Compiled deployments retain those sources as identity evidence.

A dataset is validated in observation order, with price trades also ordered by source event time. Equal-time trades require exchange sequence evidence. Seed candles are closed and available before they can enter a decision; higher-timeframe cutoffs still use the existing strategy context checks. Indexed histories pass the same required history lengths used by forward PAPER. Seeded fixture candles and counter-based seeded participation are reproducible and independent of random database IDs.

Measured windows are half-open `[start, end)` to prevent shared-boundary outcome leakage. They start with fresh capital/positions and only earlier candles for warm-up. No position is silently liquidated at the end; remaining exposure is reported. The report strips database identities from economic output, so identical input/version/seed produces identical reports. Immutable facts and per-event checkpoints support replay after a crash between applying an event and checkpointing it. Runs are leased by the worker; a second worker cannot take a current lease. Interrupted jobs remain resumable.

## Data and execution assumptions

`ReplayInput` and its validating schema are in `packages/replay/src/contracts.ts`. Inputs specify `version: "replay-v1"`, `start/end` UTC epoch milliseconds, a seed, baseline, bots, and a dataset containing seed candles, instrument snapshots and ordered events. Events are `CANDLE`, `PRICE`, `TIMER`, `FUNDING`, `GAP_START` and `GAP_END`.

The existing PAPER model supplies fees, adverse slippage/tick rounding, latency, minima, partial fills, confirmed simulated protection and reduce-only exits. Risk/execution policy overrides use the Phase 5 validated policy object. Liquidity can use fixed participation or seeded participation with a configurable minimum factor. A `FUNDING` event supplies an observed payment period, signed rate and reference price; the shared funding repository determines the authoritative filled quantity at that period, charges longs/credits shorts for a positive rate and posts once per trade/payment period. Duplicate and stale-owner funding calls cannot book twice, including late reporting after a position has closed.

Instrument provenance is explicitly `HISTORICAL` or `CURRENT_ASSUMPTION`. Historical snapshots must cover the whole measured window; a current specification assumption is labeled in the report. Changing tiers/specification regimes should be split into separately covered datasets/windows; the engine does not invent missing historical constraints. `fundingCoverage: "OMITTED"` warns that net results exclude unavailable funding; supplied funding observations are applied at their availability time. `COMPLETE` funding coverage is the importer's provenance assertion, not an independently verified exchange guarantee.

Trade coverage is `COMPLETE_ORDERED`, `PARTIAL` or `NONE` (default PARTIAL). Only a dataset asserting complete ordered evidence may reconstruct fills. Partial/missing trade tape with an actionable pending/open lifecycle becomes `RECONCILIATION_UNCERTAIN`; OHLCV alone never fabricates an entry fill, a favorable TP-before-SL path or a precise fill price. Imported completeness assertions must come from a trustworthy capture/range source; a hash verifies identity and order, not the truth of an external provider's completeness claim. Bybit's existing recent-trade interface cannot certify a complete missing range.

## Reports and validation

Reports persist evaluations, NO_TRADE reasons, long/short proposals, risk rejection reasons, expiries, filled/closed/open trades, realized net P&L, marked ending equity/return, fees, signed funding, embedded execution slippage, win rate, profit factor, expectancy, average wins/losses, drawdown, losing streak, capacity usage, holding times, close reasons, coverage and uncertainty. Ratios without a valid denominator are null. Open positions and small samples are visible. Equity curves are reconstructed from original observation times after recovered facts arrive, without rewriting any ledger entries. Same-millisecond samples represent the complete known economic state at that timestamp.

No strategy is automatically promoted to VALIDATED or declared profitable. These are software-correctness and research outputs.

Experiments pin two or more variants to the same dataset, seed and baseline, and validate disjoint training, walk-forward test and untouched holdout outcome windows. Management variants receive distinct immutable strategy versions/code identities. Supported overrides include break-even, trailing, early exit and holding-time policy; pending-entry expiry remains part of the installed strategy definition. A/B comparison rejects mismatched datasets/seeds. Holdout stays locked until every variant's training/test jobs complete without uncertainty and an owner records a variant selection plus reason. Selection freezes further training/test changes and cannot be replaced after viewing holdout. Test windows use independent accounts and prior observed candles; there is no automatic parameter fitting or arbitrary profitability threshold.

## Commands and endpoints

Run on Node 22 after `npm run db:migrate`:

```sh
npm run dev:worker
npm run backtest -- --file /absolute/replay-input.json --owner owner@localhost.test
```

The CLI prints a durable run ID; the separate worker processes it. Add `--run` to execute in that CLI process instead. Large datasets use the local file interface; the API retains its 32 KB JSON limit. For a validation file shaped as `{ "plan": { "training": ..., "tests": [...], "holdout": ... }, "variants": [{ "key": "a", "input": ... }, { "key": "b", "input": ... }]`, add `--experiment`; it queues only training/test jobs and leaves holdout locked.

Authenticated, account-scoped endpoints:

- `POST /api/backtests`, `GET /api/backtests`, `GET /api/backtests/:id`.
- `POST /api/backtest-experiments`, `GET /api/backtest-experiments/:id`.
- `POST /api/backtest-experiments/:id/runs` with `variant`, `stage` (TRAIN/TEST/HOLDOUT), optional `windowIndex`.
- `POST /api/backtest-experiments/:id/selection` with `variant` and `reason`.

Mutations require OWNER permission. Read-only users can inspect their owner's reports. Worker readiness checks the replay schema and reports its own job capability; it never accepts trading entries.

## Disconnects and recovery

Forward disconnects and restarts with unresolved exposure create durable fenced gap records. Opening an exposure gap and gating the bot commit atomically; uncertainty blocks new account commitments while retaining reservations and protection intent. Gap records and replay checkpoints survive restarts. Candles can still be repaired by Phase 2, but repaired OHLCV does not establish tick order. When the public provider cannot certify ordered history, the bot stays `RECONCILIATION_UNCERTAIN`; fresh prices cannot overwrite the unknown past. Pause/stop records the requested control state but does not release unresolved capacity or fabricate a cancellation. Those controls are applied after verified recovery establishes the actual simulated remainder.

With complete captured evidence, the recovery engine restores the captured baseline, freezes new historical entries, replays prices/candles/funding/timers in order through the same runtime and PAPER adapter, reconciles protection amendments, and advances a fenced checkpoint per event. Applied tape and seed/config context are pinned against changes across retries. Existing positions remain managed and new entries resume only after evidence is reconciled and normal readiness is checked.

For offline forward recovery, first stop the runtime process and supply a JSON file with `gapId`, `end`, `complete`, `evidenceHash`, ordered `events` and `seedCandles`:

```sh
npm run recovery:replay -- --file /absolute/recovery-evidence.json --owner owner@localhost.test
```

`evidenceHash` is the canonical SHA-256 digest of the event array using the exported `digest` helper. The command checks account ownership, installed strategy identity, range, no-future observations and exclusive runtime fencing; a currently owned bot is rejected. Insufficient/changed evidence preserves uncertainty. Independent unknown execution submissions or altered baseline exposure need authoritative execution reconciliation; the command cannot erase those faults. Restart the normal runtime afterward to seed current data and apply its readiness gates.

## Verification

Verified on Node 22.23.2 and native PostgreSQL 17:

- `npm run db:migrate`: applied through `0027_recovery_context_integrity` in development; integration suites apply the same migrations to the dedicated test database.
- `npm run check`: typecheck passed; **68 unit + 59 integration/process tests = 127 passing**; TypeScript and Vite builds passed.
- `npm run db:generate`: no schema changes across 34 tables. `npm audit`: zero vulnerabilities.
- Compiled worker smoke check against the test database: readiness 200, durable job COMPLETED, one closed golden trade, net `0.2413593`, clean SIGTERM exit 0. This verifies source/compiled manifest identity and the actual background-worker path.
- Formatting and staged whitespace checks pass. The runtime integration fixture now clears its public-data tables to prevent one test's later virtual clock from poisoning another test's readiness checkpoint. Acceptance tests cover deterministic golden results, no look-ahead, crash-before-checkpoint replay, partial liquidity, funding idempotency/fencing, shared-account portfolios, NO_TRADE/rejection/expiry metrics, complete/incomplete outage evidence, dual-touch OHLCV uncertainty, confirmed BE/trailing amendments, immutable holdout selection, and actual forward-feed disconnects with reserved exposure.

The numerical regression fixture is synthetic, with one illustrative trade and explicit costs; its positive result is not a strategy-performance claim. Dataset quality, omitted funding, instrument assumptions, remaining exposure and sample-size warnings must accompany comparisons. Full order-book simulation, historical specification regime changes, live exchange reconciliation, dashboards/Telegram and broader operational drills remain outside this phase.
