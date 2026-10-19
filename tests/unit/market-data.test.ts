import { describe, it, expect } from 'vitest';
import { marketKey } from '../../packages/core/src/index.js';
import {
  candleSchema,
  durations,
  missingRanges,
} from '../../packages/market-data/src/contracts.js';
import {
  calculateIndicator,
  requiredHistory,
} from '../../packages/market-data/src/indicators.js';
import { MarketDataService } from '../../packages/market-data/src/service.js';
import {
  VirtualClock,
  FakeMarketDataProvider,
  MemoryCandleRepository,
  fixtureCandle,
  market,
} from '../fixtures/market.js';
const req = { minClosedCandlesByTimeframe: { '5m': 500, '1h': 500 } } as const;
describe('closed candles and native TA-Lib', () => {
  it('rejects incomplete, misaligned, impossible OHLC and unavailable candles', () => {
    const c = fixtureCandle(0);
    for (const patch of [
      { isClosed: false },
      { openTime: 1 },
      { high: '1' },
      { low: '0' },
      { closeTime: 300001 },
      { availableAt: c.closeTime - 1 },
    ])
      expect(candleSchema.safeParse({ ...c, ...patch }).success).toBe(false);
  });
  it('calculates native SMA golden output and rejects future/higher-timeframe contamination', () => {
    const bars = Array.from({ length: 5 }, (_, i) => ({
      ...fixtureCandle(i * 300000),
      open: String(i + 1),
      high: String(i + 2),
      low: String(i + 1),
      close: String(i + 1),
    }));
    const request = {
      name: 'SMA',
      timeframe: '5m',
      parameters: { period: 3 },
    } as const;
    expect(calculateIndicator(bars, request, 1500000).outputs.outReal).toEqual([
      2, 3, 4,
    ]);
    expect(() => calculateIndicator(bars, request, 1200000)).toThrow(/future/);
    expect(() =>
      calculateIndicator(
        bars.map((c, i) => (i === 0 ? { ...c, timeframe: '1h' } : c)),
        request,
        1500000,
      ),
    ).toThrow();
    expect(() =>
      calculateIndicator(bars.slice(0, 2), request, 1500000),
    ).toThrow(/INSUFFICIENT/);
  });
  it('uses explicit warmup requirements and rejects undersized stability overrides', () => {
    expect(
      requiredHistory({
        minClosedCandlesByTimeframe: { '5m': 100 },
        indicators: [
          { name: 'EMA', timeframe: '5m', parameters: { period: 50 } },
        ],
      }),
    ).toEqual({ '5m': 300 });
    expect(() =>
      requiredHistory({ minClosedCandlesByTimeframe: { '5m': 0 } }),
    ).toThrow();
    expect(() =>
      requiredHistory({
        minClosedCandlesByTimeframe: {},
        indicators: [
          {
            name: 'RSI',
            timeframe: '1h',
            parameters: { period: 14 },
            warmupCandles: 2,
          },
        ],
      }),
    ).toThrow();
  });
  it('detects only missing native intervals', () => {
    expect(
      missingRanges(
        [fixtureCandle(0), fixtureCandle(900000)],
        '5m',
        0,
        1200000,
      ),
    ).toEqual([{ start: 300000, end: 900000 }]);
  });
});
describe('seeding, subscription sharing and health gates', () => {
  it('cold-starts independent 5m/1h histories and shares identical concurrent requests', async () => {
    const clock = new VirtualClock(),
      provider = new FakeMarketDataProvider(clock),
      repo = new MemoryCandleRepository(),
      service = new MarketDataService(provider, repo, clock);
    try {
      const [a, b] = await Promise.all([
        service.seed(market, req),
        service.seed(market, req),
      ]);
      expect(a.canEvaluate).toBe(true);
      expect(b.canEvaluate).toBe(true);
      expect(repo.candles.size).toBe(1000);
      expect(provider.requests).toHaveLength(2);
      expect(provider.subscriptions).toBe(1);
      const hourly = await repo.read(
        marketKey(market),
        '1h',
        0,
        clock.time,
        clock.time,
      );
      expect(hourly.at(-1)!.closeTime).toBe(Date.UTC(2026, 9, 19, 12));
      expect(
        [...repo.candles.values()].every((c) => c.closeTime <= clock.time),
      ).toBe(true);
    } finally {
      service.close();
    }
  });
  it('blocks entries for a history gap while prices keep reaching protection consumers, then repairs only missing ranges', async () => {
    const clock = new VirtualClock(),
      provider = new FakeMarketDataProvider(clock),
      repo = new MemoryCandleRepository(),
      service = new MarketDataService(provider, repo, clock);
    const missing = Math.floor(clock.time / 300000) * 300000 - 600000;
    provider.missing.add(missing);
    const received: string[] = [];
    await service.onPrice(market, req, (e) => received.push(e.tradeId));
    const health = await service.seed(market, req);
    expect(health.canEvaluate).toBe(false);
    expect(health.series['5m']!.missing).toBe(1);
    provider.emit({
      kind: 'PRICE',
      marketKey: marketKey(market),
      tradeId: '1',
      eventTime: clock.time,
      observedAt: clock.time,
      price: '100',
      quantity: '1',
      side: 'BUY',
      reference: 'LAST',
    });
    expect(received).toEqual(['1']);
    provider.missing.clear();
    const previous = provider.requests.length;
    expect((await service.seed(market, req)).canEvaluate).toBe(true);
    expect(provider.requests.slice(previous)).toEqual([
      { frame: '5m', start: missing, end: missing + 300000 },
    ]);
    service.close();
  });
  it('deduplicates prices, tags late events, isolates consumers and expires stale health', async () => {
    const clock = new VirtualClock(),
      provider = new FakeMarketDataProvider(clock),
      repo = new MemoryCandleRepository(),
      service = new MarketDataService(provider, repo, clock);
    const prices: boolean[] = [];
    await service.onPrice(market, req, () => {
      throw Error('bad consumer');
    });
    await service.onPrice(market, req, (e) => prices.push(e.late));
    await service.seed(market, req);
    const event = {
      kind: 'PRICE',
      marketKey: marketKey(market),
      tradeId: 'a',
      eventTime: clock.time,
      observedAt: clock.time,
      price: '100',
      quantity: '1',
      side: 'BUY',
      reference: 'LAST',
    } as const;
    provider.emit(event);
    provider.emit(event);
    provider.emit({ ...event, tradeId: 'b', eventTime: clock.time - 1 });
    expect(prices).toEqual([false, true]);
    clock.advance(66000);
    expect(service.health(marketKey(market))!.canEvaluate).toBe(false);
    service.close();
  });
  it('requires verified recovery after reconnect and refuses silently optimistic provider errors', async () => {
    const clock = new VirtualClock(),
      provider = new FakeMarketDataProvider(clock),
      repo = new MemoryCandleRepository(),
      service = new MarketDataService(provider, repo, clock);
    await service.seed(market, req);
    provider.emit({
      kind: 'STATUS',
      marketKey: marketKey(market),
      state: 'DISCONNECTED',
      observedAt: clock.time,
    });
    provider.emit({
      kind: 'STATUS',
      marketKey: marketKey(market),
      state: 'CONNECTED',
      observedAt: clock.time,
    });
    expect(service.health(marketKey(market))!.canEvaluate).toBe(false);
    expect((await service.seed(market, req)).canEvaluate).toBe(true);
    clock.advance(durations['1h']);
    provider.fail = true;
    await expect(service.seed(market, req)).rejects.toThrow('Fixture outage');
    expect(service.health(marketKey(market))!.canEvaluate).toBe(false);
    service.close();
  });
});

it.each(['EMA', 'RSI', 'ATR', 'ADX', 'MACD', 'BBANDS'] as const)(
  'executes native %s with stable, complete inputs',
  (name) => {
    const clock = new VirtualClock(),
      end = Math.floor(clock.time / 300000) * 300000;
    const bars = Array.from({ length: 500 }, (_, i) =>
      fixtureCandle(
        end - (500 - i) * 300000,
        '5m',
        marketKey(market),
        clock.time,
      ),
    );
    const output = calculateIndicator(
      bars,
      { name, timeframe: '5m', parameters: {} },
      clock.time,
    );
    expect(Object.values(output.latest).every(Number.isFinite)).toBe(true);
    expect(output.inputsThrough).toBe(end);
  },
);
it('retains correction faults across an otherwise successful seed', async () => {
  const clock = new VirtualClock(),
    provider = new FakeMarketDataProvider(clock),
    repo = new MemoryCandleRepository(),
    service = new MarketDataService(provider, repo, clock);
  try {
    await service.seed(market, req);
    const c = [...repo.candles.values()].find((c) => c.timeframe === '5m')!;
    provider.emit({ kind: 'CANDLE', candle: { ...c, close: c.high } });
    await service.drain();
    expect(service.health(marketKey(market))!.canEvaluate).toBe(false);
    await service.seed(market, req);
    expect(service.health(marketKey(market))!.canEvaluate).toBe(false);
    expect(service.health(marketKey(market))!.reason).toMatch(/correction/);
  } finally {
    service.close();
  }
});
