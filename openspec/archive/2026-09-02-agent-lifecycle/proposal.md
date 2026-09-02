# Change: agent-lifecycle

**Status:** COMPLETED — archived 2026-09-02
**Implements:** §37 Trading Agent Lifecycle · §37 portfolio-level risk (dailyLossLimit) · §33 rule 12

Adds the §37 runtime state machine per TradingAgent:
`IDLE → WATCHING → PENDING_ENTRY → IN_TRADE → COOLDOWN → IDLE`, plus `BLOCKED` reachable
from any state (feed staleness / daily loss limit / kill switch) and recoverable back to IDLE.

- `trading_agent.lifecycle_state` + `lifecycle_until` (for COOLDOWN timer + BLOCKED-until-EOD).
  Distinct from the existing admin `status` (active/blocked/archived — user pause/archive).
- Pure `canTransitionAgent` validator + `deriveAgentState(db, agentId)` (computes IDLE/WATCHING/
  PENDING_ENTRY/IN_TRADE from live signals + positions) + `transitionAgentState` writer.
- BLOCKED and COOLDOWN are STICKY stored states (can't be derived); the others are derived when
  not sticky. A sweep clears expired COOLDOWN/BLOCKED back to the derived state.
