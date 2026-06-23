import {
  RSI,
  EMA,
  MACD,
  BollingerBands,
  ADX,
  ATR,
} from 'technicalindicators';
import type { BollingerResult, Candle, Indicators, MacdResult, VolumeResult } from '../types/market.types.js';

// ─────────────────────────────────────────────
// Main export — call this with a candle buffer
// Returns all indicators Claude needs
// ─────────────────────────────────────────────

export function calculateIndicators(candles: Candle[]): Indicators | null {
  if (candles.length < 50) {
    // Not enough candles yet — need at least 50 for reliable values
    return null;
  }

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  return {
    rsi:       calculateRSI(closes),
    ema20:     calculateEMA(closes, 20),
    ema50:     calculateEMA(closes, 50),
    ema200:    calculateEMA(closes, 200),
    macd:      calculateMACD(closes),
    bollinger: calculateBollinger(closes),
    adx:       calculateADX(highs, lows, closes),
    atr:       calculateATR(highs, lows, closes),
    volume:    calculateVolume(volumes),
  };
}

// ─────────────────────────────────────────────
// RSI — momentum oscillator 0-100
// Overbought > 70, Oversold < 30
// ─────────────────────────────────────────────

function calculateRSI(closes: number[], period = 14): number {
  const result = RSI.calculate({ values: closes, period });
  return round(result.at(-1) ?? 50);
}

// ─────────────────────────────────────────────
// EMA — exponential moving average
// ─────────────────────────────────────────────

function calculateEMA(closes: number[], period: number): number {
  const result = EMA.calculate({ values: closes, period });
  return round(result.at(-1) ?? closes.at(-1) ?? 0);
}

// ─────────────────────────────────────────────
// MACD — trend + momentum
// histogram > 0 = bullish momentum
// histogram < 0 = bearish momentum
// ─────────────────────────────────────────────

function calculateMACD(closes: number[]): MacdResult {
  const result = MACD.calculate({
    values:             closes,
    fastPeriod:         12,
    slowPeriod:         26,
    signalPeriod:       9,
    SimpleMAOscillator: false,
    SimpleMASignal:     false,
  });

  const last = result.at(-1);

  return {
    macd:      round(last?.MACD      ?? 0),
    signal:    round(last?.signal    ?? 0),
    histogram: round(last?.histogram ?? 0),
  };
}

// ─────────────────────────────────────────────
// Bollinger Bands — volatility measure
// width = (upper - lower) / middle
// tight bands = consolidation, wide = volatile
// ─────────────────────────────────────────────

function calculateBollinger(closes: number[], period = 20): BollingerResult {
  const result = BollingerBands.calculate({
    values: closes,
    period,
    stdDev: 2,
  });

  const last = result.at(-1);

  if (!last) {
    const price = closes.at(-1) ?? 0;
    return { upper: price, middle: price, lower: price, width: 0 };
  }

  const width = last.middle > 0
    ? (last.upper - last.lower) / last.middle
    : 0;

  return {
    upper:  round(last.upper),
    middle: round(last.middle),
    lower:  round(last.lower),
    width:  round(width, 4),
  };
}

// ─────────────────────────────────────────────
// ADX — trend strength 0-100
// < 20 = no trend (ranging)
// 20-25 = weak trend forming
// > 25 = strong trend
// > 50 = very strong trend
// ─────────────────────────────────────────────

function calculateADX(
  highs:  number[],
  lows:   number[],
  closes: number[],
  period = 14
): number {
  const result = ADX.calculate({ high: highs, low: lows, close: closes, period });
  return round(result.at(-1)?.adx ?? 0);
}

// ─────────────────────────────────────────────
// ATR — average true range
// Measures volatility in price units
// Used for position sizing and SL placement
// ─────────────────────────────────────────────

function calculateATR(
  highs:  number[],
  lows:   number[],
  closes: number[],
  period = 14
): number {
  const result = ATR.calculate({ high: highs, low: lows, close: closes, period });
  return round(result.at(-1) ?? 0);
}

// ─────────────────────────────────────────────
// Volume analysis
// ratio > 1.5 = volume spike — significant move
// ─────────────────────────────────────────────

function calculateVolume(volumes: number[]): VolumeResult {
  const current = volumes.at(-1) ?? 0;

  // 20 candle average — exclude current candle
  const recent  = volumes.slice(-21, -1);
  const average = recent.length > 0
    ? recent.reduce((a, b) => a + b, 0) / recent.length
    : current;

  const ratio = average > 0 ? current / average : 1;

  // Volume trend — compare last 5 vs previous 5
  const last5 = volumes.slice(-5);
  const prev5 = volumes.slice(-10, -5);
  const last5Avg = avg(last5);
  const prev5Avg = avg(prev5);

  const trend =
    last5Avg > prev5Avg * 1.1 ? 'increasing' :
    last5Avg < prev5Avg * 0.9 ? 'decreasing' :
    'flat';

  return {
    current: round(current),
    average: round(average),
    ratio:   round(ratio, 2),
    trend,
  };
}

// ─────────────────────────────────────────────
// RSI level crossing — used by significance checker
// Returns true if RSI just crossed 30, 50, or 70
// ─────────────────────────────────────────────

export function rsiCrossedLevel(candles: Candle[], levels = [30, 50, 70]): boolean {
  if (candles.length < 16) return false;

  const closes    = candles.map(c => c.close);
  const rsiValues = RSI.calculate({ values: closes, period: 14 });

  if (rsiValues.length < 2) return false;

  const current  = rsiValues.at(-1)!;
  const previous = rsiValues.at(-2)!;

  return levels.some(level =>
    (previous < level && current >= level) || // crossed up
    (previous > level && current <= level)    // crossed down
  );
}

// ─────────────────────────────────────────────
// EMA slope — used by regime detector
// Returns % change per candle over last N periods
// Positive = uptrend, negative = downtrend
// ─────────────────────────────────────────────

export function calculateEMASlope(candles: Candle[], period = 20, lookback = 5): number {
  if (candles.length < period + lookback) return 0;

  const closes = candles.map(c => c.close);
  const emas   = EMA.calculate({ values: closes, period });

  if (emas.length < lookback + 1) return 0;

  const current  = emas.at(-1)!;
  const previous = emas.at(-1 - lookback)!;

  // % change over lookback period
  return round((current - previous) / previous * 100, 4);
}

// ─────────────────────────────────────────────
// Momentum trajectory — the DIRECTION of momentum, not just its level.
// calculateIndicators returns single latest values (a snapshot); this fills
// the gap the LLM is otherwise blind to: is RSI rising or falling, is the MACD
// histogram expanding (momentum building) or contracting (fading), and is price
// diverging from RSI (a classic reversal warning). Used mainly for trade
// management — "is this move running out of steam?" — but also surfaces at entry
// to flag late entries and reversal setups.
// ─────────────────────────────────────────────

export interface MomentumTrajectory {
  rsi:        'rising' | 'falling' | 'flat';
  rsiDelta:   number;                       // RSI change over the lookback window
  macd:       'expanding' | 'contracting' | 'flat';  // |histogram| trajectory
  macdSign:   'positive' | 'negative';
  divergence: 'bullish' | 'bearish' | null; // price vs RSI over recent window
}

export function calculateMomentumTrajectory(
  candles:  Candle[],
  lookback: number = 4,
): MomentumTrajectory | null {
  if (candles.length < 50) return null;

  const closes     = candles.map(c => c.close);
  const rsiSeries  = RSI.calculate({ values: closes, period: 14 });
  const macdSeries = MACD.calculate({
    values:             closes,
    fastPeriod:         12,
    slowPeriod:         26,
    signalPeriod:       9,
    SimpleMAOscillator: false,
    SimpleMASignal:     false,
  });

  // RSI direction — change over the lookback window. ±2 deadband filters noise.
  const rsiNow   = rsiSeries.at(-1) ?? 50;
  const rsiPrev  = rsiSeries.at(-1 - lookback) ?? rsiNow;
  const rsiDelta = round(rsiNow - rsiPrev, 1);
  const rsi: MomentumTrajectory['rsi'] =
    rsiDelta > 2 ? 'rising' : rsiDelta < -2 ? 'falling' : 'flat';

  // MACD histogram trajectory — |hist| growing = momentum building, shrinking =
  // fading toward a cross. The sign says direction; the trajectory says strength.
  const histNow  = macdSeries.at(-1)?.histogram ?? 0;
  const histPrev = macdSeries.at(-1 - lookback)?.histogram ?? histNow;
  const absNow   = Math.abs(histNow);
  const absPrev  = Math.abs(histPrev);
  const macd: MomentumTrajectory['macd'] =
    absNow > absPrev * 1.1 ? 'expanding' :
    absNow < absPrev * 0.9 ? 'contracting' : 'flat';
  const macdSign: MomentumTrajectory['macdSign'] = histNow >= 0 ? 'positive' : 'negative';

  return {
    rsi,
    rsiDelta,
    macd,
    macdSign,
    divergence: detectDivergence(candles, rsiSeries),
  };
}

// Price/RSI divergence over the most recent window. Compares the price extreme
// in the recent half vs the prior half against RSI at those same points:
//   bearish = price higher high, RSI lower high (uptrend losing steam)
//   bullish = price lower low,  RSI higher low  (downtrend losing steam)
// RSI.calculate drops the first `period` values, so rsiSeries[ci - 14] ≈ RSI at
// candle index ci.
function detectDivergence(
  candles:   Candle[],
  rsiSeries: number[],
  window = 30,
): 'bullish' | 'bearish' | null {
  const n = candles.length;
  if (n < window + 14) return null;

  const start = n - window;
  const mid   = start + Math.floor(window / 2);
  const rsiAt = (ci: number): number | null => {
    const k = ci - 14;
    return k >= 0 && k < rsiSeries.length ? rsiSeries[k]! : null;
  };

  let firstHigh = start, secondHigh = mid, firstLow = start, secondLow = mid;
  for (let i = start; i < mid; i++) {
    if (candles[i]!.high > candles[firstHigh]!.high) firstHigh = i;
    if (candles[i]!.low  < candles[firstLow]!.low)   firstLow  = i;
  }
  for (let i = mid; i < n; i++) {
    if (candles[i]!.high > candles[secondHigh]!.high) secondHigh = i;
    if (candles[i]!.low  < candles[secondLow]!.low)   secondLow  = i;
  }

  const r1h = rsiAt(firstHigh),  r2h = rsiAt(secondHigh);
  const r1l = rsiAt(firstLow),   r2l = rsiAt(secondLow);

  // Bearish: price made a higher high but RSI made a lower high
  if (r1h != null && r2h != null &&
      candles[secondHigh]!.high > candles[firstHigh]!.high && r2h < r1h - 1) {
    return 'bearish';
  }
  // Bullish: price made a lower low but RSI made a higher low
  if (r1l != null && r2l != null &&
      candles[secondLow]!.low < candles[firstLow]!.low && r2l > r1l + 1) {
    return 'bullish';
  }
  return null;
}

// ─────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────

function round(value: number, decimals = 2): number {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}