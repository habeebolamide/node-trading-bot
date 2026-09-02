import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { EVENT_NAMES } from '@tip/events';
import { attachAgentRoom, AGENT_ROOM_CHANNEL } from './agent-room.js';

/** Fake pub/sub — the injected seam. Publishes replay whatever we hand them, so no Redis. */
function fakePubSub() {
  let onMsg: ((channel: string, msg: string) => void) | null = null;
  return {
    subscribe: async (onMessage: (ch: string, msg: string) => void) => {
      onMsg = onMessage;
      return async () => { onMsg = null; };
    },
    publish: (msg: string) => { onMsg?.(AGENT_ROOM_CHANNEL, msg); },
  };
}

async function connectWs(port: number): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-room`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function waitFor<T>(getter: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = getter();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timeout');
}

describe('agent-room WS bridge', () => {
  let server: Server;
  let handle: ReturnType<typeof attachAgentRoom>;
  let pubsub: ReturnType<typeof fakePubSub>;
  let port: number;

  beforeEach(async () => {
    server = createServer((_req, res) => res.end('ok'));
    pubsub = fakePubSub();
    handle = attachAgentRoom({
      server,
      redis: {} as never, // unused when subscribeImpl is supplied
      subscribeImpl: pubsub.subscribe,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts WS connections and sends a hello frame', async () => {
    // Attach the listener before open so we don't race the server's initial hello frame.
    const messages: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-room`);
    ws.on('message', (m) => messages.push(String(m)));
    await new Promise((r) => ws.once('open', r));
    const msg = await waitFor(() => (messages[0] ? messages[0] : undefined));
    expect(JSON.parse(msg)).toMatchObject({ kind: 'hello' });
    ws.close();
  });

  it('forwards whitelisted events; drops unknown types', async () => {
    const ws = await connectWs(port);
    const seen: string[] = [];
    ws.on('message', (m) => seen.push(String(m)));
    await new Promise((r) => setTimeout(r, 20)); // wait for hello
    seen.length = 0;

    // Publish a whitelisted event and a non-whitelisted one.
    pubsub.publish(JSON.stringify({
      type: EVENT_NAMES.SIGNAL_CREATED, eventTime: '2026-01-01T00:00:00Z',
      source: 'signal-engine', payload: { signalId: 'abc' },
    }));
    pubsub.publish(JSON.stringify({
      type: 'unrelated.event', eventTime: '2026-01-01T00:00:00Z',
      source: 'x', payload: {},
    }));

    const arrived = await waitFor(() => (seen.length ? seen : undefined));
    expect(arrived).toHaveLength(1);
    expect(JSON.parse(arrived[0]!).type).toBe(EVENT_NAMES.SIGNAL_CREATED);
    ws.close();
  });

  it('fans out to every connected socket', async () => {
    const [a, b] = await Promise.all([connectWs(port), connectWs(port)]);
    const seenA: string[] = []; const seenB: string[] = [];
    a.on('message', (m) => seenA.push(String(m)));
    b.on('message', (m) => seenB.push(String(m)));
    await new Promise((r) => setTimeout(r, 20));
    seenA.length = 0; seenB.length = 0;

    pubsub.publish(JSON.stringify({
      type: EVENT_NAMES.JUDGE_EVALUATION_COMPLETED, eventTime: '2026-01-01T00:00:01Z',
      source: 'judge', payload: { signalId: 'sig' },
    }));

    await waitFor(() => (seenA.length && seenB.length ? true : undefined));
    expect(seenA[0]).toBe(seenB[0]);
    a.close(); b.close();
  });

  it('rejects upgrade on any URL other than /ws/agent-room', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/some-other-path`);
    await new Promise<void>((resolve) => { ws.on('close', () => resolve()); ws.on('error', () => resolve()); });
    expect(ws.readyState).toBeGreaterThanOrEqual(2); // CLOSING or CLOSED
  });

  it('malformed frames are dropped silently, not broadcast', async () => {
    const ws = await connectWs(port);
    const seen: string[] = [];
    ws.on('message', (m) => seen.push(String(m)));
    await new Promise((r) => setTimeout(r, 20));
    seen.length = 0;

    pubsub.publish('not-json');
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(0);
    ws.close();
  });

  it('close() removes the upgrade handler and closes all sockets', async () => {
    const ws = await connectWs(port);
    const closed = new Promise((r) => ws.once('close', r));
    await handle.close();
    await closed;
    expect(handle.connectionCount()).toBe(0);
    // Re-create handle so afterEach's close() is a no-op.
    handle = { close: async () => {}, connectionCount: () => 0, wss: { close: () => undefined } as never };
    vi.restoreAllMocks();
  });
});
