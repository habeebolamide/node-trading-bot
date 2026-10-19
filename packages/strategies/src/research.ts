import type {
  StrategyDefinition,
  StrategyContext,
  EntryDecision,
  PendingEntryDecision,
  PositionAssessment,
} from './contracts.js';
import {
  freeze,
  latest,
  value,
  proposal,
  pendingGuard,
  positionGuard,
  tightenedStop,
} from './helpers.js';
const trendParameters = {
  fastEma: 20,
  slowEma: 50,
  confirmationEma: 50,
  adxPeriod: 14,
  adxEntry: 25,
  adxExit: 20,
  atrPeriod: 14,
  minAtrFraction: 0.001,
  maxAtrFraction: 0.05,
  stopAtr: 2,
  rewardR: 2,
} as const;
const meanParameters = {
  rsiPeriod: 14,
  rsiLow: 30,
  rsiHigh: 70,
  bbPeriod: 20,
  bbDeviations: 2,
  adxPeriod: 14,
  maxAdx: 25,
  atrPeriod: 14,
  minAtrFraction: 0.001,
  maxAtrFraction: 0.05,
  stopAtr: 1.5,
} as const;
const trendPolicy = {
  breakEven: { enabled: true, triggerR: 1, offsetR: 0 },
  trailingStop: { enabled: true, type: 'ATR' as const, atrMultiplier: 2 },
  earlyExit: { enabled: true, evaluateOnCandleClose: true },
  timeExit: { enabled: true, maxHoldingCandles: 32 },
  pendingExpiryCandles: 2,
};
const meanPolicy = {
  breakEven: { enabled: false, triggerR: 1, offsetR: 0 },
  trailingStop: { enabled: false, type: 'ATR' as const, atrMultiplier: 2 },
  earlyExit: { enabled: true, evaluateOnCandleClose: true },
  timeExit: { enabled: true, maxHoldingCandles: 12 },
  pendingExpiryCandles: 2,
};
function trendDirection(ctx: StrategyContext) {
  const fast = value(ctx, 'fast')!,
    slow = value(ctx, 'slow')!,
    confirm = value(ctx, 'confirm')!,
    hour = Number(latest(ctx, '1h')!.close),
    close = Number(latest(ctx, '15m')!.close),
    previous = ctx.indicators.fast!.previous.outReal!;
  return fast > slow && close > fast && fast > previous && hour > confirm
    ? 'LONG'
    : fast < slow && close < fast && fast < previous && hour < confirm
      ? 'SHORT'
      : null;
}
function trendEntry(ctx: StrategyContext): EntryDecision {
  if (!ctx.dataQuality.ready)
    return {
      action: 'NO_TRADE',
      reason: ctx.dataQuality.reason ?? 'INSUFFICIENT_DATA',
    };
  const close = latest(ctx, '15m')!.close,
    atr = value(ctx, 'atr')!,
    fraction = atr / Number(close);
  if (
    fraction < trendParameters.minAtrFraction ||
    fraction > trendParameters.maxAtrFraction
  )
    return { action: 'NO_TRADE', reason: 'VOLATILITY_UNSUITABLE' };
  if (value(ctx, 'adx', 'outReal')! < trendParameters.adxEntry)
    return { action: 'NO_TRADE', reason: 'WEAK_TREND' };
  const side = trendDirection(ctx);
  if (!side) return { action: 'NO_TRADE', reason: 'CONFLICTING_SIGNALS' };
  return proposal(
    ctx,
    side,
    close,
    atr,
    trendParameters.stopAtr,
    trendParameters.rewardR,
    trendPolicy.pendingExpiryCandles,
  );
}
export const trendFollowing: StrategyDefinition = freeze<StrategyDefinition>({
  id: 'trend-following',
  version: '0.1.0',
  preset: 'research-default',
  parameters: trendParameters,
  requirements: {
    trigger: 'CANDLE_CLOSE',
    primaryTimeframe: '15m',
    confirmationTimeframes: ['1h'],
    minClosedCandlesByTimeframe: { '15m': 500, '1h': 500 },
    indicators: [
      {
        key: 'fast',
        name: 'EMA',
        timeframe: '15m',
        parameters: { period: 20 },
      },
      {
        key: 'slow',
        name: 'EMA',
        timeframe: '15m',
        parameters: { period: 50 },
      },
      {
        key: 'confirm',
        name: 'EMA',
        timeframe: '1h',
        parameters: { period: 50 },
      },
      { key: 'adx', name: 'ADX', timeframe: '15m', parameters: { period: 14 } },
      { key: 'atr', name: 'ATR', timeframe: '15m', parameters: { period: 14 } },
    ],
  },
  managementPolicy: trendPolicy,
  evaluateEntry: trendEntry,
  evaluatePendingEntry(ctx, pending): PendingEntryDecision {
    const guard = pendingGuard(ctx, pending);
    if (guard) return guard;
    return trendDirection(ctx) === pending.side &&
      value(ctx, 'adx')! >= trendParameters.adxEntry
      ? { action: 'KEEP_PENDING', reason: 'THESIS_VALID' }
      : { action: 'CANCEL', reason: 'THESIS_INVALIDATED' };
  },
  evaluatePosition(ctx, position): PositionAssessment {
    const guard = positionGuard(ctx, position, trendPolicy, 900000);
    if (guard) return guard;
    if (
      trendDirection(ctx) !== position.side ||
      value(ctx, 'adx')! < trendParameters.adxExit
    )
      return { action: 'CLOSE_EARLY', reason: 'THESIS_INVALIDATED' };
    const close = Number(latest(ctx, '15m')!.close),
      atr = value(ctx, 'atr')!;
    return tightenedStop(
      position,
      position.side === 'LONG' ? close - atr * 2 : close + atr * 2,
      close,
    );
  },
});
export const meanReversion: StrategyDefinition = freeze<StrategyDefinition>({
  id: 'mean-reversion',
  version: '0.1.0',
  preset: 'research-default',
  parameters: meanParameters,
  requirements: {
    trigger: 'CANDLE_CLOSE',
    primaryTimeframe: '5m',
    confirmationTimeframes: [],
    minClosedCandlesByTimeframe: { '5m': 500 },
    indicators: [
      { key: 'rsi', name: 'RSI', timeframe: '5m', parameters: { period: 14 } },
      {
        key: 'bands',
        name: 'BBANDS',
        timeframe: '5m',
        parameters: { period: 20, deviations: 2 },
      },
      { key: 'adx', name: 'ADX', timeframe: '5m', parameters: { period: 14 } },
      { key: 'atr', name: 'ATR', timeframe: '5m', parameters: { period: 14 } },
    ],
  },
  managementPolicy: meanPolicy,
  evaluateEntry(ctx): EntryDecision {
    if (!ctx.dataQuality.ready)
      return {
        action: 'NO_TRADE',
        reason: ctx.dataQuality.reason ?? 'INSUFFICIENT_DATA',
      };
    const c = latest(ctx, '5m')!.close,
      close = Number(c),
      atr = value(ctx, 'atr')!,
      fraction = atr / close;
    if (
      fraction < meanParameters.minAtrFraction ||
      fraction > meanParameters.maxAtrFraction
    )
      return { action: 'NO_TRADE', reason: 'VOLATILITY_UNSUITABLE' };
    if (value(ctx, 'adx')! >= meanParameters.maxAdx)
      return { action: 'NO_TRADE', reason: 'MARKET_REGIME_UNSUITABLE' };
    const rsi = value(ctx, 'rsi')!,
      lower = value(ctx, 'bands', 'outRealLowerBand')!,
      upper = value(ctx, 'bands', 'outRealUpperBand')!,
      middle = value(ctx, 'bands', 'outRealMiddleBand')!;
    const side =
      close <= lower && rsi <= meanParameters.rsiLow
        ? 'LONG'
        : close >= upper && rsi >= meanParameters.rsiHigh
          ? 'SHORT'
          : null;
    return side
      ? proposal(
          ctx,
          side,
          c,
          atr,
          meanParameters.stopAtr,
          1,
          meanPolicy.pendingExpiryCandles,
          middle,
        )
      : { action: 'NO_TRADE', reason: 'NO_SETUP' };
  },
  evaluatePendingEntry(ctx, pending): PendingEntryDecision {
    const guard = pendingGuard(ctx, pending);
    if (guard) return guard;
    const close = Number(latest(ctx, '5m')!.close),
      mid = value(ctx, 'bands', 'outRealMiddleBand')!;
    return value(ctx, 'adx')! >= meanParameters.maxAdx ||
      (pending.side === 'LONG' ? close >= mid : close <= mid)
      ? { action: 'CANCEL', reason: 'THESIS_INVALIDATED' }
      : { action: 'KEEP_PENDING', reason: 'MEAN_REVERSION_PENDING' };
  },
  evaluatePosition(ctx, position): PositionAssessment {
    const guard = positionGuard(ctx, position, meanPolicy, 300000);
    if (guard) return guard;
    if (value(ctx, 'adx')! >= meanParameters.maxAdx)
      return { action: 'CLOSE_EARLY', reason: 'TREND_REGIME_INVALIDATION' };
    const close = Number(latest(ctx, '5m')!.close),
      mid = value(ctx, 'bands', 'outRealMiddleBand')!;
    return (position.side === 'LONG' ? close >= mid : close <= mid)
      ? { action: 'CLOSE_EARLY', reason: 'MEAN_REVERSION_COMPLETED' }
      : { action: 'HOLD', reason: 'THESIS_VALID' };
  },
});
export const researchStrategies = freeze([trendFollowing, meanReversion]);
