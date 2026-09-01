# CLAUDE.md — Trading Intelligence Platform

You are Claude Code, working on the Trading Intelligence Platform: a configurable, event-driven, paper-trading research system for memecoin (Solana) and perpetuals (Bybit) intelligence. The full architecture, decisions, and specifications are in `trading-intelligence-master-plan.md` alongside this file. **The plan is the source of truth. This file tells you how to work with it.**

---

## Read this first, every session

Before writing any code in a fresh session, do the following in order:

1. **Check `openspec/changes/` for anything in flight.** If a change folder exists for the task you're picking up, its `tasks.md` tells you exactly where the previous session left off. Read it before anything else — it's your continuity across sessions.
2. **Skim §33 Planning Rules for Claude** — the load-bearing discipline. Every rule there applies to every line of code you write.
3. **Skim the plan section(s) covering what you're about to implement** — and any sections they cross-reference.
4. **Read §41 Reference Function: BrainSetupMemory Update** on your first session — canonical example of the code style, math discipline, and comment density expected in this codebase.

Do not skip these. They're short. Skipping them causes the same architectural mistakes to be relitigated and duplicates work already partially done.

---

## The plan is the source of truth — and it's mostly resolved

The plan is dense (~4,850 lines) but nearly every architectural decision is already made. Sections marked `(resolved — ...)` are closed; do not reopen them. Sections marked `(Task X detail)` or `(TBD from seed analysis)` are the deliberate open items — those are yours to fill in as you build.

**When the plan and your instinct disagree, the plan wins.** If you think the plan is wrong, do not silently fix it — flag it in your PR description, propose the fix, and let the human decide. Silently working around the plan drifts the codebase away from a document the human still uses to reason about the system.

**When the plan is genuinely ambiguous or contradicts itself** (at this length, it happens), flag the ambiguity, pick the more defensible interpretation, and note the choice you made in the PR. Do not stall waiting for clarification on small ambiguities; do stall on structural ones.

**When the plan doesn't cover something**, you are the "deferred to build time" agent — most notably for the Drizzle schema (Task 2), event payload shapes (Task 3), and dashboard UX (Task 8). Derive from the plan's entity list and the surrounding context, write it, submit for review.

---

## Stack — locked, do not debate

- **Language:** TypeScript, strict mode. No JS.
- **Runtime:** Node.js (latest LTS).
- **Framework:** Express.
- **ORM / DB toolkit:** Drizzle.
- **Database:** PostgreSQL (hosted — Neon or Supabase).
- **Queue / cache:** Redis + BullMQ (hosted — Upstash).
- **Package manager:** **npm** with **npm workspaces**. Not pnpm, not yarn.
- **Change workflow:** **OpenSpec** — see the "Workflow" section below.
- **Dashboard:** React + TypeScript on Vite.
- **Dashboard styling:** Tailwind CSS + shadcn/ui.
- **Server state:** TanStack Query.
- **Live surfaces:** WebSocket, not polling.
- **Charts:** lightweight-charts for candles, Recharts for statistical views.
- **LLM (Judge, autopsy — perp only in MVP):** DeepSeek V4-Flash.
- **No Docker, no Turborepo, no microservices.** Modular monolith. Deploy directly from repo via Railway / Render / Fly.io.

If you find yourself reaching for something outside this list, stop and ask. Adding a dependency without justification is worse than a slightly clumsier implementation.

---

## Repository layout

Per plan §28:

```
trading-intelligence/
├── apps/
│   ├── api/           # Express server
│   ├── worker/        # BullMQ processors
│   └── dashboard/     # Vite + React
├── packages/
│   ├── domain/        # shared types, domain models
│   ├── database/      # Drizzle schema + client
│   ├── events/        # event contracts, envelope, bus
│   ├── ingestion/     # provider adapters (Bybit, Helius)
│   ├── agents/        # Analysis Agents (Part IV §40)
│   ├── brain/         # BrainSetupMemory, BrainWalletMemory, etc.
│   ├── signals/       # Signal Engine, scoring
│   ├── predictions/   # Prediction lifecycle
│   ├── evaluation/    # backtest replay, outcome resolution, metrics
│   ├── paper-engine/  # paper portfolios, fills, exit engine
│   └── llm/           # Judge, autopsy — perp only in MVP
├── db/
│   ├── schema.ts
│   └── migrations/
├── openspec/          # spec-driven change workflow (see "Workflow" below)
│   ├── AGENTS.md
│   ├── specs/         # source-of-truth capability specs
│   ├── changes/       # in-flight change proposals with tasks + design
│   └── archive/       # completed changes — permanent audit trail
├── docs/              # decisions, research notes, ADRs
├── scripts/           # seed analysis, backfill, ad-hoc utilities
└── package.json       # npm workspaces root
```

New packages need a strong reason to exist. Prefer growing an existing one.

---

## Workflow: OpenSpec

**Every substantive change starts as an OpenSpec change proposal in `openspec/changes/`.** The master plan is the *architectural* source of truth — the *what and why*, resolved once. OpenSpec change specs are the *execution* layer — *how, in what order, tested how* — one per feature or subsystem, iterated as you build. Change specs reference plan sections; they do not duplicate them.

### When to create a change (use OpenSpec)

- A new subsystem (Solana adapter, Bybit adapter, event bus, replay engine, paper engine).
- A new Analysis Agent (any of §40.1–§40.14).
- A schema migration touching more than one table.
- The seed-history analysis pass (Part II §4).
- Any change that would ordinarily start with "let me think about how to do this before I write it."

### When to skip (just PR the code)

- Bug fixes.
- Renames, formatting, docstring edits.
- Config value tweaks (e.g. tuning a threshold in `ScoringConfig`).
- Anything under an hour of work with a self-evident implementation.

The scope rule is: **is there a design question worth writing down before code?** If yes, OpenSpec. If no, just PR.

### The cycle

```
1. PROPOSE
   → Create openspec/changes/<change-name>/ with:
     - proposal.md   what's changing, why, which plan sections it implements
     - design.md     concrete design choices, cross-referencing plan
     - tasks.md      checklist of concrete implementation steps + tests
     - specs/        (if the change adds/modifies a source-of-truth capability spec)

2. REVIEW  (short — the architecture is already resolved in the plan)
   → Human checks: does the task list cover the plan requirements?
                    are the tests aimed at the right invariants?
                    any ambiguity you resolved on your own that needs sign-off?
   → Human approves or requests changes.

3. IMPLEMENT
   → Work the tasks.md checklist. Check items off as you complete them.
   → If you discover the design needs to change mid-implementation, update
     design.md in the same PR — do not silently drift.
   → Commits reference the change: feat(agents): momentum agent per
     openspec/changes/perp-momentum-agent/

4. ARCHIVE  (part of "done means merged" — see below)
   → Move openspec/changes/<change-name>/ → openspec/archive/<date>-<change-name>/
   → Add a one-paragraph completion summary at the top of the archived proposal.md:
     what shipped, any deviations from spec, any follow-ups needed.
   → Update openspec/specs/ if the change modified a source-of-truth capability.
```

### How OpenSpec and the master plan relate

- **Plan resolves architecture.** "TradingAgents share a Brain per domain" is in the plan and stays there. Change specs never re-decide this.
- **Change specs resolve execution.** "The Momentum Agent uses EMA(9,21,50) as spec'd in §40.1; here's the file structure, here's the fixture data, here's the test list, here's the migration order" — this lives in the change spec, not the plan.
- **Change specs reference plan sections by number.** `proposal.md` should read something like: "Implements §40.1 Perp Momentum Agent per the calculation rules and edge cases specified there. See §7 for trigger taxonomy and §33 rule 13 for the LLM-free discipline."
- **If a change reveals a plan bug or gap**, fix the plan *in the same PR* as the change that discovered it. Do not let the plan drift from the code. This is the "plan and code stay in sync" rule from the bottom of this document, applied concretely.

### Discipline decay is the failure mode to watch

The main way spec-driven workflows fail is skipping the archive step — features get built, no one archives the change folder, `openspec/changes/` fills with stale in-flight proposals, nobody trusts the folder anymore, and within a month the whole system is noise.

**Prevention:** archiving is part of "done." A change is not merged until its folder is archived. Same PR, same commit. If you find yourself wanting to "archive it later," you've already started the decay.

### Continuity across sessions

OpenSpec's biggest practical value on this project: **it makes work resumable across context-limited sessions.** If a session runs out mid-implementation, the next session starts by reading:
1. `CLAUDE.md` (this file — how to work)
2. The relevant plan sections (what to build)
3. The active `openspec/changes/<change-name>/tasks.md` (exactly where the previous session left off, which items are checked)

This is the intended pattern. Do not attempt to re-derive state from git log or partial code — read the tasks file.

---

## Development conventions

**TypeScript:**
- Strict mode on. No `any` without a comment justifying it.
- Prefer discriminated unions for state machines (Signal Lifecycle §36, Trading Agent Lifecycle §37 both are state machines and should be typed as such).
- Prefer `readonly` on domain types. Immutability by default, mutation by exception.

**Async:**
- `async/await` over promise chains.
- Never fire-and-forget without an explicit reason (Telegram alerts are the documented exception, §11).
- Every I/O call has a timeout.

**Errors:**
- Throw typed errors, never string throws. Never swallow errors.
- Distinguish: `RetryableError` (network hiccup, retry), `FatalError` (data corruption, alert human), `ValidationError` (bad input, reject).
- Logging is not error handling. If you catch, either handle or rethrow.

**Env vars:**
- All env vars checked at startup via a `config.ts` schema (Zod). No `process.env.X` scattered through the code.
- Never commit `.env`. Ship `.env.example`.

**Naming:**
- Follow the plan's terminology exactly. `TradingAgent` (user-created) vs `Agent` (Analysis Agent) is not interchangeable — the plan is explicit (§14) and confusing them corrupts every downstream discussion.
- Table names snake_case, TypeScript identifiers camelCase, types PascalCase.
- Event names lowercase-dotted: `wallet.transaction.detected`, `memecoin.wallet.buy.detected`. Match the plan §10 event list exactly.

**Commits:**
- Small, focused, explain *why* in the body when it's not obvious.
- Reference plan sections when relevant: `feat(agents): perp momentum agent per §40.1`.
- No `wip`, no `fix stuff`, no dead commits. Squash before merging if the branch got messy.

**PRs:**
- One coherent change per PR. Not "and while I was there."
- Description states what and why, links plan section(s) implemented, and calls out any ambiguity you resolved on your own.
- Passing tests + type check are the *floor*, not the bar.

---

## Architectural discipline (from §33, restated as coding norms)

These are not suggestions. Every one of them corresponds to a specific failure mode the plan is designed to prevent.

- **Rule 8 — Immutability.** `WalletTransaction`, `Prediction`, `WalletScoreEvent`, `ScoringConfig` rows are never updated in place. Corrections write a new row.
- **Rule 10 — Predictions locked.** `Prediction` rows are `INSERT`-only after creation. If a schema field seems to want `UPDATE`, you're modeling it wrong.
- **Rule 11 + 21 + 22 — No look-ahead.** For any code path in `packages/evaluation/` (backtest) or that reads historical data: only data with `timestamp <= T` may influence a prediction at T. Wallet scores read via `WalletScoreEvent` "as of T," never live. The backtest data-access layer must not expose a "current score" method that could be called by mistake — enforce this structurally, not by convention.
- **Rule 12 — DB constraints for correctness.** Idempotency via unique constraints (`processedEvent.eventId`, `walletTransaction.txHash`, active-token-claim unique per token). Never rely on application-side check-then-write for correctness (§29 has the specific token-claim example).
- **Rule 13 — LLM does not calculate.** If it's arithmetic (scoring, Wilson CI, sizing), it's deterministic code. The LLM only synthesizes over structured evidence.
- **Rule 14 — LLM does not invent market data.** Every fact the LLM references in its output must be traceable to structured input the system supplied.
- **Rule 16 — Versioned scoring configs.** `ScoringConfig` is append-only. Every `Prediction` FKs the exact row active when it was created. Weight changes write new rows, never mutate.
- **Rule 17 — Provider adapters.** Bybit-specific and Helius-specific data shapes never leak past `packages/ingestion/`. Everything downstream sees normalized domain events (§12).
- **Rule 19 — Async via queues.** Cross-package coordination goes through BullMQ, not direct function calls. `event → queue → processor → event`.
- **Rule 20 — Paper trading only in MVP.** No real-money execution code paths. Not stubs, not commented-out, not "for later" — do not write them.
- **Rule 23 — Effective-n on everything.** Every sample-size gate uses recency-weighted effective-n. Raw counts appear nowhere.
- **Rule 24 — Fingerprint uses full shared feature set.** `setupId` is computed from the domain's full feature set (Part II §8 for memecoin, Part III §6 for perp), never a TradingAgent's enabled-agent subset.
- **Rule 25 — Paper engine never fabricates fills.** Memecoin: no last-price fallback, no assumed TP on ambiguous candles. Resolve pessimistically and record how resolved (§21/§25).

---

## Testing philosophy

The plan doesn't say much about testing, so here it is: test what would be catastrophic if wrong, integration-test the seams, and don't waste effort test-mocking the world.

**Mandatory unit tests** (correctness matters more than coverage %):
- `wilsonInterval()` and `updateSetupMemory()` (§41) — every edge case: `n=0`, `n<threshold`, `n=threshold`, all-wins, all-losses, decay across half-life boundary, recency-weighted equivalence with all-recent-uniform-weight case.
- Wallet score "as of T" lookup — must never return today's score for a historical T.
- Signal Scoring composite — weights sum, normalization, boundary values.
- Trade Planner sizing/leverage — derived-not-chosen ordering (Part III §4), R:R gate, `NO TRADE` on infeasible sizing.
- Profit-ladder rung firing — rungs fire in order, each once, gap-up hits only crossed rungs, cumulative `sellFraction` ≤ 1.0 validated at config-write.
- `walletExitThreshold` accumulator math — partial-sell contribution correctness.
- Setup Memory fingerprint hashing — deterministic, order-independent within each dimension, 243 cells for memecoin / 6,500 for perp.
- Concurrency/idempotency — the atomic token-claim (§29) needs a real concurrent-insert test, not a mocked one.

**Integration tests worth writing:**
- End-to-end: raw Bybit fixture → ingestion → normalization → event → agent → signal → prediction → paper fill → outcome → BrainSetupMemory update. If this passes, the seams work.
- Backtest reproducibility: same historical fixture in twice, byte-identical Setup Memory rows out.
- Feed-staleness → BLOCKED state transition.

**Do not** waste effort:
- Mocking HTTP calls elaborately when a small in-process fake provider serves the purpose.
- Testing framework code (Express routing, Drizzle CRUD).
- Snapshot tests for LLM outputs. They will drift, and drift is the point of the LLM.

---

## Current milestone: M1 — Data Foundation

M0 (planning) is complete. **You are starting at M1.** Build order per §30:

```
M1 → Data Foundation
   Solana provider adapter (Helius, free tier)
   Market provider adapter (Bybit WS + REST)
   Ingestion + normalization
   Postgres + Drizzle schema
   Redis + BullMQ
   Event bus
   Core historical replay engine  ← required at M1, not later (§25 correction)
   Historical kline/funding/OI backfill to local Postgres
```

Everything upstream of the data layer is out of scope in M1. Do not stub Agents; do not sketch the dashboard; do not write scoring code. If you find yourself doing so, you've drifted.

**Before shipping M1:** the Bybit backfill pipeline must have loaded at least 6 months of 1m/5m/15m/1h/4h/1d klines + funding + OI for BTC, ETH, SOL. This is the prerequisite for pre-launch Brain Seeding (§25 pre-launch gate) at M6.

M2 → Wallet Intelligence is next, and its first task is the 100-wallet seed backfill + the seed-history analysis pass (Part II §4). That analysis is what settles four placeholder defaults — see the "Placeholders" section below.

---

## How to work — a decision flowchart

**Step 0 — does this need a change proposal?** Use the scope rule in the Workflow section above. Subsystem, new agent, migration, analysis pass → yes, create the proposal first. Bug fix, small tweak, formatting → no, just PR.

**When the task is clear and the plan covers it:** implement, test, PR (with archive if this was an OpenSpec change). No need to ask.

**When you find an ambiguity in the plan:** pick the more defensible interpretation, note it in the change's `design.md` (or PR description if there's no change folder), proceed. Do not stall on small ambiguities.

**When you find a genuine contradiction in the plan:** stop. Flag it. Propose a resolution in the change's `design.md`. Wait for a decision. Silent guessing on structural issues creates bugs the plan is specifically designed to prevent.

**When you want to change an architectural decision the plan resolves:** don't. If you have a strong reason, write it up as an addendum PR against `trading-intelligence-master-plan.md` itself, separate from any code change. The human decides.

**When you want to add a dependency:** justify it in the change's `design.md`. If the justification is "it's convenient," reconsider.

**When a test is hard to write:** the code is probably wrong-shaped, not the test. Refactor for testability before writing a heroic test setup.

**When you're stuck for more than an hour:** ask. Not "any hints?" but "here's what I understand, here's where I'm stuck, here's what I've tried." Time-boxing prevents thrashing.

---

## Common tasks → plan sections to read

| You're building… | Read these first |
|---|---|
| Provider adapter (Bybit or Helius) | §12 normalization, §17 provider rule, Part III §5 (Bybit) or Part II §7 (Helius), §10 event architecture, §10 feed staleness thresholds |
| An Analysis Agent | §7 agent taxonomy, §40.X for the specific agent, §33 rules 13/14/17/23, and if it touches wallet scores, §4 point-in-time rule |
| Signal Engine / scoring | §9 (generic), Part II §9 (memecoin composite) or Part III §3 (perp composite), Task 6 (Brain math), §40 for each contributing agent |
| Trade Planner | §35 (generic), Part II §10 (memecoin) or Part III §4 (perp), rule 25 |
| Paper Engine | §20, §21, rule 25, Part II §10 (memecoin exit precedence), §41 (BrainSetupMemory update) |
| Brain memory (any) | §15, §16, Part II §8 (memecoin) or Part III §6 (perp), §41 (reference implementation) |
| Predictions | §19, rule 10, `configVersion` FK is mandatory |
| Backtest / replay | §25, rules 11/21/22, Task 7 evaluation methodology, §41 |
| Learning loop (perp only in MVP) | §22 attribution, §23 cost tracking, §24 autopsy + hypothesis pipeline |
| Judge / LLM (perp only) | §18, §40.14, §23, rules 13/14 |
| Dashboard | §26, §27, §40 (what data agents produce), you own the UX per Task 8 |

---

## Do not

- **Do not build real-money execution code paths.** Not stubs. Not `TODO: enable later`. Rule 20 is absolute for MVP.
- **Do not add memecoin autopsy.** Deferred until memecoin gets a backtest (§24). Same for perp Judge in memecoin flows — near-zero surface, waste of LLM cost.
- **Do not use `SELECT ... IF NOT EXISTS ... INSERT` patterns without a DB-level unique constraint.** §29 is explicit; the token-claim example is what happens when this is violated.
- **Do not blend versions.** `AgentPerformance` and `BrainAgentMemory` are keyed `(agentKey, agentVersion)`. `Prediction` FKs `ScoringConfig.version`. Silently blending track records across versions destroys the "did this change actually help" question.
- **Do not use "current wallet score" during backtest or hypothesis evaluation.** The backtest data-access layer must not expose that method. Rule 21.
- **Do not let LLM output flow into the deterministic path unchecked.** The Judge can only affect direction via the narrow §18 gate; autopsy findings can only affect config via the backtest-guarded hypothesis pipeline (§24). Never a direct edit.
- **Do not swallow errors from ingestion.** A silently-dropped WebSocket message is the exact failure mode §10 staleness detection exists to catch — but only if the message is genuinely absent, not caught-and-ignored.
- **Do not add microservices.** §33 rule 18. Modular monolith stays.
- **Do not spend planning time on M8 dashboard while building M1–M4.** You'll drift.

---

## Placeholder configuration values — flagged as such in the plan

These have MVP defaults but are known-imperfect; the seed-history analysis pass in M2 (Part II §4) is what settles them. Do not hardcode; do put them in `ScoringConfig` (or infra config for the last one) so tuning is a one-line change:

| Value | Placeholder | Settled by |
|---|---|---|
| `batchingWindowMs` | 5000 | Distribution of `last_buy − first_buy` across historical seed-wallet convergences |
| `walletExitThreshold` | 0.9 | Frequency of partial-cluster-sell → full-dump in seed history |
| `profitLadder` rungs | 2×/50%, 3×/25%, 5×/15% | Fraction of historical clusters reaching each multiple |
| Design-1-vs-2/3 exit | Design 1 | Whether seed wallets dump all-at-once vs trim in stages |
| Freshness `τ` | 15s | Rate at which seed-wallet convergence edge decays post-buy |
| Feed staleness thresholds | Per §10 table | Only if production reveals false-alarms or missed failures |

When you use one of these, add a code comment linking to Part II §4 so future-you (or future-Claude-Code) knows why the value was chosen.

---

## When a task is done

- Types pass strict, tests pass.
- New code is unit-tested per the "Mandatory unit tests" list where applicable.
- PR description names the plan section(s) implemented, links the OpenSpec change folder (if any), notes any ambiguity you resolved, and lists any deviations from the plan (should normally be zero).
- If this was an OpenSpec change: **the folder is archived in the same PR** — moved from `openspec/changes/` to `openspec/archive/<date>-<name>/`, with a completion summary appended to `proposal.md`. Archiving "later" is how the workflow decays; do it now.
- If you added a new event, it appears in the §10 event list — either it was already there, or your PR adds an addendum to the plan naming it.
- If you added a new config field, it appears in the `ScoringConfig` schema block (§8) — same rule.
- If you touched the schema, migrations are checked in and reversible.

The plan and the code stay in sync. When they drift, the plan gets updated in the same PR, not "later." Same rule for OpenSpec: change spec, archive, code, plan updates — all one merge.
