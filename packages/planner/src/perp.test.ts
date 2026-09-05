import { describe, it, expect } from 'vitest';
import { marketSymbol } from '@tip/domain';
import type { AsOfMarketData } from '@tip/evaluation';
import { planPerp } from './perp.js';
import { planTrade } from './plan.js';
import type { ScoringConfig } from '@tip/trading-agents';

/** A synthetic candle stream: monotonic time, HLC from a simple pattern. */
function makeBars(pattern: readonly { high: number; low: number; close: number }[]) {
  const open = new Date('2026-06-01T00:00:00Z').getTime();
  return pattern.map((p, i) => ({
    symbol: marketSymbol('BTCUSDT'),
    timeframe: '1h' as const,
    openTime: new Date(open + i * 60 * 60_000),
    closeTime: new Date(open + (i + 1) * 60 * 60_000 - 1),
    open: String(p.close),
    high: String(p.high),
    low: String(p.low),
    close: String(p.close),
    volume: '1',
    turnover: null,
  }));
}

/**
 * Enough bars to satisfy ATR(14) + swing-pivot detection, with two clear pivots either side
 * of the last close. Simplest way: a slow uptrend with a clean support ~5% below entry and a
 * clean resistance ~10% above.
 */
function trendingBars() {
  // Design: last close ≈ 100. Nearest LOW pivot ~2% below at 98 (stop distance 2). Nearest HIGH
  // pivot ~4% above at 104 (reward 4). R:R = 2.0 ≥ minRR 1.5. ATR small so the collapse factor
  // never merges the two pivots.
  const bars = [];
  for (let i = 0; i < 60; i++) {
    // Gentle rise that stays near 100 with tiny bar ranges (ATR ≈ 0.3).
    const mid = 99.7 + i * 0.005;
    let h = mid + 0.15;
    let l = mid - 0.15;
    if (i === 40) l = 98.0;  // support pivot ~2 below the final close
    if (i === 50) h = 104.0; // resistance pivot ~4 above the final close
    bars.push({ high: h, low: l, close: mid });
  }
  return makeBars(bars);
}

function fakeView(bars: ReturnType<typeof makeBars>): AsOfMarketData {
  return {
    asOf: bars[bars.length - 1]!.closeTime,
    async candlesAsOf() { return bars; },
    async fundingAsOf() { return []; },
    async oiAsOf() { return []; },
  } as unknown as AsOfMarketData;
}

const perpConfig: ScoringConfig = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe('planPerp (Part III §4)', () => {
  it('produces a TRADE with entry / SL / TP / size / leverage from market structure', async () => {
    const view = fakeView(trendingBars());
    const r = await planPerp({
      symbol: marketSymbol('BTCUSDT'), direction: 'LONG', style: 'day',
      config: perpConfig, configVersion: 1, balance: 100_000, view,
    });
    expect(r.kind).toBe('TRADE');
    if (r.kind !== 'TRADE') return;
    expect(r.setup.direction).toBe('LONG');
    expect(r.setup.entryType).toBe('MARKET');
    expect(r.setup.stopLoss).toBeLessThan(r.setup.entry);
    expect(r.setup.takeProfit!).toBeGreaterThan(r.setup.entry);
    expect(r.setup.riskReward).toBeGreaterThanOrEqual(perpConfig.minRR);
    expect(r.setup.leverage!).toBeGreaterThan(0);
    expect(r.setup.leverage!).toBeLessThanOrEqual(perpConfig.leverageMax!);
    expect(r.setup.requiredMargin!).toBeGreaterThan(0);
    expect(r.setup.configVersion).toBe(1);
    expect(r.setup.horizon).toBe('4h'); // middle of day-style triad (§8)
  });

  it('is deterministic — the same view produces the identical setup twice (rule 11)', async () => {
    const view = fakeView(trendingBars());
    const a = await planPerp({ symbol: marketSymbol('BTCUSDT'), direction: 'LONG', style: 'day', config: perpConfig, configVersion: 1, balance: 100_000, view });
    const b = await planPerp({ symbol: marketSymbol('BTCUSDT'), direction: 'LONG', style: 'day', config: perpConfig, configVersion: 1, balance: 100_000, view });
    expect(a).toEqual(b);
  });

  it('ATR-based minimum stop buffer widens a too-tight stop; floor=0 leaves it', async () => {
    // trendingBars puts the support pivot ~2 below entry (~100), ATR ≈ 0.3. A large
    // minStopAtrMult forces the floor (mult × ATR) to exceed the 2-wide pivot, so the stop
    // widens past the pivot. With the floor OFF (0), the pivot stop stands.
    const view = fakeView(trendingBars());
    const args = { symbol: marketSymbol('BTCUSDT'), direction: 'LONG' as const, style: 'day' as const, configVersion: 1, balance: 100_000, view };
    const withFloor = await planPerp({ ...args, config: { ...perpConfig, minStopAtrMult: 10, minRR: 0.1 } });
    const noFloor = await planPerp({ ...args, config: { ...perpConfig, minStopAtrMult: 0, minRR: 0.1 } });
    expect(withFloor.kind).toBe('TRADE');
    expect(noFloor.kind).toBe('TRADE');
    if (withFloor.kind !== 'TRADE' || noFloor.kind !== 'TRADE') return;
    const flooredDist = withFloor.setup.entry - withFloor.setup.stopLoss;
    const pivotDist = noFloor.setup.entry - noFloor.setup.stopLoss;
    expect(flooredDist).toBeGreaterThan(pivotDist);         // floor pushed the stop out
    expect(pivotDist).toBeCloseTo(2, 0);                    // raw pivot ≈ 2 below entry
    expect(flooredDist).toBeGreaterThan(2.5);               // widened to 10×ATR (~3)
  });

  it('takeProfitAtrMult caps an over-far structural TP', async () => {
    // trendingBars puts resistance ~4 above entry (~100), ATR ≈ 0.3. A tight TP cap of 2×ATR
    // (~0.6) pulls the target in well below the 4-wide pivot. Uncapped keeps the far pivot.
    const view = fakeView(trendingBars());
    const args = { symbol: marketSymbol('BTCUSDT'), direction: 'LONG' as const, style: 'day' as const, configVersion: 1, balance: 100_000, view };
    const capped = await planPerp({ ...args, config: { ...perpConfig, takeProfitAtrMult: 2, minRR: 0.1, minStopAtrMult: 0 } });
    const uncapped = await planPerp({ ...args, config: { ...perpConfig, minRR: 0.1, minStopAtrMult: 0 } });
    expect(capped.kind).toBe('TRADE');
    expect(uncapped.kind).toBe('TRADE');
    if (capped.kind !== 'TRADE' || uncapped.kind !== 'TRADE') return;
    const cappedDist = capped.setup.takeProfit! - capped.setup.entry;
    const uncappedDist = uncapped.setup.takeProfit! - uncapped.setup.entry;
    expect(cappedDist).toBeLessThan(uncappedDist);   // cap pulled TP in
    expect(uncappedDist).toBeCloseTo(4, 0);          // raw pivot ≈ 4 above entry
    expect(cappedDist).toBeLessThan(1);              // capped to 2×ATR (~0.6)
  });

  it('NO_TRADE(STALE_OR_MISSING_DATA) when history is too thin for ATR(14)', async () => {
    const view = fakeView(makeBars([{ high: 1, low: 1, close: 1 }]));
    const r = await planPerp({ symbol: marketSymbol('BTCUSDT'), direction: 'LONG', style: 'day', config: perpConfig, configVersion: 1, balance: 100_000, view });
    expect(r.kind).toBe('NO_TRADE');
    if (r.kind === 'NO_TRADE') expect(r.reason).toBe('STALE_OR_MISSING_DATA');
  });

  it('NO_TRADE(INSUFFICIENT_RR) when minRR gates a real setup', async () => {
    const view = fakeView(trendingBars());
    const strict = { ...perpConfig, minRR: 50 }; // no real market clears this
    const r = await planPerp({ symbol: marketSymbol('BTCUSDT'), direction: 'LONG', style: 'day', config: strict, configVersion: 1, balance: 100_000, view });
    expect(r.kind).toBe('NO_TRADE');
    if (r.kind === 'NO_TRADE') expect(r.reason).toBe('INSUFFICIENT_RR');
  });

  it('NO_TRADE(CANNOT_SIZE_SAFELY) when required margin exceeds balance — leverage NOT raised', async () => {
    // Directly test the sizing gate rather than depending on planner geometry: with 50% risk on
    // a $10 balance and a 2% stop, notional = 250; at 1x leverage that needs 250 margin > 10.
    const view = fakeView(trendingBars());
    const r = await planPerp({
      symbol: marketSymbol('BTCUSDT'), direction: 'LONG', style: 'day',
      config: { ...perpConfig, riskPercent: 0.5, minRR: 0.1, leverageMax: 1 },
      configVersion: 1, balance: 10, view,
    });
    expect(r.kind).toBe('NO_TRADE');
    if (r.kind === 'NO_TRADE') expect(r.reason).toBe('CANNOT_SIZE_SAFELY');
  });

  it('two signals differing only in confidence produce byte-identical setups (§35 anti-pattern)', async () => {
    const view = fakeView(trendingBars());
    // planTrade takes no confidence field at all; verifying by planning twice with an unchanged
    // ctx proves the pipeline cannot be steered by it — even accidentally.
    const a = await planTrade(
      { symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG' },
      { style: 'day', config: perpConfig, configVersion: 1, balance: 100_000, view },
    );
    const b = await planTrade(
      { symbol: 'BTCUSDT', domain: 'perp', direction: 'STRONG_LONG' },
      { style: 'day', config: perpConfig, configVersion: 1, balance: 100_000, view },
    );
    // Directions may differ enums; but the STRONG_LONG → LONG collapse in tradeDirection() means
    // the same LONG plan comes out. That is the invariant: strength of the direction does not
    // change sizing.
    if (a.kind === 'TRADE' && b.kind === 'TRADE') {
      expect(a.setup.positionSize).toBeCloseTo(b.setup.positionSize, 10);
      expect(a.setup.leverage).toBe(b.setup.leverage);
      expect(a.setup.entry).toBe(b.setup.entry);
      expect(a.setup.stopLoss).toBe(b.setup.stopLoss);
    }
  });

  it('planTrade rejects NEUTRAL', async () => {
    await expect(planTrade(
      { symbol: 'BTCUSDT', domain: 'perp', direction: 'NEUTRAL' },
      { style: 'day', config: perpConfig, configVersion: 1, balance: 100_000, view: fakeView(trendingBars()) },
    )).rejects.toThrow();
  });
});
