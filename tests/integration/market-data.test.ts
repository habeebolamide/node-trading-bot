import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import { loadEnvFile } from 'node:process';
import { eq } from 'drizzle-orm';
import {
  connectDatabase,
  candles,
  instruments,
  marketGaps,
  marketCheckpoints,
} from '../../packages/database/src/index.js';
import { migrateDatabase } from '../../packages/database/src/migrate.js';
import { PostgresCandleRepository } from '../../packages/database/src/market-data.js';
import { MarketDataService } from '../../packages/market-data/src/service.js';
import { marketKey } from '../../packages/core/src/index.js';
import {
  VirtualClock,
  FakeMarketDataProvider,
  fixtureCandle,
  fixtureInstrument,
  market,
} from '../fixtures/market.js';
try {
  loadEnvFile('.env');
} catch {
  /* explicit environment */
}
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Dedicated test database required');
const { db, pool } = connectDatabase(url),
  repo = new PostgresCandleRepository(db);
beforeAll(() => migrateDatabase(url));
afterAll(() => pool.end());
beforeEach(async () => {
  await pool.query(
    'TRUNCATE candles,market_data_gaps,market_checkpoints,instrument_versions,market_instruments CASCADE',
  );
});
it('persists native histories, repairs durable gaps, deduplicates candles and restores checkpoints', async () => {
  const clock = new VirtualClock(),
    provider = new FakeMarketDataProvider(clock),
    service = new MarketDataService(provider, repo, clock);
  const missing = Math.floor(clock.time / 300000) * 300000 - 600000;
  provider.missing.add(missing);
  const requirements = {
    minClosedCandlesByTimeframe: { '5m': 500, '1h': 500 },
  } as const;
  try {
    expect((await service.seed(market, requirements)).canEvaluate).toBe(false);
    expect(
      (await db.select().from(marketGaps).where(eq(marketGaps.status, 'OPEN')))
        .length,
    ).toBe(1);
    provider.missing.clear();
    expect((await service.seed(market, requirements)).canEvaluate).toBe(true);
    expect(await db.select().from(candles)).toHaveLength(1000);
    expect(
      await db.select().from(marketGaps).where(eq(marketGaps.status, 'OPEN')),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(marketGaps)
          .where(eq(marketGaps.status, 'RESOLVED'))
      ).length,
    ).toBeGreaterThan(0);
    const restored = new PostgresCandleRepository(db),
      last = await restored.checkpoint(`${marketKey(market)}:5m`);
    expect(last!.lastOpenTime).toBe(
      Math.floor(clock.time / 300000) * 300000 - 300000,
    );
    await service.seed(market, requirements);
    expect(await db.select().from(candles)).toHaveLength(1000);
    const hourly = await restored.read(
      marketKey(market),
      '1h',
      0,
      clock.time,
      clock.time,
    );
    expect(hourly.at(-1)!.closeTime).toBe(Date.UTC(2026, 9, 19, 12));
  } finally {
    service.close();
    await service.drain();
  }
});
it('enforces database candle constraints and blocks silent corrections or checkpoint regression', async () => {
  const clock = new VirtualClock(),
    instrument = fixtureInstrument(market, clock.time);
  await repo.saveInstrument(instrument);
  const first = fixtureCandle(0, '5m', instrument.marketKey, clock.time),
    latest = fixtureCandle(300000, '5m', instrument.marketKey, clock.time);
  await repo.store([first, latest]);
  await repo.store([first]);
  expect(
    (await repo.checkpoint(`${instrument.marketKey}:5m`))!.lastOpenTime,
  ).toBe(300000);
  await expect(repo.store([{ ...first, close: '999' }])).rejects.toThrow();
  const changed = { ...first, close: first.high };
  await expect(repo.store([changed])).rejects.toThrow(/CANDLE_CORRECTION/);
  const [i] = await db.select().from(instruments);
  const { marketKey: unused, ...raw } = first;
  await expect(
    db.insert(candles).values({
      ...raw,
      instrumentId: i!.id,
      openTime: 600000,
      closeTime: 900000,
      isClosed: false,
    }),
  ).rejects.toThrow();
  expect(await db.select().from(candles)).toHaveLength(2);
  expect(
    await repo.read(instrument.marketKey, '5m', 0, 600000, clock.time - 1),
  ).toHaveLength(0);
});

it('records uncertain trade-stream interruptions without inventing recovered ticks', async () => {
  const clock = new VirtualClock(),
    provider = new FakeMarketDataProvider(clock),
    service = new MarketDataService(provider, repo, clock);
  try {
    const requirements = { minClosedCandlesByTimeframe: { '5m': 20 } } as const;
    await service.seed(market, requirements);
    provider.emit({
      kind: 'STATUS',
      marketKey: marketKey(market),
      state: 'DISCONNECTED',
      observedAt: clock.time,
    });
    clock.advance(1000);
    provider.emit({
      kind: 'STATUS',
      marketKey: marketKey(market),
      state: 'CONNECTED',
      observedAt: clock.time,
    });
    await service.drain();
    expect(
      await db
        .select()
        .from(marketGaps)
        .where(eq(marketGaps.status, 'UNCERTAIN')),
    ).toHaveLength(1);
    await service.seed(market, requirements);
    expect(
      await db
        .select()
        .from(marketGaps)
        .where(eq(marketGaps.status, 'UNCERTAIN')),
    ).toHaveLength(1);
  } finally {
    service.close();
    await service.drain();
  }
});
