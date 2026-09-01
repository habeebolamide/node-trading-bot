import { describe, it, expect, vi } from 'vitest';
import { marketSymbol } from '@tip/domain';
import { EVENT_NAMES, type EventBus } from '@tip/events';
import type { Db } from '@tip/database';
import { FeedMonitor } from '../staleness/monitor.js';
import { BybitAdapter } from './adapter.js';

function fakeDb() {
  const inserts: Array<{ values: unknown }> = [];
  const db = {
    insert: () => ({
      values: (v: unknown) => ({ onConflictDoNothing: async () => void inserts.push({ values: v }) }),
    }),
  } as unknown as Db;
  return { db, inserts };
}

function makeAdapter() {
  const { db, inserts } = fakeDb();
  const publish = vi.fn(async () => ({ id: 'e' }));
  const bus = { publish } as unknown as EventBus;
  const monitor = new FeedMonitor({ now: () => 0 });
  const adapter = new BybitAdapter({
    db,
    bus,
    monitor,
    symbols: [marketSymbol('BTCUSDT')],
    timeframes: ['5m'],
  });
  const typesPublished = () => publish.mock.calls.map((c) => (c[1] as { type: string }).type);
  return { adapter, inserts, publish, typesPublished };
}

const confirmedKline = {
  start: 1_700_000_000_000, end: 1_700_000_299_999, interval: '5',
  open: '100', high: '110', low: '95', close: '105', volume: '12', turnover: '1260',
  confirm: true, timestamp: 1_700_000_300_000,
};

describe('BybitAdapter kline confirm gate', () => {
  it('does NOT persist or publish a forming (unconfirmed) candle', async () => {
    const { adapter, inserts, publish } = makeAdapter();
    await adapter.ingest({ topic: 'kline.5.BTCUSDT', type: 'snapshot', ts: 1, data: [{ ...confirmedKline, confirm: false }] });
    expect(inserts).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('persists + publishes perp.kline.closed on a confirmed candle', async () => {
    const { adapter, inserts, typesPublished } = makeAdapter();
    await adapter.ingest({ topic: 'kline.5.BTCUSDT', type: 'snapshot', ts: 1, data: [confirmedKline] });
    expect(inserts).toHaveLength(1);
    expect(typesPublished()).toEqual([EVENT_NAMES.PERP_KLINE_CLOSED]);
  });
});

describe('BybitAdapter ticker funding/OI bounding', () => {
  const ticker = (over: Record<string, unknown> = {}) => ({
    topic: 'tickers.BTCUSDT',
    type: 'snapshot',
    ts: 1_700_000_000_000,
    data: { symbol: 'BTCUSDT', fundingRate: '0.0001', nextFundingTime: '1700000400000', openInterest: '5000', ...over },
  });

  it('emits funding + OI on first sight, then stays quiet when nothing changes in the same minute', async () => {
    const { adapter, typesPublished } = makeAdapter();
    await adapter.ingest(ticker());
    expect(typesPublished()).toEqual(
      expect.arrayContaining([EVENT_NAMES.PERP_FUNDING_UPDATED, EVENT_NAMES.PERP_OPEN_INTEREST_UPDATED]),
    );
    expect(typesPublished()).toHaveLength(2);

    // identical ticker, same minute → no new funding (rate unchanged) and no new OI (same bucket)
    await adapter.ingest(ticker({ openInterest: '5001' }));
    expect(typesPublished()).toHaveLength(2);
  });

  it('emits funding again only when the rate changes', async () => {
    const { adapter, publish } = makeAdapter();
    await adapter.ingest(ticker());
    await adapter.ingest(ticker({ fundingRate: '0.0002' }));
    const fundingCount = publish.mock.calls.filter((c) => (c[1] as { type: string }).type === EVENT_NAMES.PERP_FUNDING_UPDATED).length;
    expect(fundingCount).toBe(2);
  });
});
