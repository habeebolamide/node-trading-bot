import { describe, it, expect } from 'vitest';
import type { MarketSymbol, Timeframe } from '@tip/domain';
import {
  CORRELATION_LOOKBACK_CANDLES, evaluateCorrelatedExposure, pearson, returnsFromCloses,
} from './correlation.js';

/** Deterministic close series: a base random walk, plus derived correlated/uncorrelated ones. */
function seedSeries(n = CORRELATION_LOOKBACK_CANDLES + 1): number[] {
  const out = [100];
  let x = 42;
  for (let i = 1; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31; // deterministic LCG
    const step = ((x / 2 ** 31) - 0.5) * 2; // ±1%
    out.push(out[i - 1]! * (1 + step / 100));
  }
  return out;
}

function closesProvider(map: Record<string, number[]>) {
  return async (symbol: MarketSymbol, _tf: Timeframe, limit: number): Promise<number[]> =>
    (map[symbol] ?? []).slice(-limit);
}

describe('pearson / returns (§2114 math)', () => {
  it('perfectly correlated series → 1; inverted → −1; flat → 0', () => {
    const a = [1, 2, 3, 4, 5];
    expect(pearson(a, [2, 4, 6, 8, 10])).toBeCloseTo(1, 9);
    expect(pearson(a, [5, 4, 3, 2, 1])).toBeCloseTo(-1, 9);
    expect(pearson(a, [3, 3, 3, 3, 3])).toBe(0);
    expect(pearson([], [])).toBe(0);
  });
  it('returnsFromCloses: n closes → n−1 simple returns', () => {
    const r = returnsFromCloses([100, 110, 99]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 12);
    expect(r[1]).toBeCloseTo(-0.1, 12);
    expect(returnsFromCloses([100])).toEqual([]);
  });
});

describe('evaluateCorrelatedExposure (§37 gate — audit #14)', () => {
  const base = seedSeries();
  // ETH tracks BTC tick-for-tick (corr ≈ 1); ALT is an independent walk (corr ≈ low).
  const eth = base.map((c) => c * 0.05);
  const alt = seedSeries().map((c, idx) => c * (idx % 2 === 0 ? 1.01 : 0.99)); // decorrelating noise

  it('trips the cap when holding a full-risk position in a ≥0.7-correlated symbol', async () => {
    const r = await evaluateCorrelatedExposure({
      candidateSymbol: 'BTCUSDT', candidateNotional: 1_000,
      heldPositions: [{ symbol: 'ETHUSDT', notional: 1_000 }],
      maxCorrelatedExposure: 1,
      closesAsOf: closesProvider({ BTCUSDT: base, ETHUSDT: eth }),
      timeframe: '1h',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bucketNotional).toBeCloseTo(2_000, 6);
      expect(r.cap).toBeCloseTo(1_000, 6);
      expect(r.correlated[0]!.correlation).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('passes when the held symbol is genuinely uncorrelated', async () => {
    const r = await evaluateCorrelatedExposure({
      candidateSymbol: 'BTCUSDT', candidateNotional: 1_000,
      heldPositions: [{ symbol: 'ALTUSDT', notional: 1_000 }],
      maxCorrelatedExposure: 1,
      closesAsOf: closesProvider({ BTCUSDT: base, ALTUSDT: alt }),
      timeframe: '1h',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.correlated).toHaveLength(0);
  });

  it('same symbol is bucketed at correlation 1 without a data read', async () => {
    const r = await evaluateCorrelatedExposure({
      candidateSymbol: 'BTCUSDT', candidateNotional: 500,
      heldPositions: [{ symbol: 'BTCUSDT', notional: 500 }],
      maxCorrelatedExposure: 1,
      closesAsOf: closesProvider({ BTCUSDT: base }),
      timeframe: '1h',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.correlated[0]).toEqual({ symbol: 'BTCUSDT', correlation: 1 });
  });

  it('insufficient overlapping history buckets the holding PESSIMISTICALLY (correlation: null)', async () => {
    const r = await evaluateCorrelatedExposure({
      candidateSymbol: 'BTCUSDT', candidateNotional: 1_000,
      heldPositions: [{ symbol: 'NEWUSDT', notional: 800 }],
      maxCorrelatedExposure: 1,
      closesAsOf: closesProvider({ BTCUSDT: base, NEWUSDT: [100, 101, 102] }), // 2 returns < min 10
      timeframe: '1h',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.correlated[0]!.correlation).toBeNull();
  });

  it('a raised maxCorrelatedExposure widens the bucket cap', async () => {
    const r = await evaluateCorrelatedExposure({
      candidateSymbol: 'BTCUSDT', candidateNotional: 1_000,
      heldPositions: [{ symbol: 'ETHUSDT', notional: 1_000 }],
      maxCorrelatedExposure: 2, // bucket may total 2× a full-risk position
      closesAsOf: closesProvider({ BTCUSDT: base, ETHUSDT: eth }),
      timeframe: '1h',
    });
    expect(r.ok).toBe(true); // 2,000 ≤ 2 × 1,000
  });

  it('negative correlation is a hedge, not the same bet — never bucketed', async () => {
    const inverse = base.map((c) => 200 - c * 0.5); // strongly anti-correlated
    const r = await evaluateCorrelatedExposure({
      candidateSymbol: 'BTCUSDT', candidateNotional: 1_000,
      heldPositions: [{ symbol: 'INVUSDT', notional: 1_000 }],
      maxCorrelatedExposure: 1,
      closesAsOf: closesProvider({ BTCUSDT: base, INVUSDT: inverse }),
      timeframe: '1h',
    });
    expect(r.ok).toBe(true);
  });
});
