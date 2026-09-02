# Change: m8-agents-brain-perf

**Status:** PROPOSED (scoping)
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
