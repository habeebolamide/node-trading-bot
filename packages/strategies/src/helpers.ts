import { Decimal } from 'decimal.js';
import type {
  StrategyContext,
  ManagementPolicy,
  PendingEntry,
  PositionSnapshot,
  PendingEntryDecision,
  PositionAssessment,
  DeepReadonly,
  EntryDecision,
} from './contracts.js';
export function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
export function latest(ctx: StrategyContext, frame: string) {
  return ctx.candles[frame as keyof typeof ctx.candles]?.at(-1);
}
export function value(ctx: StrategyContext, key: string, output = 'outReal') {
  return ctx.indicators[key]?.latest[output];
}
export function price(value: Decimal) {
  return (
    value.toFixed(18, Decimal.ROUND_HALF_EVEN).replace(/\.?0+$/, '') || '0'
  );
}
export function proposal(
  ctx: StrategyContext,
  side: 'LONG' | 'SHORT',
  entry: string,
  atr: number,
  stopMultiplier: number,
  reward: number,
  expiryCandles: number,
  target?: number,
): EntryDecision {
  const p = new Decimal(entry),
    distance = new Decimal(String(atr))
      .toSignificantDigits(12)
      .mul(stopMultiplier),
    sign = side === 'LONG' ? 1 : -1;
  const stop = p.minus(distance.mul(sign)),
    take =
      target === undefined
        ? p.plus(distance.mul(reward).mul(sign))
        : new Decimal(String(target)).toSignificantDigits(12);
  if (stop.lte(0) || distance.lte(0) || take.minus(p).mul(sign).lte(0))
    return { action: 'NO_TRADE', reason: 'VOLATILITY_UNSUITABLE' };
  const duration =
    ctx.trigger.type === 'CANDLE_CLOSE'
      ? ctx.trigger.timeframe === '15m'
        ? 900000
        : 300000
      : 60000;
  return {
    action: 'PROPOSE_ENTRY',
    side,
    orderType: 'MARKET',
    entryPrice: entry,
    stopLoss: price(stop),
    takeProfit: price(take),
    expiresAt: ctx.marketCutoff + duration * expiryCandles,
    reason: target === undefined ? 'TREND_CONFIRMED' : 'MEAN_REVERSION_EXTREME',
  };
}
export function pendingGuard(
  ctx: StrategyContext,
  pending: DeepReadonly<PendingEntry>,
): PendingEntryDecision | undefined {
  if (
    pending.marketKey !== ctx.marketKey ||
    pending.createdAt > ctx.decisionTime
  )
    return { action: 'CANCEL', reason: 'INVALID_PENDING_CONTEXT' };
  if (ctx.decisionTime >= pending.expiresAt)
    return { action: 'CANCEL', reason: 'ENTRY_EXPIRED' };
  if (!ctx.dataQuality.ready)
    return {
      action: 'KEEP_PENDING',
      reason: ctx.dataQuality.reason ?? 'INSUFFICIENT_DATA',
    };
}
export function positionGuard(
  ctx: StrategyContext,
  position: DeepReadonly<PositionSnapshot>,
  policy: DeepReadonly<ManagementPolicy>,
  duration: number,
): PositionAssessment | undefined {
  if (
    position.marketKey !== ctx.marketKey ||
    position.openedAt > ctx.marketCutoff
  )
    return { action: 'HOLD', reason: 'INVALID_POSITION_CONTEXT' };
  if (!ctx.dataQuality.ready)
    return {
      action: 'HOLD',
      reason: ctx.dataQuality.reason ?? 'INSUFFICIENT_DATA',
    };
  if (
    policy.timeExit.enabled &&
    ctx.marketCutoff - position.openedAt >=
      duration * policy.timeExit.maxHoldingCandles
  )
    return { action: 'CLOSE_EARLY', reason: 'MAX_HOLDING_TIME' };
}
export function tightenedStop(
  position: DeepReadonly<PositionSnapshot>,
  candidate: number,
  currentPrice: number,
): PositionAssessment {
  const p = new Decimal(String(candidate)).toSignificantDigits(12),
    confirmed = new Decimal(position.confirmedStop),
    current = new Decimal(String(currentPrice));
  const improves =
    position.side === 'LONG'
      ? p.gt(confirmed) && p.lt(current)
      : p.lt(confirmed) && p.gt(current);
  return improves && p.gt(0)
    ? {
        action: 'SUGGEST_STOP',
        newStopPrice: price(p),
        reason: 'ATR_TRAILING_STOP',
      }
    : { action: 'HOLD', reason: 'THESIS_VALID' };
}
