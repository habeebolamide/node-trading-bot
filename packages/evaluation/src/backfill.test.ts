import { describe, it, expect, vi } from 'vitest';
import { marketSymbol } from '@tip/domain';
import type { BybitRestClient } from '@tip/ingestion';
import type { Db } from '@tip/database';
import { backfillKlines } from './backfill.js';

const SYM = marketSymbol('BTCUSDT');
const BASE = 1_700_000_000_000;

/** Build a page of `n` sequential 1m klines starting at `startMs`. */
function page(n: number, startMs: number) {
  return Array.from({ length: n }, (_, i) => {
    const openTime = new Date(startMs + i * 60_000);
    return {
      symbol: SYM, timeframe: '1m' as const, openTime, closeTime: new Date(openTime.getTime() + 60_000),
      open: '1', high: '2', low: '0.5', close: '1.5', volume: '10', turnover: '15',
      confirm: true, eventTime: openTime.toISOString(), processingTime: openTime.toISOString(),
    };
  });
}

function fakeDb() {
  const inserted: unknown[] = [];
  const db = {
    insert: () => ({
      values: (arr: unknown[]) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            inserted.push(...arr);
            return arr.map(() => ({})); // pretend all inserted
          },
        }),
      }),
    }),
  } as unknown as Db;
  return { db, inserted };
}

describe('backfillKlines pagination', () => {
  it('walks forward, stops on a short final page, upserts every row, no infinite loop', async () => {
    const starts: (number | undefined)[] = [];
    const getKlines = vi
      .fn()
      .mockImplementationOnce(async (_s, _tf, q) => { starts.push(q.start); return page(1000, BASE); })
      .mockImplementationOnce(async (_s, _tf, q) => { starts.push(q.start); return page(1000, BASE + 1000 * 60_000); })
      .mockImplementationOnce(async (_s, _tf, q) => { starts.push(q.start); return page(500, BASE + 2000 * 60_000); }); // short → stop
    const rest = { getKlines } as unknown as BybitRestClient;
    const { db, inserted } = fakeDb();

    const result = await backfillKlines(rest, db, SYM, '1m', BASE, BASE + 3000 * 60_000);

    expect(getKlines).toHaveBeenCalledTimes(3); // stopped on the short page, didn't loop forever
    expect(result.fetched).toBe(2500);
    expect(result.inserted).toBe(2500);
    expect(inserted).toHaveLength(2500);
    // forward progress: each call's start strictly increased
    expect(starts[0]).toBe(BASE);
    expect(starts[1]!).toBeGreaterThan(starts[0]!);
    expect(starts[2]!).toBeGreaterThan(starts[1]!);
  });

  it('handles an empty first page (nothing in range)', async () => {
    const rest = { getKlines: vi.fn().mockResolvedValue([]) } as unknown as BybitRestClient;
    const { db } = fakeDb();
    const result = await backfillKlines(rest, db, SYM, '1h', BASE, BASE + 60_000);
    expect(result).toEqual({ fetched: 0, inserted: 0 });
  });
});
