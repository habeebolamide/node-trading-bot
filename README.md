# Strategy trading platform

Paper-first, rule-based trading platform. Phase 1 implements configuration and persistence; **trading is not active**. The implementation specification is [docs/prd.md](docs/prd.md), with the authoritative phase sequence in Section 23.

## Requirements and setup

- Node **22.23.2** (pinned in `.nvmrc`), npm 10+, and native or managed PostgreSQL 17+.
- No Docker, exchange credentials, Redis, or Telegram credentials required.

```sh
nvm use
npm ci
cp .env.example .env
```

Edit `.env` with your PostgreSQL URLs. Use separate databases for development and testing. `TEST_DATABASE_URL` must end in `_test`; integration tests **truncate that database's domain tables**. Never point it at shared, development, or production data.

Provision databases using an authorized PostgreSQL administrator, for example:

```sh
createdb trading_bot_dev
createdb trading_bot_test
```

Set the URLs to the appropriate host/port/user, then:

```sh
npm run db:migrate
npm run bootstrap
```

Bootstrap creates one private owner and a synthetic **$100 USDT paper portfolio**, and registers two **DRAFT, unimplemented** strategy versions. It prints an owner bearer token once; save it privately. Only its SHA-256 hash is stored. Tokens expire after 30 days. Set `OWNER_EMAIL` to override the local default. Re-running bootstrap issues another token without resetting existing bots or equity. Revoke tokens by setting `api_tokens.revoked_at` through an authorized database operator; an operator UI is a later phase.

## Run

Run these independently in separate terminals after `nvm use`:

```sh
npm run dev:api
npm run dev:runtime
npm run dev:worker
npm run dev:web
```

API: `http://127.0.0.1:3000`; runtime health: `3001`; worker health: `3002`; Vite: `5173`. API restart does not restart the other processes. Runtime/worker are executable scaffolds: liveness returns 200, readiness returns **503** with an explicit explanation. They do not subscribe to markets or execute jobs/trades. API readiness checks its database schema and advertises configuration capability only.

```sh
npm run check
npm run format:check
npm audit
```

`check` runs type checking, unit tests, real PostgreSQL integration tests, actual child-process restart tests, and production builds. A missing test database is a failure, not a skipped gate. Use `npm run db:generate` for schema changes; custom SQL migrations contain locking and integrity triggers. Never edit an already applied migration.

Built entrypoints are runnable independently with `npm run start:api`, `npm run start:runtime`, and `npm run start:worker`. They load `.env` from the working directory. Deploy with a restricted database role, TLS/reverse proxy, secret management and supervisor in the later hardening phase; the local scaffold is not a hardened public deployment.

## API

All `/api` routes require `Authorization: Bearer <token>`. OWNER can read/write its portfolio; VIEWER can read it. Health routes are public. Authentication uses headers rather than cookies; there is no cookie session or browser token storage yet. Responses carry server-generated correlation IDs. JSON financial values and percentages are strings.

| Route                               | Behavior                                                       |
| ----------------------------------- | -------------------------------------------------------------- |
| `GET /health/live`                  | API process liveness                                           |
| `GET /health/ready`                 | API schema/database readiness                                  |
| `GET /api/account`                  | Authorized synthetic portfolio                                 |
| `GET /api/strategies`               | Registry versions and DRAFT status                             |
| `GET /api/bots`                     | Own bots                                                       |
| `POST /api/bots`                    | Create STOPPED/IDLE PAPER or SIGNAL_ONLY bot                   |
| `GET /api/bots/:id`                 | Fetch own bot                                                  |
| `PATCH /api/bots/:id`               | Update name/target allocation with expected version and reason |
| `GET /api/bots/:id/config-versions` | Immutable configuration history                                |

Create body (replace `strategyVersionId` using the registry response):

```json
{
  "name": "BTC trend research",
  "market": {
    "exchange": "bybit",
    "marketType": "LINEAR_PERPETUAL",
    "baseAsset": "BTC",
    "quoteAsset": "USDT"
  },
  "strategyVersionId": "<registry-version-uuid>",
  "executionMode": "PAPER",
  "riskProfile": "CONSERVATIVE",
  "allocationTargetPercent": "20"
}
```

Update body:

```json
{
  "allocationTargetPercent": "25",
  "expectedVersion": 1,
  "reason": "Adjust research allocation target"
}
```

A stale version, existing coin owner or allocation conflict returns 409. Invalid input returns 400; unauthorized 401; forbidden 403; absent or foreign bot 404. LIVE and start/stop endpoints are unavailable in this phase. SIGNAL_ONLY requires zero allocation.

## Layout

- `apps/api`: Express API and header-token authorization.
- `apps/runtime`, `apps/worker`: independent lifecycle/health scaffolds.
- `apps/web`: React/Vite scaffold; dashboard arrives in Phase 7.
- `packages/core`: validation, canonical market identities, shared states, clock/event contracts, logging.
- `packages/database`: Drizzle schema, SQL migrations and transactional bot repository.
- `tests`: deterministic validation, real PostgreSQL domain tests, process-isolation tests.
- `docs/phase-1.md`: decisions, verification and deferred work.
