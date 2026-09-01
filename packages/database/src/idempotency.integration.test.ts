import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from './client.js';
import { withIdempotency } from './idempotency.js';
import { marketCandle, processedEvent } from './schema.js';

// Integration: requires a real Postgres (constraint + transaction behavior can't
// be faked, §29). Skips when DATABASE_URL is unset. Provisions the two tables it
// touches idempotently, so it runs against any empty database; a fully migrated
// DB just no-ops the CREATEs.
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('idempotency + constraints (integration, Postgres)', () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await db.execute(sql`
      create table if not exists processed_event (
        event_id text primary key,
        processed_at timestamptz not null default now()
      )`);
    await db.execute(sql`
      create table if not exists market_candle (
        symbol text not null, timeframe text not null,
        open_time timestamptz not null, close_time timestamptz not null,
        open numeric not null, high numeric not null, low numeric not null,
        close numeric not null, volume numeric not null, turnover numeric,
        primary key (symbol, timeframe, open_time)
      )`);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  it('processes a shared event id EXACTLY once under real concurrency (§29)', async () => {
    const eventId = `it-${randomUUID()}`;
    let handlerRuns = 0;

    // 10 workers race to claim the same id at the same instant.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withIdempotency(db, eventId, async () => {
          handlerRuns += 1;
        }),
      ),
    );

    expect(handlerRuns).toBe(1);
    expect(results.filter((r) => r.processed)).toHaveLength(1);
    expect(results.filter((r) => !r.processed)).toHaveLength(9);

    await db.delete(processedEvent).where(sql`event_id = ${eventId}`);
  });

  it('rejects a duplicate candle via the composite unique constraint', async () => {
    const symbol = `ITTEST-${randomUUID().slice(0, 8)}`;
    const openTime = new Date('2026-01-01T00:00:00Z');
    const row = {
      symbol, timeframe: '1m', openTime, closeTime: new Date('2026-01-01T00:01:00Z'),
      open: '100', high: '101', low: '99', close: '100.5', volume: '12.3', turnover: null,
    };

    await db.insert(marketCandle).values(row);
    await expect(db.insert(marketCandle).values(row)).rejects.toThrow();

    await db.delete(marketCandle).where(sql`symbol = ${symbol}`);
  });
});
