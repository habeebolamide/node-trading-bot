# Change: m8-api-surface

**Status:** COMPLETED — archived 2026-09-02
**Original status:** PROPOSED (scoping)

> **COMPLETED.** New `apps/api/src/dashboard.ts` mounted at `/api`. Read-only routes
> projecting M6/M7 helpers verbatim: predictions listing/detail/attribution/autopsy, metrics
> (headline/by-horizon/calibration/factor/bootstrap/shadow-vs-real/shadow-vs-baseline),
> hypotheses queue, autopsies browser, brain reads (setup/agent/agents/market/wallet), signals
> listing/detail, portfolios + positions, and an /overview KPI endpoint.
>
> **Verified:** typecheck green; **617/620 tests pass**, 10 new — live-DB integration covering
> the endpoints named in proposal.md, including param-validation 400s.
**Milestone:** M8 — Dashboard (change 1 of 6)
**Implements:** §26 dashboard data needs · CLAUDE.md "you own the UX per Task 8"

Extends `apps/api` (Express) with read-only JSON endpoints over queries M6/M7 already wrote —
`headlineMetrics`, `factorPredictiveValue`, `compareShadowVsReal`, hypothesis pipeline reads,
autopsy browser, brain reads, predictions listing. The dashboard (changes 2-6) is a shell over
this contract; nothing here writes state that isn't already writable via existing endpoints.

**Design principle:** every endpoint returns the exact shape a metrics/read helper already
returns (`HeadlineMetrics`, `HistoricalEdge`, `AgentMemory`, `ShadowGroupStats`, etc.). No new
DTOs, no format transformation — the API is a thin projection.

**Endpoints (all GET unless noted):**
- `/health` (existing)
- `/api/agents` · `/api/agents/:id` (existing `trading-agents.ts`)
- `/api/predictions?agentId&domain&from&to` · `/api/predictions/:id`
- `/api/predictions/:id/attribution` · `/api/predictions/:id/autopsy`
- `/api/metrics/headline?domain&configVersion&horizon&asOf`
- `/api/metrics/by-horizon?...` · `/api/metrics/calibration?...`
- `/api/metrics/shadow/vs-real?configVersion&horizon` · `/api/metrics/shadow/vs-baseline?...`
- `/api/factor?domain&agentKey&configVersion&horizon` (§22)
- `/api/hypotheses?status=PROPOSED|PROMOTED|...` · `/api/hypotheses/:id`
- `/api/autopsies?setupId&status` · `/api/autopsies/:predictionId`
- `/api/brain/setup?domain&features` · `/api/brain/agent?domain&agentKey&version`
- `/api/brain/market?domain` · `/api/brain/wallet/:walletId` (memecoin)
- `/api/signals?agentId&state`
- `/api/portfolios?agentId` · `/api/portfolios/:id/positions?state`
