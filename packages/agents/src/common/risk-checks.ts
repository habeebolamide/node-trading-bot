/**
 * Pure risk checks (§40.12). No I/O — takes an already-assembled inputs snapshot and returns
 * `{ level, flags[] }`. The Risk Agent (risk-agent.ts) is responsible for loading the snapshot
 * from DB + M4 buffers and calling this.
 *
 * Aggregation rule: each flag adds 1 weight; risk_level:
 *   0 → LOW
 *   1 → MEDIUM
 *   2 → MEDIUM_HIGH
 *   3 → HIGH
 *   4+ → INVALIDATED   (Signal transitions to INVALIDATED per §36)
 */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'MEDIUM_HIGH' | 'HIGH' | 'INVALIDATED';

export interface PerpRiskInputs {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  entryPrice: number;
  atr14: number;
  nearestSupport: number | null;
  nearestResistance: number | null;
  fundingPercentile30d: number | null; // 0..1
  oiPercentile30d: number | null;
  atrRatio: number | null; // current ATR / rolling avg
  emaDistanceInAtr: number | null; // (price - EMA50) / ATR
}

export interface MemecoinRiskInputs {
  tokenAgeMinutes: number | null;
  positionNotionalRatioToPoolShareCap: number | null; // e.g. 0.6 = 60% of cap
  walletScoreVsUniverseMedian: number | null; // e.g. -0.2 = 20% below median
}

export interface RiskResult {
  level: RiskLevel;
  flags: string[];
}

function levelFor(flagCount: number): RiskLevel {
  if (flagCount >= 4) return 'INVALIDATED';
  if (flagCount === 3) return 'HIGH';
  if (flagCount === 2) return 'MEDIUM_HIGH';
  if (flagCount === 1) return 'MEDIUM';
  return 'LOW';
}

export function evaluatePerpRisk(i: PerpRiskInputs): RiskResult {
  const flags: string[] = [];

  // S/R proximity against direction
  if (i.direction === 'LONG' && i.nearestResistance !== null && i.atr14 > 0 &&
      Math.abs(i.nearestResistance - i.entryPrice) < 0.3 * i.atr14) {
    flags.push('SR_PROXIMITY_RESISTANCE');
  }
  if (i.direction === 'SHORT' && i.nearestSupport !== null && i.atr14 > 0 &&
      Math.abs(i.entryPrice - i.nearestSupport) < 0.3 * i.atr14) {
    flags.push('SR_PROXIMITY_SUPPORT');
  }

  // Funding extremity against direction
  if (i.fundingPercentile30d !== null) {
    if (i.direction === 'LONG' && i.fundingPercentile30d > 0.95) flags.push('FUNDING_EXTREME_LONG');
    if (i.direction === 'SHORT' && i.fundingPercentile30d < 0.05) flags.push('FUNDING_EXTREME_SHORT');
  }

  // OI extremity (both directions)
  if (i.oiPercentile30d !== null && i.oiPercentile30d > 0.9) flags.push('OI_EXTREME');

  // Volatility extremity
  if (i.atrRatio !== null && i.atrRatio > 2.0) flags.push('VOL_EXTREME');

  // Price extension from EMA(50)
  if (i.emaDistanceInAtr !== null && Math.abs(i.emaDistanceInAtr) > 2) flags.push('PRICE_EXTENDED');

  return { level: levelFor(flags.length), flags };
}

export function evaluateMemecoinRisk(i: MemecoinRiskInputs): RiskResult {
  const flags: string[] = [];
  if (i.tokenAgeMinutes !== null && i.tokenAgeMinutes < 5) flags.push('TOKEN_TOO_FRESH');
  if (i.positionNotionalRatioToPoolShareCap !== null && i.positionNotionalRatioToPoolShareCap > 0.5) {
    flags.push('THIN_POOL_LIQUIDITY');
  }
  if (i.walletScoreVsUniverseMedian !== null && i.walletScoreVsUniverseMedian < 0) {
    flags.push('WALLET_BELOW_MEDIAN');
  }
  return { level: levelFor(flags.length), flags };
}
