/**
 * Bybit v5 public WebSocket client. Deliberately narrow: it manages the socket lifecycle
 * (connect, 20s ping, reconnect+resubscribe) and hands raw messages up via callbacks. It does
 * NOT normalize or persist — that's the adapter's job, which keeps this class fakeable (the
 * socket is injected) and single-responsibility.
 *
 * A dropped socket is never swallowed (§10 — a silently-dead feed is the exact failure the
 * staleness detector exists to catch): it triggers a logged reconnect, and the FeedMonitor
 * (fed by the adapter on every message) independently notices the gap in delivery.
 */
import { WebSocket } from 'ws';

export type WsState = 'connecting' | 'open' | 'closed';

/** Minimal surface of a `ws` WebSocket, so tests can inject a fake. */
export interface SocketLike {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;

export interface BybitWsOptions {
  url: string;
  onMessage: (msg: { topic: string; type: string; ts: number; data: unknown }) => void;
  onStateChange?: (state: WsState) => void;
  socketFactory?: SocketFactory;
  pingIntervalMs?: number;
  maxBackoffMs?: number;
  log?: (level: 'info' | 'warn', msg: string) => void;
}

const MAINNET_LINEAR = 'wss://stream.bybit.com/v5/public/linear';
const TESTNET_LINEAR = 'wss://stream-testnet.bybit.com/v5/public/linear';

export function bybitPublicUrl(testnet: boolean): string {
  return testnet ? TESTNET_LINEAR : MAINNET_LINEAR;
}

export class BybitWsClient {
  private socket: SocketLike | undefined;
  private open = false;
  private readonly topics = new Set<string>();
  private stopped = false;
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly factory: SocketFactory;
  private readonly pingIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly log: (level: 'info' | 'warn', msg: string) => void;

  constructor(private readonly opts: BybitWsOptions) {
    this.factory = opts.socketFactory ?? defaultFactory;
    this.pingIntervalMs = opts.pingIntervalMs ?? 20_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.log = opts.log ?? (() => {});
  }

  /** Register topics to subscribe. Sends now only if the socket is OPEN; otherwise the `open`
   *  handler subscribes the full set (so calling subscribe() right after start() is safe). */
  subscribe(topics: string[]): void {
    for (const t of topics) this.topics.add(t);
    if (this.open) this.send({ op: 'subscribe', args: topics });
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.open = false;
    this.clearTimers();
    this.socket?.close();
    this.socket = undefined;
    this.opts.onStateChange?.('closed');
  }

  private connect(): void {
    this.opts.onStateChange?.('connecting');
    const socket = this.factory(this.opts.url);
    this.socket = socket;

    socket.on('open', () => {
      this.open = true;
      this.attempt = 0;
      this.opts.onStateChange?.('open');
      if (this.topics.size > 0) this.send({ op: 'subscribe', args: [...this.topics] });
      this.startPing();
    });

    socket.on('message', (data: unknown) => this.handleMessage(data));
    socket.on('error', (err: unknown) => {
      this.log('warn', `bybit ws error: ${err instanceof Error ? err.message : String(err)}`);
    });
    socket.on('close', () => {
      this.open = false;
      this.clearTimers();
      this.opts.onStateChange?.('closed');
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      this.log('warn', 'bybit ws: unparseable message dropped');
      return;
    }
    const m = parsed as {
      topic?: string; type?: string; ts?: number; data?: unknown;
      op?: string; success?: boolean; ret_msg?: string;
    };
    if (m.op) {
      // Subscribe rejections used to be silently dropped ("subscribe ack / pong — not data").
      // Bybit atomically rejects the WHOLE batch on any bad topic (e.g. the v5 liquidation→
      // allLiquidation rename), so this made a broken subscription look identical to a healthy
      // one — no data ever arrived, no error was logged. Now: log failed op replies loudly.
      if (m.success === false) {
        this.log('warn', `bybit ws op "${m.op}" REJECTED: ${m.ret_msg ?? 'no message'}`);
      }
      return;
    }
    if (typeof m.topic === 'string') {
      this.opts.onMessage({ topic: m.topic, type: m.type ?? 'snapshot', ts: m.ts ?? Date.now(), data: m.data });
    }
  }

  private send(obj: unknown): void {
    try {
      this.socket?.send(JSON.stringify(obj));
    } catch (err) {
      this.log('warn', `bybit ws send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => this.send({ op: 'ping' }), this.pingIntervalMs);
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const delay = Math.min(this.maxBackoffMs, 1000 * 2 ** (this.attempt - 1));
    this.log('info', `bybit ws reconnecting in ${delay}ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private clearTimers(): void {
    this.clearPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}

function defaultFactory(url: string): SocketLike {
  // ws's WebSocket exposes the on/send/close surface SocketLike needs; the message handler
  // receives a Buffer, which handleMessage stringifies before JSON.parse.
  return new WebSocket(url) as unknown as SocketLike;
}
