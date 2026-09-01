import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { marketSymbol } from '@tip/domain';
import { createDb, closeDb, marketCandle, type Db } from '@tip/database';
import { HistoricalMarketReader } from './reader.js';
import { ReplayEngine } from './replay.js';

// Integration: real Postgres. Verifies chronological ordering + structural no-look-ahead (§25,
// rule 21). Skips without DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('replay engine (integration, Postgres)', () => {
  let db: Db;
  const sym = marketSymbol(`IT${randomUUID().slice(0, 6)}`);
  const t0 = new Date('2026-02-01T00:00:00Z');
  const t1 = new Date('2026-02-01T00:01:00Z');
  const t2 = new Date('2026-02-01T00:02:00Z');

  const candle = (openTime: Date, close: string) => ({
    symbol: sym, timeframe: '1m', openTime, closeTime: new Date(openTime.getTime() + 60_000),
    open: '1', high: '2', low: '0.5', close, volume: '1', turnover: null,
  });

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    // insert OUT OF ORDER on purpose — the reader must still yield chronologically
    await db.insert(marketCandle).values([candle(t2, '2'), candle(t0, '0'), candle(t1, '1')]).onConflictDoNothing();
  });
  afterAll(async () => {
    if (db) {
      await db.delete(marketCandle).where(eq(marketCandle.symbol, sym));
      await closeDb(db);
    }
  });

  it('streamCandles yields ascending by open time regardless of insert order', async () => {
    const reader = new HistoricalMarketReader(db);
    const seen: string[] = [];
    for await (const c of reader.streamCandles(sym, '1m')) seen.push(c.close);
    expect(seen).toEqual(['0', '1', '2']);
  });

  it('ReplayEngine anchors asOf at each bar close and never leaks future data (rule 21)', async () => {
    const engine = new ReplayEngine(db);
    const steps = [];
    for await (const step of engine.replay({ symbol: sym, primaryTf: '1m' })) steps.push(step);

    expect(steps).toHaveLength(3);
    // asOf === the bar's close time
    expect(steps[0]!.asOf.getTime()).toBe(t0.getTime() + 60_000);

    // At the FIRST bar's view, only the first candle is observable — t1/t2 are the future.
    const asOfFirst = await steps[0]!.data.candlesAsOf(sym, '1m');
    expect(asOfFirst.map((c) => c.close)).toEqual(['0']);

    // By the last bar, all three are in-scope.
    const asOfLast = await steps[2]!.data.candlesAsOf(sym, '1m');
    expect(asOfLast.map((c) => c.close)).toEqual(['0', '1', '2']);
  });
});
