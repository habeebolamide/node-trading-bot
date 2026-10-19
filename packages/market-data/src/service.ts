import type { Clock } from '../../core/src/index.js';
import { marketKey, marketSchema, systemClock } from '../../core/src/index.js';
import { requiredHistory } from './indicators.js';
import {
  candleSchema,
  durations,
  missingRanges,
  type CandleRepository,
  type MarketDataProvider,
  type Market,
  type Instrument,
  type Timeframe,
  type DataRequirements,
  type FeedEvent,
  type PriceEvent,
} from './contracts.js';
export type MarketHealth = {
  marketKey: string;
  state: 'WARMING_UP' | 'READY' | 'DEGRADED';
  canEvaluate: boolean;
  reason: string;
  connected: boolean;
  lastHeartbeat: number | null;
  lastPriceEvent: number | null;
  observedAt: number;
  series: Partial<
    Record<
      Timeframe,
      { count: number; required: number; through: number; missing: number }
    >
  >;
};
type Watch = {
  candleListeners: Set<(candle: import('./contracts.js').Candle) => void>;
  interruptedAt: number | null;
  fault: string | null;
  integrityFault: string | null;
  historyVerified: boolean;
  generation: number;
  instrument: Instrument;
  requirements: Partial<Record<Timeframe, number>>;
  health: MarketHealth;
  unsubscribe?: () => void;
  pending: Promise<void>;
  seen: Set<string>;
  lastTradeTime: number;
  listeners: Set<(event: PriceEvent & { late: boolean }) => void>;
};
export class MarketDataService {
  private watches = new Map<string, Watch>();
  private seeds = new Map<string, Promise<MarketHealth>>();
  private registration = new Map<string, Promise<Watch>>();
  constructor(
    private provider: MarketDataProvider,
    private repository: CandleRepository,
    private clock: Clock = systemClock,
    private heartbeatMaxAgeMs = 65000,
  ) {}
  private async instrument(market: Market) {
    const key = marketKey(market),
      cached = await this.repository.instrument(key);
    if (cached && cached.expiresAt > this.clock.now().getTime()) return cached;
    const fresh = await this.provider.instrument(market);
    await this.repository.saveInstrument(fresh);
    return fresh;
  }
  private async watch(input: Market, requirements: DataRequirements) {
    const market = marketSchema.parse(input),
      key = marketKey(market),
      requested = requiredHistory(requirements);
    let pending = this.registration.get(key);
    if (!pending) {
      pending = (async () => {
        const instrument = await this.instrument(market),
          watch: Watch = {
            candleListeners: new Set(),
            interruptedAt: null,
            fault: null,
            integrityFault: null,
            historyVerified: false,
            generation: 0,
            instrument,
            requirements: {},
            health: {
              marketKey: key,
              state: 'WARMING_UP',
              canEvaluate: false,
              reason: 'History and live subscription required',
              connected: false,
              lastHeartbeat: null,
              lastPriceEvent: null,
              observedAt: this.clock.now().getTime(),
              series: {},
            },
            pending: Promise.resolve(),
            seen: new Set(),
            lastTradeTime: 0,
            listeners: new Set(),
          };
        this.watches.set(key, watch);
        return watch;
      })();
      this.registration.set(key, pending);
    }
    let watch: Watch;
    try {
      watch = await pending;
    } catch (e) {
      this.registration.delete(key);
      throw e;
    }
    const previous = Object.keys(watch.requirements).sort().join(',');
    for (const [frame, count] of Object.entries(requested))
      watch.requirements[frame as Timeframe] = Math.max(
        watch.requirements[frame as Timeframe] ?? 0,
        count,
      );
    const frames = Object.keys(watch.requirements).sort().join(',');
    if (!watch.unsubscribe || previous !== frames) {
      const old = watch.unsubscribe;
      watch.unsubscribe = this.provider.subscribe(
        watch.instrument,
        Object.keys(watch.requirements) as Timeframe[],
        (e) => this.receive(watch, e),
      );
      old?.();
    }
    return watch;
  }
  private receive(w: Watch, event: FeedEvent) {
    if (event.kind === 'PRICE') {
      if (w.seen.has(event.tradeId)) return;
      w.seen.add(event.tradeId);
      if (w.seen.size > 10000) w.seen.delete(w.seen.values().next().value!);
      const late = event.eventTime < w.lastTradeTime;
      w.lastTradeTime = Math.max(w.lastTradeTime, event.eventTime);
      w.health.lastPriceEvent = w.lastTradeTime;
      for (const listener of w.listeners)
        try {
          const result = listener({ ...event, late }) as unknown;
          if (result instanceof Promise)
            void result.catch(() => {
              w.integrityFault = 'Price consumer failed';
            });
        } catch {
          w.integrityFault = 'Price consumer failed';
        }
      return;
    }
    if (event.kind === 'STATUS') {
      if (event.state === 'CONNECTED') {
        if (w.interruptedAt !== null) {
          const start = w.interruptedAt;
          w.pending = w.pending
            .then(() =>
              this.repository.interruption(
                w.instrument.marketKey,
                start,
                event.observedAt,
                event.observedAt,
              ),
            )
            .catch(() => {
              w.fault = 'Interruption persistence failed';
            });
          w.interruptedAt = null;
        }
        w.health.connected = true;
        w.health.lastHeartbeat = event.observedAt;
      } else if (event.state === 'HEARTBEAT') {
        w.health.lastHeartbeat = event.observedAt;
      } else {
        w.interruptedAt ??= w.health.lastHeartbeat ?? event.observedAt;
        w.historyVerified = false;
        w.generation++;
        w.health.connected = false;
        w.health.state = 'DEGRADED';
        w.health.reason = event.reason ?? 'Feed disconnected';
      }
      this.updateHealth(w);
      w.pending = w.pending
        .then(() => this.persist(w))
        .catch(() => {
          w.health.state = 'DEGRADED';
          w.fault = 'Market health persistence failed';
          w.health.reason = w.fault;
        });
      return;
    }
    w.pending = w.pending
      .then(async () => {
        await this.repository.store([candleSchema.parse(event.candle)]);
        await this.checkSeries(w, event.candle.timeframe);
        await this.persist(w);
        for (const listener of w.candleListeners)
          try {
            const result = listener(event.candle) as unknown;
            if (result instanceof Promise)
              void result.catch(() => {
                w.integrityFault = 'Candle consumer failed';
              });
          } catch {
            w.integrityFault = 'Candle consumer failed';
          }
      })
      .catch((error: unknown) => {
        w.health.state = 'DEGRADED';
        if (
          error instanceof Error &&
          error.message.includes('CANDLE_CORRECTION')
        )
          w.integrityFault = 'Closed candle correction requires review';
        w.fault = 'Candle storage or validation failed';
        w.health.reason = w.fault;
        w.health.canEvaluate = false;
      });
  }
  private updateHealth(w: Watch) {
    const now = this.clock.now().getTime();
    w.health.observedAt = now;
    const complete = Object.entries(w.requirements).every(([frame, count]) => {
      const s = w.health.series[frame as Timeframe];
      return (
        s &&
        s.missing === 0 &&
        s.count >= count &&
        s.through ===
          Math.floor(now / durations[frame as Timeframe]) *
            durations[frame as Timeframe]
      );
    });
    w.health.canEvaluate =
      !w.fault &&
      !w.integrityFault &&
      w.historyVerified &&
      complete &&
      w.health.connected &&
      w.health.lastHeartbeat !== null &&
      now - w.health.lastHeartbeat <= this.heartbeatMaxAgeMs &&
      w.instrument.expiresAt > now;
    if (w.health.canEvaluate) {
      w.health.state = 'READY';
      w.health.reason = 'Closed history and live transport ready';
    } else {
      w.health.state = 'DEGRADED';
      w.health.reason =
        w.integrityFault ??
        w.fault ??
        (!w.historyVerified
          ? 'Recovery coverage not verified'
          : !complete
            ? 'Required candle history incomplete or stale'
            : w.instrument.expiresAt <= now
              ? 'Instrument specification expired'
              : !w.health.connected
                ? 'Live subscription not confirmed'
                : 'Live heartbeat stale');
    }
  }
  private async checkSeries(w: Watch, timeframe: Timeframe) {
    const now = this.clock.now().getTime(),
      d = durations[timeframe],
      count = w.requirements[timeframe]!;
    const end = Math.floor(now / d) * d,
      start = end - count * d;
    const bars = await this.repository.read(
        w.instrument.marketKey,
        timeframe,
        start,
        end,
        now,
      ),
      gaps = missingRanges(bars, timeframe, start, end);
    await this.repository.gaps(
      w.instrument.marketKey,
      timeframe,
      start,
      end,
      gaps,
      now,
    );
    w.health.series[timeframe] = {
      count: bars.length,
      required: count,
      through: bars.at(-1)?.closeTime ?? 0,
      missing: gaps.reduce((n, g) => n + (g.end - g.start) / d, 0),
    };
    this.updateHealth(w);
    return { start, end, gaps };
  }
  private async persist(w: Watch) {
    this.updateHealth(w);
    await this.repository.health(
      w.instrument.marketKey,
      structuredClone(w.health) as unknown as Record<string, unknown>,
      this.clock.now().getTime(),
    );
  }
  async seed(
    market: Market,
    requirements: DataRequirements,
  ): Promise<MarketHealth> {
    const watch = await this.watch(market, requirements),
      key = marketKey(marketSchema.parse(market));
    // Requests for identical series share work; larger concurrent requirements trigger a second coverage pass.
    const existing = this.seeds.get(key);
    if (existing) {
      await existing;
      return this.seed(market, requirements);
    }
    const task = (async () => {
      try {
        const generation = watch.generation;
        watch.instrument = await this.instrument(marketSchema.parse(market));
        for (const frame of Object.keys(watch.requirements) as Timeframe[]) {
          const { start, end, gaps } = await this.checkSeries(watch, frame);
          for (const gap of gaps) {
            const bars = await this.provider.candles(
              watch.instrument,
              frame,
              gap.start,
              gap.end,
              this.clock.now().getTime(),
            );
            await this.repository.store(bars);
          }
          await this.checkSeries(watch, frame);
        }
        watch.fault = null;
        watch.historyVerified =
          watch.health.connected && generation === watch.generation;
        await this.persist(watch);
        return structuredClone(watch.health);
      } catch (e) {
        if (e instanceof Error && e.message.includes('CANDLE_CORRECTION'))
          watch.integrityFault = 'Closed candle correction requires review';
        watch.fault = 'Seeding or persistence failed';
        watch.historyVerified = false;
        watch.health.state = 'DEGRADED';
        watch.health.canEvaluate = false;
        watch.health.reason = watch.fault;
        await this.repository
          .health(
            key,
            structuredClone(watch.health) as unknown as Record<string, unknown>,
            this.clock.now().getTime(),
          )
          .catch(() => {});
        throw e;
      }
    })();
    this.seeds.set(key, task);
    try {
      return await task;
    } finally {
      this.seeds.delete(key);
    }
  }
  async onPrice(
    market: Market,
    requirements: DataRequirements,
    listener: (event: PriceEvent & { late: boolean }) => void,
  ) {
    const w = await this.watch(market, requirements);
    w.listeners.add(listener);
    return () => w.listeners.delete(listener);
  }
  async onCandle(
    market: Market,
    requirements: DataRequirements,
    listener: (candle: import('./contracts.js').Candle) => void,
  ) {
    const w = await this.watch(market, requirements);
    w.candleListeners.add(listener);
    return () => w.candleListeners.delete(listener);
  }
  health(key: string) {
    const w = this.watches.get(key);
    if (!w) return undefined;
    this.updateHealth(w);
    return structuredClone(w.health);
  }
  allHealth() {
    return [...this.watches.keys()].map((key) => this.health(key)!);
  }
  async drain() {
    await Promise.all([...this.watches.values()].map((w) => w.pending));
  }
  close() {
    for (const w of this.watches.values()) w.unsubscribe?.();
    this.provider.close();
  }
}
