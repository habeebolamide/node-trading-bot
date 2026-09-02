import { describe, it, expect, vi } from 'vitest';
import { marketSymbol } from '@tip/domain';
import type { BybitRestClient } from '@tip/ingestion';
import type { Db } from '@tip/database';
import { backfillKlines, backfillFunding } from './backfill.js';

const SYM = marketSymbol('BTCUSDT');
const MIN = 60_000;
const BASE = 28_333_334 * MIN; // minute-aligned epoch — the fake regenerates its grid from it

/**
 * Simulated Bybit v5 semantics — THE BUG THIS SUITE GUARDS: when [start, end] holds more rows
 * than `limit`, the API returns the NEWEST `limit` rows in the range, not the oldest. Naive
 * forward pagination against this fetches the tail once and stops ("fetched 1001, inserted
 * 1000" on a 9-month request — observed live 2026-09-02).
 */
function fakeExchange(historyStartMs: number, historyEndMs: number) {
  const kline = (openMs: number) => ({
    symbol: SYM, timeframe: '1m' as const, openTime: new Date(openMs), closeTime: new Date(openMs + MIN),
    open: '1', high: '2', low: '0.5', close: '1.5', volume: '10', turnover: '15',
    confirm: true, eventTime: new Date(openMs).toISOString(), processingTime: new Date(openMs).toISOString(),
  });
  const getKlines = vi.fn(async (_s: unknown, _tf: unknown, q: { start: number; end: number; limit: number }) => {
    const from = Math.max(q.start, historyStartMs);
    const to = Math.min(q.end, historyEndMs);
    const opens: number[] = [];
    for (let t = Math.ceil(from / MIN) * MIN; t <= to; t += MIN) opens.push(t);
    return opens.slice(-q.limit).map(kline); // newest `limit` in range — the tail bias
  });
  return { getKlines };
}

function fakeDb() {
  const inserted: { openTime?: Date; fundingTime?: Date }[] = [];
  const seen = new Set<number>();
  const db = {
    insert: () => ({
      values: (arr: { openTime?: Date; fundingTime?: Date }[]) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const fresh = arr.filter((r) => {
              const t = (r.openTime ?? r.fundingTime)!.getTime();
              if (seen.has(t)) return false;
              seen.add(t);
              return true;
            });
            inserted.push(...fresh);
            return fresh.map(() => ({}));
          },
        }),
      }),
    }),
  } as unknown as Db;
  return { db, inserted };
}

describe('backfillKlines vs Bybit tail-bias (the 2026-09-02 one-page bug)', () => {
  it('covers the FULL range even when it holds many pages of candles', async () => {
    // 3,500 one-minute candles — 3.5 pages at limit 1000. The old forward-cursor loop got 1001.
    const n = 3_500;
    const rest = fakeExchange(BASE, BASE + (n - 1) * MIN) as unknown as BybitRestClient;
    const { db, inserted } = fakeDb();

    const r = await backfillKlines(rest, db, SYM, '1m', BASE, BASE + (n - 1) * MIN);

    expect(r.inserted).toBe(n); // every candle in the range, not just the newest page
    expect(inserted).toHaveLength(n);
    const times = inserted.map((row) => row.openTime!.getTime()).sort((a, b) => a - b);
    expect(times[0]).toBe(BASE);
    expect(times[times.length - 1]).toBe(BASE + (n - 1) * MIN);
  });

  it('an empty window (pre-listing gap) does not stall the loop', async () => {
    // History only exists in the SECOND half of the requested range.
    const n = 1_500;
    const historyStart = BASE + 2_000 * MIN;
    const rest = fakeExchange(historyStart, historyStart + (n - 1) * MIN) as unknown as BybitRestClient;
    const { db, inserted } = fakeDb();
    const r = await backfillKlines(rest, db, SYM, '1m', BASE, historyStart + (n - 1) * MIN);
    expect(r.inserted).toBe(n);
    expect(inserted).toHaveLength(n);
  });

  it('handles an entirely empty range', async () => {
    const rest = fakeExchange(BASE + 10 * MIN, BASE) as unknown as BybitRestClient; // no rows
    const { db } = fakeDb();
    const r = await backfillKlines(rest, db, SYM, '1h', BASE, BASE + 60 * MIN);
    expect(r).toEqual({ fetched: 0, inserted: 0 });
  });
});

describe('backfillFunding backward pagination', () => {
  it('walks the end-cursor back through a multi-page range', async () => {
    // 8h funding cadence, 450 stamps ≈ 2.25 pages at limit 200.
    const H8 = 8 * 3600_000;
    const nStamps = 450;
    const stamps = Array.from({ length: nStamps }, (_, i) => BASE + i * H8);
    const getFundingHistory = vi.fn(async (_s: unknown, q: { start: number; end: number; limit: number }) => {
      const inRange = stamps.filter((t) => t >= q.start && t <= q.end);
      return inRange.slice(-q.limit).map((t) => ({ symbol: SYM, fundingTime: new Date(t), rate: '0.0001' })); // tail bias
    });
    const rest = { getFundingHistory } as unknown as BybitRestClient;
    const { db, inserted } = fakeDb();

    const r = await backfillFunding(rest, db, SYM, BASE, BASE + (nStamps - 1) * H8);

    expect(r.inserted).toBe(nStamps);
    const times = inserted.map((row) => row.fundingTime!.getTime()).sort((a, b) => a - b);
    expect(times[0]).toBe(BASE);
    expect(times[times.length - 1]).toBe(BASE + (nStamps - 1) * H8);
  });
});
