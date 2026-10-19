import { marketKey, type Clock } from '../../packages/core/src/index.js';
import {
  candleSchema,
  durations,
  type Candle,
  type CandleRepository,
  type Instrument,
  type Market,
  type MarketDataProvider,
  type Timeframe,
  type FeedEvent,
  type Gap,
} from '../../packages/market-data/src/contracts.js';
export const market: Market = {
  exchange: 'bybit',
  marketType: 'LINEAR_PERPETUAL',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
};
export class VirtualClock implements Clock {
  constructor(public time = Date.UTC(2026, 9, 19, 12, 17)) {}
  now() {
    return new Date(this.time);
  }
  advance(ms: number) {
    this.time += ms;
  }
}
export function fixtureInstrument(
  m: Market = market,
  now = Date.UTC(2026, 9, 19, 12, 17),
): Instrument {
  return {
    market: m,
    marketKey: marketKey(m),
    symbol: m.baseAsset + m.quoteAsset,
    specVersion: 'fixture-v1',
    verifiedAt: now,
    expiresAt: now + 3600000,
    tickSize: '0.01',
    quantityStep: '0.001',
    minQuantity: '0.001',
    minNotional: '5',
    maxLeverage: '100',
    raw: { fixture: true },
  };
}
export function fixtureCandle(
  openTime: number,
  timeframe: Timeframe = '5m',
  key = marketKey(market),
  observedAt = openTime + durations[timeframe],
): Candle {
  const p = 100 + ((openTime / durations[timeframe]) % 1000);
  return candleSchema.parse({
    marketKey: key,
    timeframe,
    openTime,
    closeTime: openTime + durations[timeframe],
    open: String(p),
    high: String(p + 2),
    low: String(p - 2),
    close: String(p + 1),
    volume: '10',
    isClosed: true,
    source: 'FIXTURE',
    observedAt,
    availableAt: observedAt,
  });
}
export class FakeMarketDataProvider implements MarketDataProvider {
  historicalTrades = {
    coverage: 'RECENT_ONLY',
    ordering: 'EXCHANGE_EVENT_TIME',
    completeRangeReplay: false,
  } as const;
  subscriptions = 0;
  instrumentCalls = 0;
  requests: { frame: Timeframe; start: number; end: number }[] = [];
  missing = new Set<number>();
  fail = false;
  listeners = new Set<(e: FeedEvent) => void>();
  constructor(public clock: VirtualClock) {}
  async instrument(m: Market) {
    this.instrumentCalls++;
    return fixtureInstrument(m, this.clock.time);
  }
  async candles(
    instrument: Instrument,
    frame: Timeframe,
    start: number,
    end: number,
    asOf: number,
  ) {
    if (this.fail) throw Error('Fixture outage');
    this.requests.push({ frame, start, end });
    const bars: Candle[] = [];
    for (let t = start; t < end; t += durations[frame])
      if (!this.missing.has(t) && t + durations[frame] <= asOf)
        bars.push(
          fixtureCandle(t, frame, instrument.marketKey, this.clock.time),
        );
    return bars;
  }
  subscribe(
    instrument: Instrument,
    _frames: Timeframe[],
    listener: (e: FeedEvent) => void,
  ) {
    this.subscriptions++;
    this.listeners.add(listener);
    queueMicrotask(() =>
      listener({
        kind: 'STATUS',
        marketKey: instrument.marketKey,
        state: 'CONNECTED',
        observedAt: this.clock.time,
      }),
    );
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(e: FeedEvent) {
    for (const listener of this.listeners) listener(e);
  }
  close() {
    this.listeners.clear();
  }
}
export class MemoryCandleRepository implements CandleRepository {
  instruments = new Map<string, Instrument>();
  candles = new Map<string, Candle>();
  missing: Gap[] = [];
  states = new Map<string, Record<string, unknown>>();
  async saveInstrument(i: Instrument) {
    this.instruments.set(i.marketKey, i);
  }
  async instrument(key: string) {
    return this.instruments.get(key);
  }
  async read(
    key: string,
    frame: Timeframe,
    start: number,
    end: number,
    asOf: number,
  ) {
    return [...this.candles.values()]
      .filter(
        (c) =>
          c.marketKey === key &&
          c.timeframe === frame &&
          c.openTime >= start &&
          c.openTime < end &&
          c.closeTime <= asOf &&
          c.availableAt <= asOf,
      )
      .sort((a, b) => a.openTime - b.openTime);
  }
  async store(bars: Candle[]) {
    for (const bar of bars) {
      const c = candleSchema.parse(bar),
        id = `${c.marketKey}:${c.timeframe}:${c.openTime}`;
      const old = this.candles.get(id);
      if (
        old &&
        ['open', 'high', 'low', 'close', 'volume'].some(
          (f) => old[f as keyof Candle] !== c[f as keyof Candle],
        )
      )
        throw Error('CANDLE_CORRECTION');
      if (!old) this.candles.set(id, c);
    }
  }
  async gaps(
    _key: string,
    _frame: Timeframe,
    _start: number,
    _end: number,
    missing: Gap[],
  ) {
    this.missing = missing;
  }
  async interruption(
    _key: string,
    _start: number,
    _end: number,
    _observedAt: number,
  ) {}
  async checkpoint(key: string) {
    return this.states.get(key);
  }
  async health(key: string, payload: Record<string, unknown>) {
    this.states.set(key, payload);
  }
}
