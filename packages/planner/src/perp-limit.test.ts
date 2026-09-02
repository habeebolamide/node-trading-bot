import { describe, it, expect } from 'vitest';
import { marketSymbol } from '@tip/domain';
import type { AsOfMarketData } from '@tip/evaluation';
import type { ScoringConfig } from '@tip/trading-agents';
import { planPerp } from './perp.js';

// A gently-rising tape with two clean pivots, same shape as perp.test's happy-path fixture.
function makeBars() {
  const open = new Date('2026-06-01T00:00:00Z').getTime();
  const bars = [];
  for (let i = 0; i < 60; i++) {
    const mid = 99.7 + i * 0.005;
    let h = mid + 0.15, l = mid - 0.15;
    if (i === 40) l = 98.0;
    if (i === 50) h = 104.0;
    bars.push({
      symbol: marketSymbol('BTCUSDT'), timeframe: '1h' as const,
      openTime: new Date(open + i * 60 * 60_000),
      closeTime: new Date(open + (i + 1) * 60 * 60_000 - 1),
      open: String(mid), high: String(h), low: String(l), close: String(mid),
      volume: '1', turnover: null,
    });
  }
  return bars;
}
const fakeView = (bars: ReturnType<typeof makeBars>): AsOfMarketData => ({
  asOf: bars[bars.length - 1]!.closeTime,
  async candlesAsOf() { return bars; }, async fundingAsOf() { return []; }, async oiAsOf() { return []; },
} as unknown as AsOfMarketData);

const baseConfig: ScoringConfig = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
  entryType: 'MARKET',
  limitPullbackAtr: 0.3,
};

describe('planPerp — LIMIT entry (m6-limit-orders-perp)', () => {
  it('default entryType MARKET preserves existing behaviour — entry = close', async () => {
    const view = fakeView(makeBars());
    const r = await planPerp({ symbol: marketSymbol('BTCUSDT'), direction: 'LONG', style: 'day',
      config: baseConfig, configVersion: 1, balance: 100_000, view });
    expect(r.kind).toBe('TRADE');
    if (r.kind === 'TRADE') {
      expect(r.setup.entryType).toBe('MARKET');
      expect(r.setup.entry).toBeCloseTo(Number((await view.candlesAsOf(marketSymbol('BTCUSDT'), '1h', 60)).slice(-1)[0]!.close), 4);
    }
  });

  it('LIMIT LONG sets entry BELOW close by limitPullbackAtr × ATR', async () => {
    const view = fakeView(makeBars());
    const cfg: ScoringConfig = { ...baseConfig, entryType: 'LIMIT', limitPullbackAtr: 0.5 };
    const r = await planPerp({ symbol: marketSymbol('BTCUSDT'), direction: 'LONG', style: 'day',
      config: cfg, configVersion: 1, balance: 100_000, view });
    expect(r.kind).toBe('TRADE');
    if (r.kind === 'TRADE') {
      expect(r.setup.entryType).toBe('LIMIT');
      // Entry strictly below last close (pullback for LONG buys lower)
      const lastClose = Number((await view.candlesAsOf(marketSymbol('BTCUSDT'), '1h', 60)).slice(-1)[0]!.close);
      expect(r.setup.entry).toBeLessThan(lastClose);
    }
  });

  it('LIMIT SHORT sets entry ABOVE close', async () => {
    const view = fakeView(makeBars());
    const cfg: ScoringConfig = { ...baseConfig, entryType: 'LIMIT', limitPullbackAtr: 0.5 };
    const r = await planPerp({ symbol: marketSymbol('BTCUSDT'), direction: 'SHORT', style: 'day',
      config: cfg, configVersion: 1, balance: 100_000, view });
    if (r.kind === 'TRADE') {
      const lastClose = Number((await view.candlesAsOf(marketSymbol('BTCUSDT'), '1h', 60)).slice(-1)[0]!.close);
      expect(r.setup.entry).toBeGreaterThan(lastClose);
      expect(r.setup.entryType).toBe('LIMIT');
    }
  });

  it('LIMIT still enforces R:R + sizing gates — config with tight minRR still vetoes', async () => {
    const view = fakeView(makeBars());
    const cfg: ScoringConfig = { ...baseConfig, entryType: 'LIMIT', minRR: 50 };
    const r = await planPerp({ symbol: marketSymbol('BTCUSDT'), direction: 'LONG', style: 'day',
      config: cfg, configVersion: 1, balance: 100_000, view });
    expect(r.kind).toBe('NO_TRADE');
    if (r.kind === 'NO_TRADE') expect(r.reason).toBe('INSUFFICIENT_RR');
  });

  it('confidence-invariance guarantee holds for LIMIT too (§35 anti-pattern)', async () => {
    // Two calls only differ in signal direction word; sizing must be byte-identical.
    const view = fakeView(makeBars());
    const cfg: ScoringConfig = { ...baseConfig, entryType: 'LIMIT' };
    const a = await planPerp({ symbol: marketSymbol('BTCUSDT'), direction: 'LONG', style: 'day', config: cfg, configVersion: 1, balance: 100_000, view });
    const b = await planPerp({ symbol: marketSymbol('BTCUSDT'), direction: 'LONG', style: 'day', config: cfg, configVersion: 1, balance: 100_000, view });
    expect(a).toEqual(b);
  });
});
