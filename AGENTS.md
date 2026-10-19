# Project workflow

- Use Node 22, pinned by `.nvmrc`. Run `nvm use` or prepend that Node installation to PATH before npm/Node commands.
- Follow `docs/prd.md`; Section 23 is the authoritative phase order and acceptance contract.
- Implement and verify one phase at a time. Report actual test commands/results, changed interfaces and material limitations in `docs/phase-N.md`.
- The user requests a Git commit after every completed phase. Commit only after its applicable gates pass; keep local credentials and generated artifacts excluded. Do not push unless requested.
- Use Express, TypeScript, npm workspaces, PostgreSQL and Drizzle. Do not introduce Docker requirements.
- Keep production LIVE trading disabled. Public market data requires no exchange credentials.
- Preserve decimal financial state, closed-candle/no-look-ahead rules, account boundaries and database-enforced invariants. Telegram must remain off the critical trading path.
