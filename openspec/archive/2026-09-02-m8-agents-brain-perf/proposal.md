# Change: m8-agents-brain-perf

**Status:** COMPLETED — archived 2026-09-02
**Original status:** PROPOSED (scoping)

> **COMPLETED.** Agents list + Agent detail (Overview / Signals / Predictions / Portfolio /
> Performance / Config tabs), Brain page (Historical Edge lookup, Agent Memory, Market
> Memory), Performance page (per-horizon metrics + inline SVG reliability diagram).
>
> **Deliberate deviation from proposal.md:** proposal said Recharts for the reliability chart;
> shipped as a hand-rolled 25-line SVG chart instead. Two reasons — one less dep (bundle stays
> at 92kB gzip vs the ~50kB Recharts would add), and the reliability diagram is a simple
> scatter with Wilson error bars a pure SVG renders perfectly. Recharts stays available for
> anything more complex a later page needs.
>
> **Verified:** typecheck (root + dashboard) green; `vite build` clean at 296kB / 92kB gzip.
> Full suite: 617/620 (3 opt-in live).
**Milestone:** M8 (change 3 of 6) — the biggest UX chunk

Agents / Agent detail / Brain / Performance pages per §26 + Task 8.

- **Agents page** — list of trading agents with domain badge, style, active config version,
  headline accuracy at 4h horizon.
- **Agent detail** (`/agents/:id`) — Tabs: Overview · Signals · Predictions · Paper Portfolio ·
  Performance · Configuration. Each tab is a table/summary over API endpoints from change 1.
- **Brain page** (`/brain?domain=perp|memecoin`) — Historical Edge lookup box (dimension
  sliders that build a FeatureTuple → `/api/brain/setup`), Agent Memory table (per agent version
  with Wilson intervals + standalone accuracy), Market Memory table (per regime bucket).
- **Performance page** — §32 metric block per (agent × configVersion × horizon), plus a
  Recharts reliability diagram over `/api/metrics/calibration`.

Read-only; no writes. Recharts for statistical views (Task 8 stack lock).
