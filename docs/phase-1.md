# Phase 1 — Foundation and database

## Delivered interfaces

TypeScript npm workspaces with Node 22.23.2, Express 5, React/Vite, PostgreSQL, Drizzle and Vitest. API, runtime and worker have independent executable entrypoints and graceful shutdown. API configuration is validated at startup. All configured execution defaults are PAPER; LIVE is rejected at HTTP, environment and database boundaries.

The API creates, fetches and versions stopped bots with authenticated portfolio access. Configuration changes include expected record version and an audit reason. A single transaction claims coin ownership and creates bot/config/audit records. Account coordination locks serialize allocation changes; an additional PostgreSQL trigger enforces the aggregate 80% ceiling even outside the repository. Coin exclusivity uses a global partial unique index. Configuration, audit and strategy-version records are append-only. Deferred constraints require matching ownership and configuration snapshots. Runtime/worker readiness honestly stays false until their services exist.

Monetary schema values use NUMERIC(38,18), allocation percentages NUMERIC(9,6), JSON values are decimal strings. No equity funding or financial ledger activity occurs yet.

## Documented Phase 1 choices

- One private owner has one synthetic USDT PAPER portfolio with an illustrative initial baseline of 100. This is a baseline/configuration record, not a funded ledger. Multiple bots share that portfolio's target allocation envelope. Actual funding, reserves, realized/unrealized accounting arrive in Phase 5.
- Ownership is global across bot modes and market types, keyed by uppercase base asset; XBT maps to BTC. Markets use structured exchange/type/base/quote fields, avoiding alternate symbol-string formats. Bybit spot and USDT-style linear perpetual identity are supported configuration shapes; actual instrument existence/constraints are validated in Phase 2. Expiring/inverse contracts and arbitrary exchange symbol parsers are deferred.
- Only PAPER and SIGNAL_ONLY are accepted. SIGNAL_ONLY has zero allocation. Bot market, strategy and mode changes, deletion, ownership release and start controls are deliberately unavailable until the relevant state/exposure checks exist.
- Registry versions are immutable DRAFT placeholders, explicitly marked unimplemented. No tested strategy or executable trading capability is claimed.
- Opaque 256-bit bearer tokens, stored only as hashes with role, expiry and revocation; bootstrap is a trusted local operator tool. OWNER/VIEWER are enforced server-side. No account self-registration or cookie-based sessions yet.
- Normal runtime roles must not own schema objects or have migration privileges in a deployed installation. Trigger protections cover ordinary SQL writes; a database administrator can intentionally bypass them. Production hardening and role deployment are Phase 8 work.
- Native PostgreSQL 17 is used. In this workspace an isolated local cluster was provisioned outside Git at `~/.local/share/trading-bot-pg17` on loopback port 55432, separate from the existing password-protected server on 5432. Local-only trust authentication is confined to that dedicated development cluster; do not expose or deploy it. `.env` is ignored.
- The legacy development-only Drizzle loader receives an esbuild override to a patched version. Migration generation and application are verified with that override.

The local development owner and registry have been seeded. Its bearer token is in ignored `.env.owner-token` with mode 0600; keep it private. To start this workspace's dedicated database again after reboot:

```sh
/Library/PostgreSQL/17/bin/pg_ctl -D "$HOME/.local/share/trading-bot-pg17" -l "$HOME/.local/share/trading-bot-pg17/server.log" -o '-h 127.0.0.1 -p 55432 -k /tmp' start
```

## Future integrity requirements

Later migrations must preserve account isolation, global coin ownership and immutable config history. Phase 4 introduces durable runtime commands/state, leases and fencing; Phase 5 introduces one-unresolved-lifecycle partial uniqueness, scoped order/fill identifiers, append-only gross-P&L/fee/funding postings and atomic reservations. Choose account → bot → trade/order lock ordering. External calls must follow committed durable intents; never hold SQL locks during network calls. PAPER/BACKTEST/LIVE economic scopes remain independent. Phase 6 adds replay checkpoints; Phase 7 adds transactional domain events and an independent PostgreSQL notification outbox. Telegram delivery must never be awaited by critical trading code.

The Phase 1 STOPPED/IDLE database restriction and ownership-release prohibition need explicit forward migrations when those workflows are implemented; do not remove them ahead of replacement invariants.

## Verification and phase gate

Commands use Node v22.23.2:

- `npm run db:generate`: generated Drizzle schema migration; custom integrity migrations supplement it.
- `npm run db:migrate`: applied to native PostgreSQL development database.
- `npm run check`: TypeScript, unit tests, real PostgreSQL tests, process restart test, server builds and React/Vite build.
- `npm run format:check`: source formatting.
- `npm audit`: dependency audit.

Automated checks cover normalized coin collisions across spot/perpetual and BTC/XBT, atomic rollback of losing claims, concurrent allocation creation/update, stale versions, immutable records, cross-account access, revoked tokens, denied LIVE/running states, and migration reruns. The process test launches API/runtime/worker, persists a bot, restarts only API and verifies both surviving services and restored configuration.

Final result: **4 unit tests and 10 integration/process tests pass**. TypeScript, formatting, server/web production builds and the compiled API readiness smoke test pass. Re-running migration generation reports no schema changes. `npm audit` reports **zero vulnerabilities**. Development seed verification shows one owner, one paper portfolio, two DRAFT registry versions and no bots.

Limitations: no market feeds, TA-Lib, strategy execution, trading runtime, ledger, OMS, backtests, notifications or dashboard controls yet. No production deployment or LIVE readiness is asserted. Those are subsequent phases, not passing placeholders.
