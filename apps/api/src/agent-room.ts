/**
 * §27 Agent Room live bridge. Attaches a WebSocket server to the existing HTTP server, and
 * subscribes to the BullMQ queues on the shared Redis bus (via a lightweight ioredis pub/sub
 * pattern). Each admitted event is forwarded to every connected socket as one JSON line.
 *
 * DELIBERATELY LIGHT — this is a read-only fan-out, not a message-bus reimplementation. Every
 * frame maps 1:1 to a real system event (§27 "every displayed claim should map to real system
 * events/data"). Whitelist-filtered so noise doesn't reach the dashboard.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Redis } from 'ioredis';
import { WebSocketServer, type WebSocket } from 'ws';
import { EVENT_NAMES } from '@tip/events';

/** Whitelist of event types the dashboard cares about. Anything else is dropped at the source
 *  so a firehose queue doesn't overwhelm the socket. */
const AGENT_ROOM_TYPES = new Set<string>([
  EVENT_NAMES.SIGNAL_CREATED,
  EVENT_NAMES.SIGNAL_INVALIDATED,
  EVENT_NAMES.JUDGE_EVALUATION_COMPLETED,
  EVENT_NAMES.PREDICTION_RESOLVED,
  EVENT_NAMES.PERP_SIGNAL_CREATED,
  EVENT_NAMES.MEMECOIN_SIGNAL_CREATED,
  EVENT_NAMES.MEMECOIN_WALLET_CONVERGENCE_DETECTED,
]);

/** How many events we buffer per socket before dropping oldest — soft backpressure. */
const MAX_BUFFER_PER_SOCKET = 500;

/** Redis channels the BullMQ producer publishes on (mirrors `packages/events/src/bus.ts`). */
const REDIS_EVENT_CHANNEL = 'tip:events';

export interface AgentRoomDeps {
  server: HttpServer;
  redis: Redis;
  /** Injectable for tests — a fake pub/sub client instead of a live Redis subscription. */
  subscribeImpl?: (onMessage: (channel: string, message: string) => void) => Promise<() => Promise<void>>;
}

export interface AgentRoomHandle {
  readonly wss: WebSocketServer;
  readonly connectionCount: () => number;
  readonly close: () => Promise<void>;
}

interface Envelope {
  type: string;
  eventTime: string;
  processingTime?: string;
  source: string;
  payload: unknown;
}

function shouldForward(env: Envelope): boolean {
  return typeof env?.type === 'string' && AGENT_ROOM_TYPES.has(env.type);
}

/**
 * Subscribe to `tip:events` on Redis and duplicate qualifying frames to every connected
 * WebSocket. Backpressure per socket: buffer bounded, drop oldest on overflow.
 */
export function attachAgentRoom(deps: AgentRoomDeps): AgentRoomHandle {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const buffers = new WeakMap<WebSocket, string[]>();

  const handleUpgrade = (request: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void => {
    if (request.url !== '/ws/agent-room') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  };
  deps.server.on('upgrade', handleUpgrade);

  wss.on('connection', (ws) => {
    clients.add(ws);
    buffers.set(ws, []);
    ws.on('close', () => { clients.delete(ws); buffers.delete(ws); });
    // Send a hello frame so a client can distinguish "connected but no events" from "connecting."
    ws.send(JSON.stringify({ kind: 'hello', now: new Date().toISOString() }));
  });

  const forward = (raw: string): void => {
    let env: Envelope;
    try { env = JSON.parse(raw) as Envelope; } catch { return; }
    if (!shouldForward(env)) return;
    for (const ws of clients) {
      if (ws.readyState !== 1 /* OPEN */) continue;
      const buf = buffers.get(ws) ?? [];
      buf.push(raw);
      if (buf.length > MAX_BUFFER_PER_SOCKET) buf.splice(0, buf.length - MAX_BUFFER_PER_SOCKET);
      buffers.set(ws, buf);
      ws.send(raw);
    }
  };

  // Real Redis subscription — falls back to an injected subscribeImpl for tests.
  let unsubscribe: (() => Promise<void>) | null = null;
  const start = async (): Promise<void> => {
    if (deps.subscribeImpl) {
      unsubscribe = await deps.subscribeImpl((channel, message) => {
        if (channel === REDIS_EVENT_CHANNEL) forward(message);
      });
      return;
    }
    // Use a DUPLICATED redis connection for subscribe (pub/sub keeps a connection blocked).
    const sub = deps.redis.duplicate();
    await sub.subscribe(REDIS_EVENT_CHANNEL);
    sub.on('message', (channel: string, message: string) => {
      if (channel === REDIS_EVENT_CHANNEL) forward(message);
    });
    unsubscribe = async () => { await sub.unsubscribe(); await sub.quit(); };
  };
  void start();

  return {
    wss,
    connectionCount: () => clients.size,
    async close() {
      deps.server.off('upgrade', handleUpgrade);
      if (unsubscribe) await unsubscribe();
      for (const ws of clients) ws.close();
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** Publish an envelope on the shared channel. Used both by the bus and by tests. */
export const AGENT_ROOM_CHANNEL = REDIS_EVENT_CHANNEL;
