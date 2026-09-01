import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { marketSymbol } from '@tip/domain';
import { createDb, closeDb, marketCandle, type Db } from '@tip/database';
import type { EventBus } from '@tip/events';
import { FeedMonitor } from '../staleness/monitor.js';
import { BybitAdapter } from './adapter.js';

// Integration: requires a real Postgres (verifies the onConflictDoNothing idempotence of the
// historical store, §25/§29). Skips when DATABASE_URL is unset. Assumes migration 0000 applied.
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('BybitAdapter persistence (integration, Postgres)', () => {
  let db: Db;
  const sym = `IT${randomUUID().slice(0, 6)}`; // unique so we never touch real market data

  beforeAll(() => {
    db = createDb(DATABASE_URL!);
  });
  afterAll(async () => {
    if (db) {
      await db.delete(marketCandle).where(eq(marketCandle.symbol, sym));
      await closeDb(db);
    }
  });

  it('persists a confirmed candle exactly once even if re-delivered (reconnect replay)', async () => {
    const bus = { publish: async () => ({}) } as unknown as EventBus;
    const adapter = new BybitAdapter({
      db,
      bus,
      monitor: new FeedMonitor(),
      symbols: [marketSymbol(sym)],
      timeframes: ['5m'],
    });
    const msg = {
      topic: `kline.5.${sym}`,
      type: 'snapshot',
      ts: 1,
      data: [
        {
          start: 1_700_000_000_000, end: 1_700_000_299_999, interval: '5',
          open: '100', high: '110', low: '95', close: '105', volume: '12', turnover: '1260',
          confirm: true, timestamp: 1_700_000_300_000,
        },
      ],
    };

    await adapter.ingest(msg);
    await adapter.ingest(msg); // duplicate delivery

    const rows = await db.select().from(marketCandle).where(eq(marketCandle.symbol, sym));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.close).toBe('105');
  });
});
