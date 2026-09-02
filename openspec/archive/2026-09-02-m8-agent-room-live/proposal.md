# Change: m8-agent-room-live

**Status:** COMPLETED — archived 2026-09-02
**Original status:** PROPOSED (scoping)

> **COMPLETED.** WS bridge at `/ws/agent-room` fans out a whitelisted subset of bus events to
> connected dashboard clients. Lossy by design — the bus's `publish()` gains one line
> (`connection.publish('tip:events', envelope).catch(() => undefined)`) so a dashboard reader
> can never affect BullMQ delivery. Server-side ring at 500 events per socket, client-side ring
> at 200 in the hook.
>
> **Verified:** typecheck green; 6 new integration tests using an injected pub/sub seam (no
> Redis required to test the WS fan-out itself). Full suite: 623/626 (3 opt-in live).
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
