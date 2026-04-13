import {
  RSI,
  EMA,
  MACD,
  BollingerBands,
  ADX,
  ATR,
} from 'technicalindicators';
import { BollingerResult, Candle, Indicators, MacdResult, VolumeResult } from '../types/market.types';

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
// Utility
// ─────────────────────────────────────────────

function round(value: number, decimals = 2): number {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}