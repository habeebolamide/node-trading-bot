# Tasks: m8-agent-room-live

`[x]` done — WS bridge live; 6 integration tests via injected pub/sub seam. Dashboard AgentRoom on Overview.

- [x] `apps/api/src/agent-room.ts` — attachAgentRoom(server, redis) via ws WebSocketServer at /ws/agent-room
- [x] `packages/events/src/bus.ts` — lossy `redis.publish("tip:events", envelope)` after every queue.add (best-effort, errors swallowed so dashboard readers cannot affect BullMQ delivery)
- [x] AGENT_ROOM_TYPES whitelist so noise stays off the socket
- [x] Per-socket ring buffer capped at 500
- [x] Dashboard useAgentRoom hook — auto-reconnect with backoff, client-side ring at 200
- [x] AgentRoom component on Overview
- [x] Vite proxy for /ws paths
- [x] 6 integration tests (hello frame, whitelist filter, fan-out, unknown URL rejected, malformed dropped, close teardown)
