import { describe, it, expect } from 'vitest';
import { evaluatePerpRisk, evaluateMemecoinRisk, type PerpRiskInputs, type MemecoinRiskInputs } from './risk-checks.js';

const perpBase = (over: Partial<PerpRiskInputs> = {}): PerpRiskInputs => ({
  direction: 'LONG', entryPrice: 100, atr14: 5,
  nearestSupport: 90, nearestResistance: 110,
  fundingPercentile30d: 0.5, oiPercentile30d: 0.5, atrRatio: 1.0, emaDistanceInAtr: 0,
  ...over,
});

const memeBase = (over: Partial<MemecoinRiskInputs> = {}): MemecoinRiskInputs => ({
  tokenAgeMinutes: 60, positionNotionalRatioToPoolShareCap: 0.1, walletScoreVsUniverseMedian: 0.1,
  ...over,
});

describe('evaluatePerpRisk (§40.12)', () => {
  it('all clean → LOW', () => {
    expect(evaluatePerpRisk(perpBase()).level).toBe('LOW');
  });
  it('LONG near resistance (<0.3×ATR) → flag', () => {
    const r = evaluatePerpRisk(perpBase({ nearestResistance: 101 })); // 1 vs 0.3×5=1.5
    expect(r.flags).toContain('SR_PROXIMITY_RESISTANCE');
    expect(r.level).toBe('MEDIUM');
  });
  it('SHORT near support → flag', () => {
    const r = evaluatePerpRisk(perpBase({ direction: 'SHORT', nearestSupport: 99 }));
    expect(r.flags).toContain('SR_PROXIMITY_SUPPORT');
  });
  it('LONG with funding percentile > 95 → flag', () => {
    const r = evaluatePerpRisk(perpBase({ fundingPercentile30d: 0.97 }));
    expect(r.flags).toContain('FUNDING_EXTREME_LONG');
  });
  it('SHORT with funding percentile < 5 → flag', () => {
    const r = evaluatePerpRisk(perpBase({ direction: 'SHORT', fundingPercentile30d: 0.02 }));
    expect(r.flags).toContain('FUNDING_EXTREME_SHORT');
  });
  it('OI extremity + price extension both flag', () => {
    const r = evaluatePerpRisk(perpBase({ oiPercentile30d: 0.95, emaDistanceInAtr: 3 }));
    expect(r.flags).toContain('OI_EXTREME');
    expect(r.flags).toContain('PRICE_EXTENDED');
    expect(r.level).toBe('MEDIUM_HIGH');
  });
  it('4+ flags → INVALIDATED', () => {
    const r = evaluatePerpRisk(perpBase({
      nearestResistance: 101, fundingPercentile30d: 0.97, oiPercentile30d: 0.95, atrRatio: 2.5,
    }));
    expect(r.level).toBe('INVALIDATED');
  });
});

describe('evaluateMemecoinRisk', () => {
  it('clean → LOW', () => {
    expect(evaluateMemecoinRisk(memeBase()).level).toBe('LOW');
  });
  it('fresh token (<5m) → flag', () => {
    expect(evaluateMemecoinRisk(memeBase({ tokenAgeMinutes: 2 })).flags).toContain('TOKEN_TOO_FRESH');
  });
  it('thin pool (>50% of cap) → flag', () => {
    expect(evaluateMemecoinRisk(memeBase({ positionNotionalRatioToPoolShareCap: 0.7 })).flags).toContain('THIN_POOL_LIQUIDITY');
  });
  it('wallet below median → flag', () => {
    expect(evaluateMemecoinRisk(memeBase({ walletScoreVsUniverseMedian: -0.1 })).flags).toContain('WALLET_BELOW_MEDIAN');
  });
  it('multiple flags aggregate', () => {
    const r = evaluateMemecoinRisk(memeBase({ tokenAgeMinutes: 1, positionNotionalRatioToPoolShareCap: 0.9 }));
    expect(r.level).toBe('MEDIUM_HIGH'); // 2 flags
  });
});
