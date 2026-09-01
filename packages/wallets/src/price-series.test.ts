import { describe, it, expect } from 'vitest';
import { buildSeries, forwardReturns } from './price-series.js';

const at = (ms: number) => new Date(ms);
const M = 60_000;

describe('buildSeries', () => {
  it('computes SOL/token prices, skips zero-amount swaps, sorts ascending', () => {
    const s = buildSeries([
      { amountSol: '3', tokenAmount: '1000', blockTime: at(2 * M) },
      { amountSol: '0', tokenAmount: '5', blockTime: at(1 * M) }, // skipped (zero sol)
      { amountSol: '2', tokenAmount: '1000', blockTime: at(0) },
    ]);
    expect(s.map((p) => p.price)).toEqual([0.002, 0.003]); // ascending by time
  });
});

describe('forwardReturns', () => {
  it('reads nearest swap per horizon; gaps stay null; peak + coverage correct', () => {
    // entry price 1 at t0; swaps at +5m (1.1) and +1h (1.5)
    const series = [
      { time: 5 * M, price: 1.1 },
      { time: 60 * M, price: 1.5 },
    ];
    const fr = forwardReturns(1, 0, series);
    expect(fr.returns['5m']).toBeCloseTo(0.1, 6);
    expect(fr.returns['15m']).toBeNull(); // no swap in [15m,30m]
    expect(fr.returns['1h']).toBeCloseTo(0.5, 6);
    expect(fr.returns['6h']).toBeNull();
    expect(fr.peak).toBeCloseTo(0.5, 6);
    expect(fr.coverage).toBeGreaterThan(0);
    expect(fr.coverage).toBeLessThanOrEqual(1);
  });

  it('never fabricates: entryPrice ≤ 0 → all null, coverage 0', () => {
    const fr = forwardReturns(0, 0, [{ time: 5 * M, price: 1 }]);
    expect(Object.values(fr.returns).every((v) => v === null)).toBe(true);
    expect(fr.coverage).toBe(0);
    expect(fr.peak).toBeNull();
  });
});
