# Change: m8-llm-review

**Status:** PROPOSED (scoping)
**Milestone:** M8 (change 5 of 6)

The M7-payoff pages. Read-only surfaces over the tables m7 built:

- **Predictions page** (`/predictions/:id`) — expands to show attribution (§22 breakdown),
  the Judge decision (`judge_decision` row) with FLIP/STAND_ASIDE/DEFER badge, the Judge's
  thesis / keyRisks / invalidators, links to any shadow prediction.
- **Autopsies browser** (`/autopsies`) — filter by setupId / status / outcome; row expansion
  shows the LLM's rootCause + explanation + agentFailures. `FAILED_LLM` rows highlighted with
  a "retry" indicator (retry is an operator action outside the UI in MVP).
- **Hypotheses queue** (`/hypotheses`) — PROPOSED / BACKTEST_PASSED / PROMOTED / REJECTED
  filters. Shows setupId, category, evidence count, proposed change, and (when populated)
  backtest/OOS metrics. **NO promote button** — promotion is an operator call at MVP; the UI
  displays candidates and their evidence, not decisions.
- **Shadow evaluation panel** (`/shadow`) — `compareShadowVsReal` + `compareShadowVsBaseline`
  side by side, one panel per (configVersion × horizon). §23's headline number.

Rule 20 stays absolute — no page mutates state. Every button here that looks like an action is
either a filter, a link, or a copy-to-clipboard for an operator command.
