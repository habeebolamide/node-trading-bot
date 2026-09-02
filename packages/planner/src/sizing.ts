/**
 * Position sizing and derived leverage (§35).
 *
 * §35 is explicit about ordering: leverage is **derived last**, from where the stop already sits.
 * "An agent must never scale leverage by confidence" is called out by name as "the exact
 * anti-pattern to avoid." The functions in this file take **no `confidence` parameter at all** —
 * that is a structural enforcement rather than a discipline: the value cannot leak in if it isn't
 * accepted.
 *
 * A test in sizing.test.ts asserts sizing is byte-identical across confidence values by driving
 * `planTrade` with two signals differing only in confidence. If someone ever adds a confidence
 * arg here to "handle an edge case," that test will break loudly.
 */
import { ValidationError } from '@tip/domain';

export interface SizeInputs {
  balance: number;
  /** Fixed config value; NEVER a function of confidence (§35). */
  riskPercent: number;
  entry: number;
  stopLoss: number;
  direction: 'LONG' | 'SHORT';
}

export interface SizeOutput {
  positionSize: number;
  notional: number;
  riskBudget: number;
  stopDistance: number;
}

export function positionSize(i: SizeInputs): SizeOutput {
  if (i.balance <= 0) throw new ValidationError('balance must be > 0');
  if (i.riskPercent <= 0 || i.riskPercent > 1) throw new ValidationError('riskPercent must be in (0, 1]');
  if (i.entry <= 0) throw new ValidationError('entry must be > 0');
  const stopDistance = Math.abs(i.entry - i.stopLoss);
  if (stopDistance <= 0) throw new ValidationError('stop distance must be > 0');
  // The stop must be on the correct side of entry for the trade's direction; otherwise sizing is
  // vacuous (the trade would be immediately in profit or immediately stopped).
  if (i.direction === 'LONG' && i.stopLoss >= i.entry) throw new ValidationError('LONG: stop must be below entry');
  if (i.direction === 'SHORT' && i.stopLoss <= i.entry) throw new ValidationError('SHORT: stop must be above entry');

  const riskBudget = i.balance * i.riskPercent;
  const size = riskBudget / stopDistance;
  return { positionSize: size, notional: size * i.entry, riskBudget, stopDistance };
}

export interface LeverageInputs {
  entry: number;
  stopLoss: number;
  direction: 'LONG' | 'SHORT';
  /** Exchange maintenance-margin rate (Bybit linear ≈ 0.005 for BTC/ETH). Config, not hardcoded. */
  maintenanceMarginRate: number;
  exchangeMaxLeverage: number;
  userMaxLeverage: number;
}

/**
 * Highest leverage at which the liquidation price still sits no closer to entry than the stop.
 *
 * Bybit linear-perp liquidation (isolated, cross-collateral irrelevant for paper):
 *   LONG:  liq = entry × (1 − 1/L + m)
 *   SHORT: liq = entry × (1 + 1/L − m)
 *
 * Rearranged for `L` given the stop as the closest permissible liquidation:
 *   LONG:  L ≤ 1 / ((entry − stop)/entry + m)
 *   SHORT: L ≤ 1 / ((stop − entry)/entry + m)
 *
 * Positive because the direction check in positionSize() already forced the stop onto the correct
 * side of entry.
 */
export function maxSafeLeverage(i: LeverageInputs): number {
  const distancePct = Math.abs(i.entry - i.stopLoss) / i.entry;
  const denom = distancePct + i.maintenanceMarginRate;
  if (denom <= 0) return i.exchangeMaxLeverage; // vanishing stop distance → any leverage is fine
  return 1 / denom;
}

export interface DerivedLeverage {
  allowed: number;
  requiredMargin: number;
  maxSafe: number;
}

/** min(maxSafe, exchangeMax, userMax) → required margin. Never raises leverage to make it fit. */
export function deriveLeverage(i: LeverageInputs, notional: number): DerivedLeverage {
  const maxSafe = maxSafeLeverage(i);
  const allowed = Math.min(maxSafe, i.exchangeMaxLeverage, i.userMaxLeverage);
  const requiredMargin = notional / allowed;
  return { allowed, requiredMargin, maxSafe };
}
