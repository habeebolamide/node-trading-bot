# Trading Intelligence Platform

A configurable, event-driven, **paper-trading** research system for two domains:

- **Memecoin** (Solana, via Helius)
- **Perpetuals** (Bybit)

It observes market/on-chain activity, ranks participants and patterns, lets specialized
deterministic agents analyze opportunities, combines evidence through a persistent **Brain**,
creates timestamped **predictions**, evaluates outcomes, and measurably improves the
intelligence layer from historical evidence. The LLM (DeepSeek, perp-only in MVP) synthesizes
and judges — it never computes scores and never invents market data.

> **No real-money execution.** Research / paper-trading only (Rule 20).

## Source of truth

- [`trading-intelligence-master-plan.md`](trading-intelligence-master-plan.md) — the
  architecture and every resolved decision. **The plan wins over instinct.**
- [`CLAUDE.md`](CLAUDE.md) — how to work in this repo (stack, conventions, the OpenSpec
  workflow, the §33 discipline rules).
- [`openspec/`](openspec/) — the spec-driven change workflow. Every subsystem starts as a
  change proposal here before code.

## Stack (locked — see CLAUDE.md)

TypeScript (strict) · Node LTS · Express · Drizzle · PostgreSQL · Redis + BullMQ ·
React + Vite + Tailwind + shadcn/ui (dashboard) · npm workspaces · **no Docker, no Turborepo,
no microservices** — modular monolith.

## Layout

```
apps/        api · worker · dashboard
packages/    domain · events · database · ingestion · wallets · watchlist ·
             evaluation · agents · brain · planner · predictions · paper-engine ·
             trading-agents · seeding · llm
scripts/     backfill-bybit · seed-brain · seed-wallets · score-wallets · …
openspec/    change proposals + archive
docs/        architecture · research · decisions
```

Packages are created as the milestone that needs them lands — not all stubbed up front.

## Current status

**All milestones (M1–M8) shipped as the MVP.** Data foundation, wallet intelligence, smart-money
radar, agent swarm, Brain, predictions/evaluation, LLM/Judge, and dashboard. See
[`openspec/archive/`](openspec/archive/) for every archived change proposal (what shipped, why,
and any deviations from spec).

Follow the quickstart below to run it locally.

---

## Quickstart — from `git clone` to a live dashboard

Everything below assumes a Mac or Linux dev machine. Windows works via WSL.

### 0 · Prerequisites

| Requirement | Why | Recommended |
|---|---|---|
| **Node ≥ 20 (22 LTS ideal)** | Native `fetch`, ESM, tsx | `nvm install 22 && nvm use 22` |
| **PostgreSQL 16** | Every table lives here | Homebrew: `brew install postgresql@16 && brew services start postgresql@16` |
| **Redis 7+** | BullMQ queues + WS pub/sub | `brew install redis && brew services start redis` (or `redis-server --daemonize yes`) |
| **npm 10+** | Workspaces | ships with Node 22 |

Sanity-check:

```bash
node --version    # v22.x
psql --version    # 16.x
redis-cli ping    # PONG
```

> **No Docker anywhere.** Everything runs directly on your machine. This is deliberate —
> see CLAUDE.md.

### 1 · Clone and install

```bash
git clone <this repo>
cd trading-bot
npm install                    # installs every workspace in one pass
npm run typecheck              # sanity: all workspaces compile
```

### 2 · Create the database and fill `.env`

```bash
# Create a local Postgres role + db (skip if you already have one)
createuser -s postgres 2>/dev/null || true
createdb -O postgres trading_db

# Bootstrap your env file
cp .env.example .env
```

Open `.env` and fill in the required keys. **Minimum for local dev:**

```bash
NODE_ENV=development
LOG_LEVEL=info
API_PORT=8000
DASHBOARD_API_URL=http://localhost:8000   # Vite proxies /api and /trading-agents here

# Local Postgres — no ?schema=public suffix; postgres.js rejects it
DATABASE_URL=postgresql://postgres@localhost:5432/trading_db
DIRECT_URL=postgresql://postgres@localhost:5432/trading_db

# Local Redis
REDIS_URL=redis://localhost:6379
```

**Optional (enables extra features):**

| Key | Enables |
|---|---|
| `HELIUS_API_KEY` + `HELIUS_WEBHOOK_SECRET` + `HELIUS_WEBHOOK_URL` | Memecoin wallet ingestion + `/wallets` endpoints |
| `DEEPSEEK_API_KEY` | Judge + Trade Autopsy (M7 LLM features) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Alerts (optional) |

### 3 · Apply migrations

Creates 39 tables, both immutability triggers, and the drizzle journal.

```bash
npm run db:migrate --workspace @tip/database
```

Verify with `psql`:

```bash
psql "$(grep ^DATABASE_URL .env | cut -d= -f2-)" -c "\dt public.*" | head
```

**To WIPE the DB and re-migrate cleanly** (drops all test data):

```bash
node -e "
import('postgres').then(async ({default: postgres}) => {
  const sql = postgres(process.env.DATABASE_URL);
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;');
  await sql.end();
  console.log('DB wiped');
});
"
npm run db:migrate --workspace @tip/database
```

### 4 · (Optional) backfill historical perp data

For **perp Brain seeding** (§25 pre-launch gate) you need ≥ 6 months of 1m/5m/15m/1h/4h/1d klines
+ funding + OI for the symbols you'll trade. Skip if you only want to explore the UI.

```bash
npm run backfill --workspace @tip/scripts --   --months=6   --symbols=BTCUSDT,ETHUSDT,SOLUSDT
```

Idempotent — re-running writes zero new rows once complete. Cheap on local Postgres.

### 5 · Start the API and the worker

**Two terminals.**

Terminal A — the api (Express + WebSocket):

```bash
npm run dev --workspace @tip/api
# → [api] listening on :8000
# → [api] agent-room WS mounted at /ws/agent-room
```

Terminal B — the worker (Bybit ingestion + agent pipeline):

```bash
npm run dev --workspace @tip/worker
# → starts live Bybit ingestion (BTC/ETH/SOL × 6 timeframes) if configured
```

Sanity:

```bash
curl http://localhost:8000/health
# {"status":"ok","db":"ok","redis":"ok","uptimeSeconds":…}

curl http://localhost:8000/api/overview
# {"openSignals":0,"signalsLast24h":0,"predictionsLast7d":0,"portfolios":0,"totalEquity":0}
```

### 6 · Start the dashboard

**Third terminal:**

```bash
npm run dev --workspace @tip/dashboard
# → Local:   http://localhost:5173/
```

Open **http://localhost:5173** — Overview page loads with KPI cards, the Agent Room shows
live events (empty until the worker produces some), and the sidebar exposes every page.

**Create your first trading agent** from **Agents → + Create Agent** — the form prefills the
plan-default ScoringConfig for perp or memecoin and POSTs to `/trading-agents`. Editing
config later is CLI-only (rule 16 — versioned like code):

```bash
curl -X PATCH http://localhost:8000/trading-agents/<id> \
  -H "content-type: application/json" \
  -d '{"config": { … }}'
```

### 7 · (Optional) pre-launch Brain seeding — perp only

§30 requires the system not go live with an empty perp Brain. Needs step 4 completed first.

```bash
# List existing agents to get an id
curl http://localhost:8000/trading-agents

# Dry run — reports what would happen, no writes
npm run seed-brain --workspace @tip/scripts -- \
  --agent <tradingAgentId> \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT \
  --from 2026-01-01 --to 2026-07-01 \
  --dry-run

# Live seed
npm run seed-brain --workspace @tip/scripts -- \
  --agent <tradingAgentId> \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT \
  --from 2026-01-01 --to 2026-07-01
```

The report ends with a fingerprints-at-trust count and (if applicable) a **look-ahead warning
when the seeded win rate exceeds 72%** — §25 flags that pattern as a bug, not edge. Read the
report; only launch when the trust fraction looks reasonable.

---

## Common tasks

**Run the full test suite:**

```bash
npm test                       # ~620 tests, requires DATABASE_URL + REDIS_URL
```

**Typecheck everything (root + dashboard):**

```bash
npm run typecheck              # root project refs
npm run dashboard:check        # apps/dashboard (Vite handles JSX/bundle)
```

**Build the dashboard for production:**

```bash
npm run dashboard:build        # → apps/dashboard/dist (static SPA)
```

**Stop everything cleanly:**

```bash
lsof -ti :5173 :8000 | xargs kill
```

**Reset DB completely (destroys data):** see the WIPE snippet in step 3.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `dashboard → /api/overview` returns HTML | Vite proxy target wrong | Set `DASHBOARD_API_URL=http://localhost:8000` in `.env` and restart Vite |
| `EADDRINUSE :8000` on `npm run dev --workspace @tip/api` | Another api is already listening | `lsof -ti :8000 \| xargs kill` |
| `redis-cli ping` fails | Redis not running | `brew services start redis` or `redis-server --daemonize yes` |
| Migrations fail on `ADD COLUMN` | You rewound the drizzle journal | Migrations use `IF NOT EXISTS` where possible; a full re-migrate on a wiped DB always works |
| `POST /trading-agents` returns 400 | Config JSON invalid per `validateScoringConfig` | The response body lists the specific field + reason |
| Dashboard shows empty Overview forever | Api not running, or worker never emitted signals | Confirm both terminals are up (`curl :8000/health`) |
| Judge / Autopsies pages empty | LLM disabled (no `DEEPSEEK_API_KEY`) or no predictions have resolved yet | Both are expected pre-M6-outcomes |

---

## Where the docs live

- **Architecture + resolved decisions:** [`trading-intelligence-master-plan.md`](trading-intelligence-master-plan.md)
- **How to work in this repo:** [`CLAUDE.md`](CLAUDE.md)
- **Change history (what shipped, why, deviations):** [`openspec/archive/`](openspec/archive/)
- **Per-package README:** each `packages/*/src/index.ts` opens with a docstring explaining the
  package's role. Same for `apps/*`.
