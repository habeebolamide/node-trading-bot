import { describe, it, expect, vi } from 'vitest';
import { FeedMonitor } from './monitor.js';
import { klineThresholdMs, positioningPollThresholdMs } from './thresholds.js';

/** A controllable clock. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('FeedMonitor', () => {
  it('is not stale before the threshold, stale after, and recovers on heartbeat', () => {
    const c = clock(1_000);
    const onStale = vi.fn();
    const onRecover = vi.fn();
    const m = new FeedMonitor({ now: c.now, onStale, onRecover });
    m.register('bybit.tickers', 5_000);

    c.advance(4_000);
    m.check();
    expect(m.isStale('bybit.tickers')).toBe(false);
    expect(onStale).not.toHaveBeenCalled();

    c.advance(2_000); // total 6s since register > 5s threshold
    m.check();
    expect(m.isStale('bybit.tickers')).toBe(true);
    expect(onStale).toHaveBeenCalledTimes(1);

    // a heartbeat clears staleness exactly once
    m.heartbeat('bybit.tickers');
    expect(m.isStale('bybit.tickers')).toBe(false);
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('fires onStale only once per stale episode', () => {
    const c = clock();
    const onStale = vi.fn();
    const m = new FeedMonitor({ now: c.now, onStale });
    m.register('f', 100);
    c.advance(200);
    m.check();
    m.check();
    m.check();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('a heartbeat keeps a busy feed fresh', () => {
    const c = clock();
    const m = new FeedMonitor({ now: c.now });
    m.register('f', 100);
    for (let i = 0; i < 5; i++) {
      c.advance(80);
      m.heartbeat('f');
      m.check();
    }
    expect(m.isStale('f')).toBe(false);
  });

  it('snapshot reports each feed', () => {
    const m = new FeedMonitor({ now: () => 0 });
    m.register('a', 10);
    m.register('b', 20);
    expect(m.snapshot().map((s) => s.feedId).sort()).toEqual(['a', 'b']);
  });
});

describe('thresholds', () => {
  it('kline threshold = 2×interval + 30s', () => {
    expect(klineThresholdMs('1m')).toBe(2 * 60_000 + 30_000); // 150000 = 2m30s
    expect(klineThresholdMs('5m')).toBe(2 * 300_000 + 30_000); // 630000 = 10m30s
    expect(klineThresholdMs('1d')).toBe(2 * 86_400_000 + 30_000);
  });
  it('positioning threshold = 3×poll interval', () => {
    expect(positioningPollThresholdMs(5 * 60_000)).toBe(15 * 60_000);
  });
});
