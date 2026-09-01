import { describe, it, expect } from 'vitest';
import { sma, ema, rsi, macdHistogram, atr, percentile, trueRange } from './indicators.js';

describe('sma / ema', () => {
  it('sma returns null when window is too small; correct value otherwise', () => {
    expect(sma([1, 2, 3], 5)).toBeNull();
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
  });
  it('ema series length matches input length', () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e).toHaveLength(5);
    expect(e[0]).toBe(1);
  });
});

describe('rsi', () => {
  it('null for insufficient data', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });
  it('all-up series → RSI close to 100', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const r = rsi(closes, 14);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(90);
  });
  it('all-down series → RSI close to 0', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    const r = rsi(closes, 14);
    expect(r!).toBeLessThan(10);
  });
});

describe('macdHistogram', () => {
  it('null when there\'s not enough history', () => {
    expect(macdHistogram(Array.from({ length: 10 }, (_, i) => i))).toEqual({ hist: null, magnitude: null });
  });
  it('produces a histogram for a long enough series', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 5);
    const { hist, magnitude } = macdHistogram(closes);
    expect(hist).not.toBeNull();
    expect(magnitude).not.toBeNull();
  });
});

describe('atr', () => {
  it('null on too-few candles; positive on 20+ candles', () => {
    const short = [{ high: 1, low: 0.9, close: 0.95 }];
    expect(atr(short, 14)).toBeNull();
    const long = Array.from({ length: 30 }, (_, i) => ({ high: 100 + i * 0.5, low: 99 + i * 0.5, close: 99.5 + i * 0.5 }));
    expect(atr(long, 14)!).toBeGreaterThan(0);
  });
});

describe('percentile / trueRange', () => {
  it('percentile is fraction of values ≤ target', () => {
    expect(percentile(3, [1, 2, 3, 4, 5])).toBeCloseTo(0.6, 6);
    expect(percentile(0, [1, 2, 3])).toBe(0);
    expect(percentile(3, [])).toBeNull();
  });
  it('trueRange first candle = high − low', () => {
    const c = [{ high: 105, low: 95, close: 100 }];
    expect(trueRange(c, 0)).toBe(10);
  });
});
