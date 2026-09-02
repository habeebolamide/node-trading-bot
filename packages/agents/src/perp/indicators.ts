/**
 * Small technical-indicator helpers used by several perp agents. Pure functions on number arrays,
 * so they're trivially unit-testable. All computed from `close` (or `high`/`low`) values in
 * chronological order.
 */

/** Simple moving average of the last `n` values. */
export function sma(values: readonly number[], n: number): number | null {
  if (values.length < n || n <= 0) return null;
  const window = values.slice(-n);
  return window.reduce((s, v) => s + v, 0) / n;
}

/** Exponential moving average — returns the full series so slope work is easy. */
export function ema(values: readonly number[], span: number): number[] {
  if (values.length === 0 || span <= 0) return [];
  const k = 2 / (span + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i]! * k + out[i - 1]! * (1 - k));
  }
  return out;
}

/** RSI(period) using Wilder's smoothing. Returns null when there isn't enough data. */
export function rsi(closes: readonly number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const gain = Math.max(d, 0);
    const loss = Math.max(-d, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD(fast, slow, signal). Returns the latest histogram value + a rolling max magnitude. */
export function macdHistogram(closes: readonly number[], fast = 12, slow = 26, signal = 9): { hist: number | null; magnitude: number | null } {
  if (closes.length < slow + signal) return { hist: null, magnitude: null };
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) macdLine.push((emaFast[i] ?? 0) - (emaSlow[i] ?? 0));
  const signalLine = ema(macdLine, signal);
  const histSeries: number[] = macdLine.map((v, i) => v - (signalLine[i] ?? 0));
  const hist = histSeries[histSeries.length - 1]!;
  const window = histSeries.slice(-50).map(Math.abs);
  const magnitude = window.length ? Math.max(...window) : null;
  return { hist, magnitude };
}

/** True range for candle `i` (needs prior close). */
export function trueRange(candles: readonly { high: number; low: number; close: number }[], i: number): number {
  if (i === 0) return candles[0]!.high - candles[0]!.low;
  const c = candles[i]!;
  const pc = candles[i - 1]!.close;
  return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
}

/** ATR(period) using Wilder's smoothing. */
export function atr(candles: readonly { high: number; low: number; close: number }[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) trs.push(trueRange(candles, i));
  let a = trs.slice(1, period + 1).reduce((s, x) => s + x, 0) / period;
  for (let i = period + 1; i < trs.length; i++) a = (a * (period - 1) + trs[i]!) / period;
  return a;
}

/** Percentile (0..1) of `value` in `population` — inclusive lower rank. */
export function percentile(value: number, population: readonly number[]): number | null {
  if (population.length === 0) return null;
  const le = population.filter((v) => v <= value).length;
  return le / population.length;
}

/**
 * Wilder's ADX(14) (§40.3 — audit-2 B4: was proxied by EMA slope). Returns null until
 * 2×period+1 candles exist. Standard construction: directional movement smoothed by Wilder's
 * method → +DI/−DI → DX → ADX as the Wilder average of DX.
 */
export function adx(candles: readonly { high: number; low: number; close: number }[], period = 14): number | null {
  if (candles.length < 2 * period + 1) return null;
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const down = candles[i - 1]!.low - candles[i]!.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(trueRange(candles, i));
  }
  const wilder = (xs: readonly number[]): number[] => {
    const out: number[] = [];
    let s = xs.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(s);
    for (let i = period; i < xs.length; i++) {
      s = s - s / period + xs[i]!;
      out.push(s);
    }
    return out;
  };
  const sTR = wilder(tr);
  const sPlus = wilder(plusDM);
  const sMinus = wilder(minusDM);
  const dx: number[] = [];
  for (let i = 0; i < sTR.length; i++) {
    if (sTR[i] === 0) { dx.push(0); continue; }
    const pdi = 100 * (sPlus[i]! / sTR[i]!);
    const mdi = 100 * (sMinus[i]! / sTR[i]!);
    dx.push(pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi));
  }
  if (dx.length < period) return null;
  // ADX = Wilder average of DX: seed with the mean of the first `period` DX values.
  let a = dx.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < dx.length; i++) a = (a * (period - 1) + dx[i]!) / period;
  return a;
}
