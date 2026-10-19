# Phase 4 — Durable runtime and position management

## Scope and execution boundary

Phase 4 runs against **FAKE_CONTRACT**, a strict, durable execution test adapter. It is not the PAPER fill engine. No live exchange API, production credentials, capital reservations, fees or P&L are involved. Every trade row and control response identifies this backend. The illustrative quantity of **1 unit** exercises lifecycle contracts and is explicitly not risk-sized or instrument-validated. Phase 5 must introduce central risk, ledger and actual paper execution before any paper-trading readiness claim.

The default fake adapter acknowledges entry/close requests as OPEN, confirms protection amendments, and confirms cancellations. It does **not** infer fills from a candle/price touch or automatically fill MARKET orders. Controlled tests append explicit execution facts; only those facts change filled/closed quantity. Production-facing HTTP has no fake-fill injection endpoint. SIGNAL_ONLY records strategy proposals without creating a lifecycle or execution action.

## Delivered modules and persistence

- `packages/runtime` (`@platform/bot-runtime` workspace): typed `BotRuntime`, `PositionManager`, `RuntimeRepository`, `ExecutionAdapter`, execution reports, actions, controls and separate operational/trading state.
- PostgreSQL runtime commands, ownership leases, checkpoints, lifecycle/position projections, execution actions, correlated transition events and durable fake-execution facts.
- `PostgresRuntimeRepository`: per-bot transactional serialization, fencing at state/intent/evaluation boundaries, idempotent event effects and atomic state/action/checkpoint updates. Intents commit before adapter submission; no SQL transaction spans an external adapter call. The local fake adapter independently verifies fencing before committing submission facts.
- `RuntimeSupervisor`: restores facts and unresolved exposure, seeds strategy-owned history, establishes shared price/candle listeners, applies durable control commands and runs timers. Leases renew independently of slow seeding; stale owners cannot commit decisions or submit new fake actions. API restart remains independent of runtime/worker processes.
- `MarketDataService.onCandle`: emits only persisted, validated live closed candles. Historical seed/backfill does not publish old entry events. Price callbacks remain independent of the candle-storage/repair queue.

Phase 1's STOPPED/IDLE-only restriction is replaced with checked states, operational transition checks, deferred bot/exposure consistency, and fenced runtime writes. Configuration version advances only for explicit configuration changes; record version also advances for runtime state changes. Configuration history remains immutable and reflects configuration rather than every price/state update.

PostgreSQL enforces one unresolved lifecycle per bot, one lifecycle per actionable evaluation, one entry action per lifecycle, and at most one in-flight close/protection action. A terminal lifecycle cannot retain unresolved execution actions or residual quantity. A confirmed-protection projection requires an actual confirmed stop and adequate protected quantity. Account/coin ownership, 80% allocation ceiling and existing configuration/audit constraints remain in force.

## Lifecycle and protection behavior

Operational states include STOPPED, STARTING, RECONCILING, WARMING_UP, RUNNING, PAUSED, STOP_REQUESTED, RISK_SUSPENDED and ERROR. Trading states independently track IDLE, PENDING_ENTRY, IN_TRADE, CLOSING and UNRESOLVED. Control commands are persisted before processing; their APPLIED status means the requested transition was processed, not that warmup, cancellation or position resolution is complete.

- Starting restores execution facts, warms required native histories and admits only subsequent eligible primary closes. Entry evaluations are never called while pending, open, closing or unresolved. Active trades receive price monitoring and candle-based management reassessment.
- Pause blocks entries and cancels an eligible unfilled remainder, while monitoring/protecting filled exposure. Resume reconciles and warms again. Stop blocks entries, cancels eligible pending remainder and waits for safe terminal resolution; it never silently market-liquidates an open position.
- Pending expiry and strategy invalidation request cancellation and await confirmation. A partial fill racing cancellation is consumed before the authoritative cancellation fact; only the unfilled remainder is cancelled. Filled exposure stays protected. Expiry does not automatically close the filled portion.
- TP/SL monitor explicit LAST-trade events. Late/out-of-order price events cannot retroactively trigger actions after a newer processed price. Cross-source callbacks are serialized per bot; the first valid close request retains its reason and competing callbacks cannot create another in-flight close. Source/observation references are retained for decision-changing price events.
- Break-even and ATR trailing are opt-in strategy policies. Initial ATR is taken from the entry snapshot, refreshed on candle reassessment, and used by the live price monitor. Stops only tighten. Desired, submitted and confirmed stops/revisions remain distinct; an unacknowledged amendment never becomes effective in projections. Confirmed older thresholds remain monitored while a newer amendment is uncertain.
- Candle-based position reassessment waits for a first confirmed stop rather than labeling the initial desired stop confirmed. Pending-cancel logic and elapsed holding-time exits remain separate from that assessment. Strategy-defined thesis/sideways/time exits and price thresholds share the same close arbiter.
- Partial closes retain protected residual exposure. A terminal partial close may create a subsequent residual close intent only after the prior close is terminal; simultaneous competing closes are database-rejected.
- Unknown submissions/amendments preserve unresolved state and freeze entry readiness. Reconciliation consumes authoritative fake facts using persisted IDs; it never blindly resubmits an UNKNOWN action. A crash after SUBMITTING with no authoritative receipt remains explicitly unresolved.

## Controls and inspection

Run the native processes separately:

```sh
nvm use
npm ci
npm run db:migrate
npm run strategies:register
npm run dev:api
npm run dev:runtime
```

Create a bot with a registered 0.1.0 research strategy version, then use authenticated controls. Each new request requires a UUID `Idempotency-Key` and a JSON reason; retrying the same content/key returns the existing command. Reusing a key with different content returns 409. OWNER permission is required; commands are account-scoped and audited.

```text
POST /api/bots/:id/start
POST /api/bots/:id/pause
POST /api/bots/:id/resume
POST /api/bots/:id/stop
GET  /api/bots/:id/runtime
```

Example request headers/body:

```text
Authorization: Bearer <owner-token>
Idempotency-Key: 00000000-0000-4000-8000-000000000041
Content-Type: application/json

{"reason":"Start the fake-contract research run"}
```

POST returns **202** with a durable command, `commandProcessed` and `executionBackend: FAKE_CONTRACT`. Poll the runtime GET for actual bot states, recent commands, fake lifecycles and transition evidence. Unimplemented 0.0.0 placeholders cannot start. Existing market/mode/strategy/risky configuration edits remain unavailable or blocked during unresolved activity; there is no ownership-release shortcut.

The runtime automatically subscribes/seeds started bots using their registered strategy requirements; a research watchlist remains optional. Data failures block entry evaluation and do not unsubscribe existing position monitoring. Runtime liveness reports phase 4 and fake-runtime capability. General `/health/ready` deliberately remains **503** with an explicit Phase 5 dependency; no real PAPER/LIVE order capability is advertised.

Shutdown disables new entries, removes callbacks, drains serialized transitions and expires owned leases. It does not mark open trades closed or erase protection. Startup reacquires a newer fence, restores fake facts/checkpoints, reconciles and checks data before enabling eligible entry evaluations. Failed/slow shutdown can exit after the bounded process deadline; persisted unresolved state and lease expiry govern recovery.

## Tests and evidence

`tests/integration/runtime.test.ts` covers the golden IDLE → PENDING_ENTRY → IN_TRADE → CLOSING → IDLE scenario, duplicate candle/fill effects, cancel/fill races, expiry, pause/stop exposure protection, restart restoration, stale-worker fencing, delayed stop confirmation, UNKNOWN submission isolation, durable authorized commands, projection guards, partial closes, lease exclusivity and the real supervisor against an injected public-data fake. No automated test requires external exchange availability.

`tests/unit/runtime.test.ts` checks independent state domains, pending remainder cancellation, stop acknowledgment validity, break-even/trailing tightening, stale prices, protective monitoring during an uncertain amendment and SIGNAL_ONLY isolation. Existing strategy, market-data, database, API and actual child-process restart tests remain in the suite. Process-test database setup explicitly clears previous runtime fixtures before launching the runtime.

Verification commands: `npm run db:migrate`, `npm run check`, `npm run format:check`, `npm audit`, `npm run db:generate`, plus compiled native-process health/shutdown smoke checks. **Final result:** 53 unit tests and 32 PostgreSQL/process integration tests pass (85 total). TypeScript, source formatting and production builds pass. Native PostgreSQL migrations apply and generation reports no schema drift. Dependency audit reports zero vulnerabilities. The compiled runtime smoke check confirms phase-4 liveness (200), explicitly disabled paper readiness (503), FAKE_CONTRACT backend identification and clean SIGTERM shutdown.

## Limits and next phase

These tests prove lifecycle/state contracts, not trading profitability or a production paper execution model. No risk-sized orders, reservation accounting, simulated liquidity/slippage, actual exchange fills, protective exchange orders or P&L are claimed. Mode/market/strategy replacement and safe ownership release are not implemented. Fake source facts deliberately reject new fills after an authoritative terminal cancellation; out-of-order real-exchange reconciliation is future OMS/recovery work.

Phase 4 restores durable state and known fake execution facts. Historical tick replay, stop-hit reconstruction during downtime, complete gap recovery and uncertainty resolution belong to Phase 6. Missing ticks never fabricate fills; restarting does not prove an unobserved threshold was executed. Critical incidents/dashboard notification projection and broad adversarial/load/backup drills remain later phases.

The current fake backend and its records must stay distinct from Phase 5 PAPER ledgers/execution scopes. Do not reinterpret illustrative fake fills as economically funded paper positions, or upgrade a bot with unresolved fake exposure silently. Phase 5 adds the actual paper OMS, instrument/risk checks, atomic capital reservations and independent bot accounting.
