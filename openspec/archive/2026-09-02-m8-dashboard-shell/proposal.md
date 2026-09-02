# Change: m8-dashboard-shell

**Status:** COMPLETED — archived 2026-09-02
**Original status:** PROPOSED (scoping)

> **COMPLETED.** New `apps/dashboard` — Vite + React 18 + TypeScript + Tailwind + TanStack
> Query + React Router. Hand-rolled shadcn-style primitives (Card, Badge, Table, Skeleton,
> Tabs) rather than a full shadcn install — keeps the app self-contained. Sidebar per §26,
> Overview KPIs over /api/overview, placeholder pages for every nav item so later changes fill
> in one file at a time without breaking nav.
>
> **Verified:** root typecheck green; `apps/dashboard/tsc --noEmit` green; `vite build` produces
> 273kB (87kB gzip). Full suite: 617/620 (3 opt-in live).
>
> **Deliberate deviation:** `apps/dashboard` is NOT in the root tsconfig project refs. Vite
> handles the JSX/bundle side and a dedicated `npm run dashboard:check` script runs `tsc --noEmit`
> for CI. Adding it to `tsc --build` would require composite mode + a separate JSX config
> ceremony for zero gain.
**Milestone:** M8 (change 2 of 6)

New `apps/dashboard` — Vite + React + TypeScript + Tailwind CSS + shadcn/ui + TanStack Query
+ React Router. Provides:
- Root layout with a left sidebar per §26's nav (Overview / Agents / Signals / Predictions /
  Portfolios / Brain / Performance / LLM Review / Backtesting / Settings).
- TanStack Query client wired to the M8 API base URL from Vite env.
- shadcn/ui primitives (Button / Card / Table / Tabs / Badge / Skeleton / Toast) installed
  under `src/components/ui`.
- An Overview page with 4 KPI cards (open agents · signals last 24h · predictions last 7d ·
  paper equity) — a landing dashboard, not a real analytical page.
- Dark/light theme support via Tailwind's class strategy — the trading UI reads under both.
- `npm run dev` boots the app; `npm run build` produces a static bundle.

**No business logic in the dashboard.** Everything shown is a projection of an API endpoint.
Views build on TanStack Query hooks (`useAgents()`, `usePredictions()`) so the same read is
cached across pages.
