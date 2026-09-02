# Change: m8-signals-tokens

**Status:** COMPLETED — archived 2026-09-02 — M8 COMPLETE
**Original status:** PROPOSED (scoping)

> **COMPLETED.** Last M8 change. Signals (list + detail with composite/confidence/Risk/
> NO_TRADE/Judge/contributing agents), Portfolios (list + detail with OPEN/CLOSED toggle),
> Tokens (mint lookup), Smart Money (placeholder), Settings (read-only ScoringConfig JSON per
> agent). Read-only; editing config is CLI-only (rule 16 + rule 20).
>
> **Verified:** typecheck + vite build green (324kB / 97kB gzip). Full suite: 623/626 across
> 3 clean runs.
**Milestone:** M8 (change 6 of 6) — completes M8

The remaining §26 pages, read-only:

- **Signals page** — filter by agent / state / domain; row detail shows the signal_feature
  breakdown + the Risk Agent verdict.
- **Smart Money page** (memecoin) — cluster listing from `wallet_cluster`, buy detector
  activity, convergence emissions.
- **Tokens page** (memecoin) — token profile + BrainTokenMemory score / outcomes.
- **Paper Portfolios page** — portfolio listing per agent with equity + max drawdown; drill
  into positions (open + closed) with the exit reason + realized P&L.
- **Settings page** — read-only display of active `scoring_config` per agent (JSON viewer).
  Editing config is CLI-only in MVP (rule 20 + §33 rule 16 — a config change is a versioned
  event that should be reviewed like code).
