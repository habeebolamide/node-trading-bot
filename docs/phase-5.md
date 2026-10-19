# Phase 5 — PAPER execution, risk and independent capital

Implemented on Node 22.23.2. Production LIVE trading remains disabled; the runtime uses only public market data and local PostgreSQL simulation records. There is no private-exchange client or credential path.

## Execution and accounting

New bots created in PAPER with a positive allocation receive one initial funding posting from their explicitly configured allocation against the synthetic account baseline. A 20% target on a $100 baseline initially funds $20. Changing an allocation target later changes the target only: it does not transfer money or replenish losses. Existing pre-Phase-5 bots are deliberately not backfilled with money; an owner may initialize an unfunded, stopped/idle PAPER bot with `POST /api/bots/:id/initial-funding` and `{ "reason": "..." }`. Its fixed source key makes retries return the original posting. Further transfers/rebalances require a future explicit transfer workflow.

`GET /api/account/capital` is authenticated and account scoped. It reports the PAPER environment and baseline, per-bot funding, realized balance, unrealized P&L, target percentage, reserved/committed capital and conservative available budget. Reads use a consistent PostgreSQL snapshot. Positive unrealized gains are reported but do not increase the equity used for new risk sizing. Market marks and equity peaks persist across restarts; missing/stale marks or uncertain/unprotected account exposure block new commitments.

`paper_capital_ledger` is append-only, with bot/account/trade attribution and unique source IDs. Principal, gross realized P&L and fees are separate postings. Slippage is reflected in execution prices, so it is not charged a second time. Reservations and commitments are capacity records, never P&L. Partial entry fills commit their share while retaining the unfilled reservation; cancellation releases only the unfilled share; partial exits release their share of committed capacity. Unknown outcomes retain capacity. Filled quantities, applied reports, financial postings and capacity projections commit together under the runtime fence and account coordinator.

The existing Phase 4 `FAKE_CONTRACT` reports/trades remain separate from PAPER facts. Legacy active fake trades are managed with their original adapter and frozen against further fake entries; after resolution their handle is replaced with PAPER. They never acquire funded-paper P&L.

## Model and risk policy

The versioned `paper-risk-v1` defaults are provisional research assumptions. Risk-sized quantity uses actual realized bot capital less adverse unrealized P&L, stop distance, a 0.3% round-trip cost allowance and two ticks of rounding allowance. It rounds quantity down, rechecks exchange minima and rejects undersized orders. Proposed entry/stop/target levels are normalized to exchange ticks before approval; stop rounding tightens the proposed stop. Protection amendments are also tick aligned.

Profile defaults follow the PRD: planned loss 0.5%/1%/1.5%, initial margin 10%/15%/20%, leverage ceilings 5x/10x/15x, daily loss suspension 2%/3%/5%, drawdown suspension 5%/8%/12%. The lowest integer leverage sufficient for the approved margin is chosen; leverage never enlarges stop-risk-sized notional. SPOT is unleveraged and long-only.

The account coordinator serializes sizing/reservation against the 80% aggregate target allocation ceiling, 40% margin/cost capacity, 100% gross notional and 2% combined planned stop exposure. These exposure checks include unfilled reservations. Account daily loss and drawdown defaults are 3%/10%. An equity decline that puts allocated realized capital beyond the refreshed allocation envelope blocks new commitments. Realized profits compound within their bot; they do not trigger automatic transfers or percentage-based rebasing. Loss/uncertainty guards persist `RISK_SUSPENDED` when a new proposal fails them; existing exposure remains managed. An operator can stop/start after remediation; every new proposal still rechecks all guards.

Optional `PAPER_RISK_POLICY_JSON` accepts the full versioned policy object exported by `packages/risk/src/sizing.ts`. Validation permits tighter profile/account limits and configurable fees/slippage/latency; it rejects leverage above 5x/10x/15x, limits above the v1 ceilings, and cost buffers below round-trip modeled fees/slippage. Raising provisional risk ceilings requires a reviewed policy/schema change. Each reservation stores its complete policy and instrument snapshot, so changes do not reprice existing trades.

The PAPER fill model uses subsequent fresh public trade events, not the signal candle's high/low or decision-time price. The stored execution model is `public-trade-participation-v1`. Default submission latency is at least 100 ms; maximum participation is 10% of a public trade's quantity; slippage is adverse by 0.05% plus adverse tick rounding; each fill explicitly records its 0.06% fee. Limits require executable prices within their limit and the opposite aggressor side. Zero liquidity, expired entries, late/stale/future/regressing observations and prices outside the approved entry envelope do not fill. Partial fills are quantity-step aligned and receive confirmed simulated protection. Close orders are reduce-only and fill on subsequent eligible observations; stop gaps can realize losses beyond the planned budget.

Durable price IDs prevent volume reuse. Immutable PAPER execution facts survive a crash before runtime/ledger application; restart reconciliation applies each once. Database guards enforce financial attribution, evidence-backed amounts, immutable approvals, reservation/position consistency, execution environment separation, runtime fencing and applied-fill/ledger consistency. Financial calculations use a separate 60-digit Decimal context and persisted NUMERIC(38,18) strings; TA/strategy source identities remain unchanged.

## Verification

Final verification on Node 22.23.2:

- `npm run db:migrate`: applied through `0019_paper_initial_funding_guards` on native PostgreSQL development; integration tests migrate the dedicated test database.
- `npm run check`: typecheck passed; **63 unit + 46 integration/process tests = 109 passing**; TypeScript and Vite builds passed.
- `npm run format:check` and `git diff --check`: passed. `npm run db:generate`: no schema changes. `npm audit`: zero vulnerabilities.
- Compiled runtime smoke check: Node v22.23.2, Phase 5, PAPER backend, readiness 200, SIGTERM exit 0.

Automated tests use the dedicated native PostgreSQL test database, injected clocks and public-feed fixtures; they require no trading credentials or external network.

Acceptance evidence includes:

- Bot A starts at $20, realizes exactly -$0.50 net and ends at $19.50; Bot B remains $20. The controlled gap/fee fixture deliberately exceeds the planned loss to verify actual loss attribution and subsequent suspension.
- Reserve → partial commit → cancellation/close → release never credits margin as profit; duplicate reports cannot charge fees or P&L twice.
- Competing account reservations serialize; the order that would breach gross exposure is rejected. Separate tests exercise configurable margin, notional and stop-exposure ceilings; existing foundation tests exercise concurrent 80% allocation checks.
- Risk minima, price/quantity steps, all three leverage ceilings, lowest-sufficient leverage, cost/tick allowances and independent equity compounding are verified.
- Partial/no fills, limit semantics, expiry, unknown outcomes, price-event deduplication, stale/future/late observations and authoritative cancellation are verified.
- The normal strategy → risk → PAPER intent → fill/protection → runtime restart → stop/close → net ledger path completes. A separate crash-before-ledger test recovers a durable fill once under a new fencing token.
- Account-scoped capital reads and idempotent initial funding cannot top up a losing bot or expose a foreign owner's balances.

## Material limits

This is a deterministic public-trade participation model, not an order-book/queue simulator or calibrated exchange fill guarantee. Entry prices beyond its approved envelope deliberately remain unfilled. Spread is approximated through adverse slippage; funding payments, liquidation, changing leverage tiers and actual collateral/margin modes are not modeled. Reported net P&L includes the modeled fees and execution slippage, and excludes funding. Instrument/policy snapshots are captured at approval; full historical replay, missing-event uncertainty and historical funding/specification coverage are Phase 6 work. There is no reconstruction of fills from candle touches during an outage. The dashboard/Telegram reporting is Phase 7, and broader operations/failure drills are Phase 8.
