# Phase 7 — Dashboard & independent Telegram delivery

## Interfaces and behavior

The React/Vite operator workspace implements portfolio and bot views, creation, stopped/idle name and allocation configuration, explicit one-time initial funding, start/pause/resume/stop requests, command processing status, durable order intents, position/protection quantities, capital target versus actual equity, strategy evidence, NO_TRADE and risk-rejection analytics, forward-paper performance, replay reports and manifests, recovery/health, persistent audits, incidents and Telegram preferences. All P&L is explicitly simulated; LIVE remains disabled. Viewer controls are disabled in the UI and rejected by the API. Tokens stay in tab memory, never URLs or local storage. The authenticated SSE stream invalidates projections every ten seconds, reconnects/re-authenticates at least once per minute, and has a sixty-second polling fallback. It carries no exchange connection or credentials.

The API serves the built `apps/web/dist` dashboard at its root. Development Vite proxies `/api` and `/health` to loopback API port 3000. `npm run dev:web` opens port 5173. Build and run from the repository root. Token issuance remains `npm run bootstrap`; use the previously saved token where available rather than publishing it in project files.

New authorized account-scoped endpoints:

- `GET /api/session`, `/api/events`, `/api/account/report`, `/api/audit-events`.
- `GET /api/incidents`, `/api/incidents/:id`; owner-only `POST /api/incidents/:id/acknowledge` and `/resolve` with `{reason}`.
- `GET/PATCH /api/notifications/preferences`: `{botId: UUID|null, enabled, recipientRef: numeric Telegram chat ID|null, events: [ENTRY|EXIT|PROTECTION|RECOVERY|SIGNAL]}`.
- `GET /api/notifications/delivery-status`: recent sanitized deliveries and worker heartbeat freshness.
- Existing bot runtime projection additionally returns durable order actions and runtime checkpoint/fault evidence. Market-data health is restricted to the account's configured bot markets.

## Independent notification boundary

`npm run dev:notifier` (or `npm run start:notifier` after build) starts a **separate process**, separate small database pool and loopback health server on port 3003. It is independent of the runtime, API and historical replay worker. No trading module imports notification code. It polls already committed runtime domain events and health/reconciliation projections; no strategy, capital, fill, stop or command transaction awaits it. Projection handles bounded batches of 100 domain events and ten accounts in persisted least-recently-observed order. It never projects REPLAY accounts into forward alerts.

PostgreSQL stores account/bot preferences, canonical incidents and immutable incident timelines, projected event identities, delivery outbox snapshots, attempts and worker heartbeats. Outbox and projection dedupe commit together. Shared feed faults are grouped by account/exchange, including all currently affected bots; repeated observations update the same incident without new alerts. Recovered evidence moves incidents to RECOVERING; an operator resolution rechecks underlying health and reconciliation under the projector lock. Acknowledgment neither clears faults nor changes bot runtime state. Routine NO_TRADE and price/timer observations do not generate individual Telegram deliveries. Optional entry/exit notifications identify their event and never imply a requested order is a confirmed fill.

Enable delivery by supplying `TELEGRAM_BOT_TOKEN` only to the notifier environment, enabling account incident routing, and saving a numeric recipient chat ID through the dashboard/API. Bot overrides affect optional alerts only. Telegram has no inbound command/approval/risk-override path. No bot token, raw Telegram response, URL or arbitrary error text is stored in delivery errors. Pending notifications preserve their original recipient/payload snapshot when preferences change.

Delivery claims use `FOR UPDATE SKIP LOCKED`, a 20-second lease and a random completion token. Each claim durably records STARTED before the network call. One send at a time per notifier has a hard five-second Promise-race deadline as well as an AbortController; even a transport ignoring cancellation cannot keep this delivery loop awaiting indefinitely. There are at most five attempts, bounded exponential delay and jitter, and 429 retry_after support (waits up to 24 hours; larger requests are dead-lettered rather than retried early). Permanent rejection is dead-lettered immediately. Crashed sends are reclaimable after lease expiry; final-attempt uncertainty is conservatively dead-lettered. A successful send whose response is lost can be duplicated: **exactly-once Telegram delivery is not claimed**.

## Verification

- `npm run check` under Node 22.23.2: type checking passed, 70 unit tests and 66 real-PostgreSQL integration/process tests passed (136 total), and API/runtime/replay-worker/notifier plus Vite production builds passed.
- Targeted PostgreSQL checks cover a shared three-bot outage and one grouped initial alert; feed-induced unresolved PAPER exposure keeps capital committed without extra per-bot outage alerts; 100 stored NO_TRADE decisions create zero individual Telegram deliveries; operator acknowledgment never resumes a bot; resolution rejects active faults; account isolation and OWNER/VIEWER enforcement; concurrent delivery claims, 429 timing, bounded retries and crash recovery.
- The PAPER integration suite executes risk approval, fills, confirmed stop protection, stop tightening and stop-loss closure while a Telegram sender remains indefinitely pending. Trading completes before its independent timeout.
- Real API/runtime/replay-worker/notifier child processes are launched by the process suite. Killing/restarting the notifier preserves a queued notification, and an API restart leaves other services alive.
- Browser QA used disposable integration data at actual 1440px and 390px iframe viewports: sign-in, portfolio/allocation, unresolved protection, bot creation, disabled unsafe start/resume choices, pending pause controls, immediate evidence refresh, effective inherited preferences and an honestly unconfigured Telegram worker. Temporary QA HTML and processes were removed; no development portfolio fixtures were created. The final design reviewer scored both listed usability fixes resolved (`ship` at that scope).
- Compiled-process smoke: built API served dashboard HTML and its JavaScript asset; built notifier became ready with Telegram explicitly unconfigured; both exited cleanly on SIGTERM (exit 0).
- `npm run format:check`, `git diff --check`, and `npm audit --omit=dev` pass (zero production vulnerabilities). `npm run db:generate` reports 41 tables and no schema drift. Migration 0028 applied to development and isolated test PostgreSQL; no Docker or exchange credentials used.

Telegram transport handling was checked against the [official Bot API envelope, sendMessage and retry_after contract](https://core.telegram.org/bots/api). Automated transport tests use mocked responses; no external Telegram message was sent.

## Material limits

No real Telegram message is sent during verification: a bot token and destination must be supplied by the operator to activate external delivery. Missing Telegram configuration does not disable incident persistence or the dashboard. There is no daily digest scheduler, escalation pager, delivery replay button or Telegram trading control. These are optional/future workflows, not implied by a running UI.

The dashboard uses all-time evaluation aggregates, up to 200 recent forward-paper lifecycles, 500 realized-curve timestamps, 50 recent replay jobs/deliveries, and bounded activity/audit lists. The curve is explicitly realized equity and excludes unrealized marks. Full immutable evaluation histories, ledger records and replay inputs remain in PostgreSQL. Aggregate SQL is suitable for the local paper MVP; retention, large-history rollups, production resources and deployment/auth hardening belong to Phase 8. The notification projector observes current health periodically; durable transitions remain available for restart, but a transient feed outage fully recovered between projector polls may only appear in the runtime timeline. Public recent trades still cannot certify missing TP/SL ordering; acknowledgment cannot erase RECONCILIATION_UNCERTAIN.
