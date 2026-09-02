# Tasks: m8-agents-brain-perf

`[x]` done — dashboard builds; six Agent-detail tabs, Brain (Historical Edge lookup + Agent Memory + Market Memory), Performance (per-horizon metrics + inline SVG reliability diagram) live.

- [x] TanStack Query hooks per API endpoint (useAgents, usePredictions, useSignals, usePortfolios, useMetrics, useBrain)
- [x] Agents list + Agent detail with 6 tabs (Overview / Signals / Predictions / Paper Portfolio / Performance / Configuration)
- [x] Brain page — Historical Edge lookup (sliders → FeatureTuple), Agent Memory table, Market Memory table
- [x] Performance page — per-horizon metrics + SVG reliability diagram with per-bin Wilson intervals (Recharts avoided — 25-line pure SVG is enough for a calibration chart and skips another dependency)
- [x] Config tab is READ-ONLY — the JSON viewer states rule-16 discipline inline
- [x] typecheck + vite build green
