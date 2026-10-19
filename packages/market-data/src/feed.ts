import WebSocket from 'ws';
import { z } from 'zod';
import type { Clock } from '../../core/src/index.js';
import { systemClock } from '../../core/src/index.js';
import {
  candleSchema,
  decimalString,
  epoch,
  durations,
  intervals,
  type FeedEvent,
  type Instrument,
  type Timeframe,
} from './contracts.js';
type Listener = (event: FeedEvent) => void;
type Watch = {
  instrument: Instrument;
  frames: Timeframe[];
  listener: Listener;
};
type Connection = {
  socket: WebSocket;
  watchers: Set<Watch>;
  topics: Map<string, number>;
  pending: Map<string, string[]>;
  requestedByTopic: Map<string, string>;
  pendingSince: number;
  acknowledged: Set<string>;
  ready: Set<Watch>;
  heartbeat?: NodeJS.Timeout;
  retry?: NodeJS.Timeout;
  lastMessage: number;
  attempt: number;
  closed: boolean;
};
export type SocketFactory = (url: string) => WebSocket;
export class BybitPublicFeed {
  private connections = new Map<string, Connection>();
  private stopped = false;
  constructor(
    private clock: Clock = systemClock,
    private socketFactory: SocketFactory = (url) =>
      new WebSocket(url, {
        handshakeTimeout: 8000,
        maxPayload: 2 * 1024 * 1024,
      }),
    private baseUrl = 'wss://stream.bybit.com/v5/public',
    private heartbeatMs = 20000,
    private retryMs = 500,
  ) {}
  private emit(w: Watch, event: FeedEvent) {
    try {
      const result = w.listener(event) as unknown;
      if (result instanceof Promise) void result.catch(() => {});
    } catch {
      /* Consumers do not break the shared feed. */
    }
  }
  private status(
    c: Connection,
    state: 'CONNECTED' | 'DISCONNECTED' | 'HEARTBEAT' | 'ERROR',
    reason?: string,
  ) {
    for (const w of c.watchers)
      this.emit(w, {
        kind: 'STATUS',
        marketKey: w.instrument.marketKey,
        state,
        observedAt: this.clock.now().getTime(),
        reason,
      });
  }
  private watchTopics(w: Watch) {
    return [
      `publicTrade.${w.instrument.symbol}`,
      ...w.frames.map((f) => `kline.${intervals[f]}.${w.instrument.symbol}`),
    ];
  }
  private subscribeTopics(c: Connection, topics: string[]) {
    if (c.socket.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < topics.length; i += 10) {
      const args = topics.slice(i, i + 10),
        req_id = crypto.randomUUID();
      c.pending.set(req_id, args);
      for (const topic of args) c.requestedByTopic.set(topic, req_id);
      c.pendingSince = this.clock.now().getTime();
      c.socket.send(JSON.stringify({ op: 'subscribe', args, req_id }));
    }
  }
  private notifyReady(c: Connection) {
    for (const w of c.watchers)
      if (
        !c.ready.has(w) &&
        this.watchTopics(w).every((t) => c.acknowledged.has(t))
      ) {
        c.ready.add(w);
        this.emit(w, {
          kind: 'STATUS',
          marketKey: w.instrument.marketKey,
          state: 'CONNECTED',
          observedAt: this.clock.now().getTime(),
        });
      }
  }
  private open(category: string, c: Connection) {
    c.closed = false;
    c.pending.clear();
    c.requestedByTopic.clear();
    c.acknowledged.clear();
    c.ready.clear();
    const socket = this.socketFactory(`${this.baseUrl}/${category}`);
    c.socket = socket;
    socket.on('open', () => {
      c.lastMessage = this.clock.now().getTime();
      this.subscribeTopics(c, [...c.topics.keys()]);
      c.heartbeat = setInterval(() => {
        if (
          this.clock.now().getTime() - c.lastMessage > this.heartbeatMs * 3 ||
          (c.pending.size > 0 &&
            this.clock.now().getTime() - c.pendingSince > this.heartbeatMs * 3)
        ) {
          socket.terminate();
          return;
        }
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ op: 'ping' }));
      }, this.heartbeatMs);
    });
    socket.on('message', (raw) => {
      try {
        const msg = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(raw.toString()));
        c.lastMessage = this.clock.now().getTime();
        if (msg.op === 'unsubscribe') {
          if (msg.success !== true) {
            this.status(c, 'ERROR', 'Unsubscribe rejected');
            socket.terminate();
          }
          return;
        }
        if (msg.op === 'subscribe') {
          const topics = c.pending.get(String(msg.req_id));
          if (!topics) return;
          c.pending.delete(String(msg.req_id));
          if (msg.success !== true) {
            this.status(c, 'ERROR', 'Subscription rejected');
            socket.terminate();
            return;
          }
          for (const t of topics)
            if (
              c.topics.has(t) &&
              c.requestedByTopic.get(t) === String(msg.req_id)
            )
              c.acknowledged.add(t);
          c.attempt = 0;
          this.notifyReady(c);
          return;
        }
        if (msg.op === 'pong' || msg.op === 'ping' || msg.ret_msg === 'pong') {
          for (const w of c.ready)
            this.emit(w, {
              kind: 'STATUS',
              marketKey: w.instrument.marketKey,
              state: 'HEARTBEAT',
              observedAt: c.lastMessage,
            });
          return;
        }
        const topic = z.string().parse(msg.topic),
          data = z.array(z.unknown()).parse(msg.data),
          sourceTime = epoch.parse(msg.ts);
        for (const w of c.watchers) {
          if (!this.watchTopics(w).includes(topic)) continue;
          for (const row of data) {
            if (topic.startsWith('publicTrade.')) {
              const t = z
                .object({
                  T: epoch,
                  s: z.literal(w.instrument.symbol),
                  S: z.enum(['Buy', 'Sell']),
                  v: decimalString,
                  p: decimalString,
                  i: z.string().min(1),
                })
                .parse(row);
              if (
                Number(t.p) <= 0 ||
                Number(t.v) <= 0 ||
                t.T > c.lastMessage + 2000
              )
                throw Error('Invalid trade event');
              this.emit(w, {
                kind: 'PRICE',
                marketKey: w.instrument.marketKey,
                tradeId: t.i,
                eventTime: t.T,
                observedAt: c.lastMessage,
                price: t.p,
                quantity: t.v,
                reference: 'LAST',
                side: t.S === 'Buy' ? 'BUY' : 'SELL',
              });
            } else {
              const k = z
                .object({
                  start: epoch,
                  end: epoch,
                  interval: z.string(),
                  open: decimalString,
                  high: decimalString,
                  low: decimalString,
                  close: decimalString,
                  volume: decimalString,
                  confirm: z.boolean(),
                })
                .parse(row);
              if (!k.confirm) continue;
              const timeframe = w.frames.find(
                (f) => intervals[f] === k.interval,
              );
              if (
                !timeframe ||
                topic !== `kline.${k.interval}.${w.instrument.symbol}`
              )
                throw Error('Mismatched candle interval');
              if (
                k.end + 1 !== k.start + durations[timeframe] ||
                sourceTime < k.end + 1
              )
                throw Error('Invalid candle close');
              const candle = candleSchema.parse({
                marketKey: w.instrument.marketKey,
                timeframe,
                openTime: k.start,
                closeTime: k.end + 1,
                open: k.open,
                high: k.high,
                low: k.low,
                close: k.close,
                volume: k.volume,
                isClosed: true,
                source: 'BYBIT_WS',
                observedAt: c.lastMessage,
                availableAt: c.lastMessage,
              });
              this.emit(w, { kind: 'CANDLE', candle });
            }
          }
        }
      } catch {
        this.status(c, 'ERROR', 'Invalid public feed message');
        socket.terminate();
      }
    });
    socket.on('error', () =>
      this.status(c, 'ERROR', 'Public WebSocket connection error'),
    );
    socket.on('close', () => {
      if (c.heartbeat) clearInterval(c.heartbeat);
      c.ready.clear();
      c.acknowledged.clear();
      c.pending.clear();
      this.status(c, 'DISCONNECTED');
      if (!this.stopped && !c.closed && c.watchers.size)
        c.retry = setTimeout(
          () => this.open(category, c),
          Math.min(30000, this.retryMs * 2 ** Math.min(c.attempt++, 6)),
        );
    });
  }
  subscribe(instrument: Instrument, frames: Timeframe[], listener: Listener) {
    if (this.stopped) throw Error('Feed is closed');
    const category =
      instrument.market.marketType === 'SPOT' ? 'spot' : 'linear';
    let c = this.connections.get(category);
    if (!c) {
      c = {
        socket: undefined as unknown as WebSocket,
        watchers: new Set(),
        topics: new Map(),
        pending: new Map(),
        requestedByTopic: new Map(),
        pendingSince: 0,
        acknowledged: new Set(),
        ready: new Set(),
        lastMessage: 0,
        attempt: 0,
        closed: false,
      };
      this.connections.set(category, c);
    }
    const connection = c,
      w: Watch = { instrument, frames: [...new Set(frames)], listener };
    connection.watchers.add(w);
    const added: string[] = [];
    for (const topic of this.watchTopics(w)) {
      const count = connection.topics.get(topic) ?? 0;
      connection.topics.set(topic, count + 1);
      if (count === 0) {
        connection.acknowledged.delete(topic);
        added.push(topic);
      }
    }
    if (!connection.socket) this.open(category, connection);
    else {
      this.subscribeTopics(connection, added);
      this.notifyReady(connection);
    }
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      connection.watchers.delete(w);
      connection.ready.delete(w);
      const removedTopics: string[] = [];
      for (const topic of this.watchTopics(w)) {
        const count = (connection.topics.get(topic) ?? 1) - 1;
        if (count === 0) {
          connection.topics.delete(topic);
          connection.acknowledged.delete(topic);
          connection.requestedByTopic.delete(topic);
          removedTopics.push(topic);
        } else connection.topics.set(topic, count);
      }
      if (
        connection.socket.readyState === WebSocket.OPEN &&
        removedTopics.length
      )
        connection.socket.send(
          JSON.stringify({ op: 'unsubscribe', args: removedTopics }),
        );
      if (!connection.watchers.size) {
        connection.closed = true;
        if (connection.retry) clearTimeout(connection.retry);
        if (connection.heartbeat) clearInterval(connection.heartbeat);
        connection.socket.terminate();
        this.connections.delete(category);
      }
    };
  }
  close() {
    this.stopped = true;
    for (const c of this.connections.values()) {
      c.closed = true;
      if (c.retry) clearTimeout(c.retry);
      if (c.heartbeat) clearInterval(c.heartbeat);
      c.socket.terminate();
    }
    this.connections.clear();
  }
}
