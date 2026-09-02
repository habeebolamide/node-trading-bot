/**
 * Wilder's ATR — duplicated here rather than imported from `@tip/agents` to keep the planner off
 * that dependency arrow. `@tip/agents` depends on `@tip/trading-agents` and `@tip/brain`; the
 * planner is deliberately narrower and consumes only what it needs. Same formula as
 * packages/agents/src/perp/indicators.ts atr().
 */
export function trueRange(bars: readonly { high: number; low: number; close: number }[], i: number): number {
  const b = bars[i]!;
  if (i === 0) return b.high - b.low;
  const prev = bars[i - 1]!.close;
  return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
}

export function atr(bars: readonly { high: number; low: number; close: number }[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRange(bars, i);
  let a = sum / period;
  for (let i = period + 1; i < bars.length; i++) a = ((period - 1) * a + trueRange(bars, i)) / period;
  return a;
}
