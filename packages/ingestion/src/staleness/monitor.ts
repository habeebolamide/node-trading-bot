/**
 * Feed-staleness detector (§10) — "the specific bug that killed the previous bot." A WebSocket
 * can die silently while the process keeps running; without this, downstream keeps "resolving"
 * against data that stopped moving. Each feed tracks a watermark (last-received time); a periodic
 * `check()` compares it to the feed's threshold and fires a one-shot `onStale` on crossing, and
 * a one-shot `onRecover` when delivery resumes.
 *
 * The clock is injected so the transition logic is deterministically testable without real time.
 * In M1 the transitions log; wiring a stale feed to move dependent TradingAgents to BLOCKED
 * (§37) is a later milestone (TradingAgents don't exist yet) — this exposes the state that
 * wiring will read (`isStale`, `snapshot`).
 */
export interface FeedState {
  readonly feedId: string;
  readonly thresholdMs: number;
  readonly lastSeen: number;
  readonly stale: boolean;
}

export interface FeedMonitorOptions {
  now?: () => number;
  onStale?: (feedId: string, sinceMs: number) => void;
  onRecover?: (feedId: string, downForMs: number) => void;
}

export class FeedMonitor {
  private readonly feeds = new Map<string, { thresholdMs: number; lastSeen: number; stale: boolean }>();
  private readonly now: () => number;
  private readonly onStale: (feedId: string, sinceMs: number) => void;
  private readonly onRecover: (feedId: string, downForMs: number) => void;

  constructor(opts: FeedMonitorOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.onStale = opts.onStale ?? (() => {});
    this.onRecover = opts.onRecover ?? (() => {});
  }

  /** Register a feed. lastSeen starts at registration time, so a feed that never delivers still
   *  goes stale after its threshold rather than being ignored forever. */
  register(feedId: string, thresholdMs: number): void {
    this.feeds.set(feedId, { thresholdMs, lastSeen: this.now(), stale: false });
  }

  /** Record a received message. Clears staleness (one-shot onRecover) if the feed was stale. */
  heartbeat(feedId: string): void {
    const f = this.feeds.get(feedId);
    if (!f) return; // unknown feed — ignore rather than throw (adapters register what they emit)
    const at = this.now();
    if (f.stale) {
      this.onRecover(feedId, at - f.lastSeen);
      f.stale = false;
    }
    f.lastSeen = at;
  }

  /** Evaluate every feed; fire onStale once per stale episode. Call on a small interval. */
  check(): void {
    const at = this.now();
    for (const [feedId, f] of this.feeds) {
      const age = at - f.lastSeen;
      if (!f.stale && age > f.thresholdMs) {
        f.stale = true;
        this.onStale(feedId, age);
      }
    }
  }

  isStale(feedId: string): boolean {
    return this.feeds.get(feedId)?.stale ?? false;
  }

  snapshot(): FeedState[] {
    return [...this.feeds.entries()].map(([feedId, f]) => ({
      feedId,
      thresholdMs: f.thresholdMs,
      lastSeen: f.lastSeen,
      stale: f.stale,
    }));
  }
}
