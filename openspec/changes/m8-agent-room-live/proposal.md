# Change: m8-agent-room-live

**Status:** PROPOSED (scoping)
**Milestone:** M8 (change 4 of 6)

§27 Agent Room — a live activity feed. WebSocket surface added to `apps/api` that mirrors the
event bus (subset of §10 event types the dashboard cares about: `signal.created`,
`judge.evaluation.completed`, `signal.invalidated`, `prediction.resolved`, key wallet events).

Dashboard-side: an `AgentRoom` component that connects, renders each event as a labelled row,
groups by `tradingAgentId`. Every claim maps to a real event (§27: "every displayed claim
should map to real system events/data") — no synthesized narrative.

**Not** a message bus reimplementation — a thin WS bridge over BullMQ that filters to
whitelisted event types. Backpressure: cap in-memory buffer at 500 events per socket, drop
oldest on overflow.
