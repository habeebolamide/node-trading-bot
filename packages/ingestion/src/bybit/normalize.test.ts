import { describe, it, expect } from 'vitest';
import { marketSymbol } from '@tip/domain';
import {
  normalizeWsKline,
  normalizeTicker,
  normalizeLiquidation,
  normalizeRestKline,
  normalizeAccountRatio,
  type RawWsKline,
} from './normalize.js';

const SYM = marketSymbol('BTCUSDT');
const PT = '2026-09-01T00:00:00.000Z';

const kline = (over: Partial<RawWsKline> = {}): RawWsKline => ({
  start: 1_700_000_000_000,
  end: 1_700_000_299_999,
  interval: '5',
  open: '100',
  high: '110',
  low: '95',
  close: '105',
  volume: '12.5',
  turnover: '1312.5',
  confirm: true,
  timestamp: 1_700_000_300_000,
  ...over,
});

describe('normalizeWsKline', () => {
  it('maps fields and derives closeTime = openTime + timeframe', () => {
    const k = normalizeWsKline(kline(), SYM, PT);
    expect(k.timeframe).toBe('5m');
    expect(k.openTime.getTime()).toBe(1_700_000_000_000);
    expect(k.closeTime.getTime()).toBe(1_700_000_000_000 + 300_000); // 5m later
    expect(k.close).toBe('105');
    expect(k.confirm).toBe(true);
    expect(k.processingTime).toBe(PT);
  });

  it('carries the confirm flag through for the adapter to gate on', () => {
    expect(normalizeWsKline(kline({ confirm: false }), SYM, PT).confirm).toBe(false);
  });
});

describe('normalizeTicker delta-merge', () => {
  it('a delta missing fundingRate does not erase the last-known value', () => {
    const snap = normalizeTicker(undefined, { fundingRate: '0.0001', openInterest: '1000', markPrice: '105' }, SYM, 1, PT);
    expect(snap.fundingRate).toBe('0.0001');

    // delta only updates OI; funding must persist from prior snapshot
    const delta = normalizeTicker(snap, { openInterest: '1200' }, SYM, 2, PT);
    expect(delta.fundingRate).toBe('0.0001');
    expect(delta.openInterest).toBe('1200');
    expect(delta.markPrice).toBe('105');
  });

  it('extracts both funding and OI from a full snapshot', () => {
    const t = normalizeTicker(
      undefined,
      { fundingRate: '-0.0002', nextFundingTime: '1700000400000', openInterest: '5000' },
      SYM,
      1,
      PT,
    );
    expect(t.fundingRate).toBe('-0.0002');
    expect(t.openInterest).toBe('5000');
    expect(t.nextFundingTime?.getTime()).toBe(1_700_000_400_000);
  });
});

describe('normalizeLiquidation', () => {
  it('normalizes the condensed Bybit v5 allLiquidation payload (T/s/S/v/p)', () => {
    const l = normalizeLiquidation({ T: 1_700_000_000_000, s: 'BTCUSDT', S: 'Sell', v: '0.1', p: '99' }, 5, PT);
    expect(l.side).toBe('SELL');
    expect(l.time.getTime()).toBe(1_700_000_000_000);
    expect(l.price).toBe('99');
    expect(l.size).toBe('0.1');
    expect(l.symbol).toBe('BTCUSDT');
  });
  it('falls back to the connection ts when T is missing', () => {
    const l = normalizeLiquidation({ s: 'BTCUSDT', S: 'Buy', v: '1', p: '100' } as never, 1_699_000_000_000, PT);
    expect(l.side).toBe('BUY');
    expect(l.time.getTime()).toBe(1_699_000_000_000);
  });
});

describe('normalizeRestKline', () => {
  it('parses a REST row and marks it confirmed', () => {
    const row = ['1700000000000', '100', '110', '95', '105', '12.5', '1312.5'];
    const k = normalizeRestKline(row, SYM, '1h', PT);
    expect(k.confirm).toBe(true);
    expect(k.closeTime.getTime()).toBe(1_700_000_000_000 + 3_600_000);
    expect(k.high).toBe('110');
  });
});

describe('normalizeAccountRatio', () => {
  it('computes longShortRatio and guards divide-by-zero', () => {
    const r = normalizeAccountRatio({ symbol: 'BTCUSDT', buyRatio: '0.6', sellRatio: '0.4', timestamp: 1_700_000_000_000 }, PT);
    expect(Number(r.longShortRatio)).toBeCloseTo(1.5, 5);
    expect(normalizeAccountRatio({ symbol: 'BTCUSDT', buyRatio: '1', sellRatio: '0', timestamp: 1 }, PT).longShortRatio).toBe('0');
  });
});
