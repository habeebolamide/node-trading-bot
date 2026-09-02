# Change: m8-llm-review

**Status:** COMPLETED — archived 2026-09-02
**Original status:** PROPOSED (scoping)

> **COMPLETED.** M7-payoff pages, all read-only.
> - Prediction detail — setup card + Judge decision (action badge + thesis + keyRisks) +
>   attribution table + Risk verdict + autopsy panel (renders when present).
> - Autopsies browser — filters (status, outcome); highlights FAILED_LLM rows.
> - Hypotheses queue — filters by status; displays candidate + evidence + proposed weight
>   change + version links. NO promote button (rule 16 discipline).
> - Shadow evaluation — FLIP (real vs shadow) and STAND_ASIDE (shadow vs baseline) panels per
>   agent × horizon.
>
> **Verified:** typecheck + vite build green. Full suite: 623/626.
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
