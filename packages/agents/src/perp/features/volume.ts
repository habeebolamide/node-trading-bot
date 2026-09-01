/**
 * Perp Volume feature (§40.15). Aggregator-only — 10-candle volume-signed candle direction:
 *   volume_signed_direction = Σ (sign(close_i − open_i) × volume_i) / Σ volume_i    ∈ [-1, +1]
 * Buffer < 10 → contribute 0 (do not degrade the composite).
 */
export interface VolumeCandle { open: number; close: number; volume: number }

export function volumeSignedDirection(candles: readonly VolumeCandle[]): number {
  const window = candles.slice(-10);
  if (window.length < 10) return 0;
  let signed = 0;
  let total = 0;
  for (const c of window) {
    const sign = c.close > c.open ? 1 : c.close < c.open ? -1 : 0;
    signed += sign * c.volume;
    total += c.volume;
  }
  return total > 0 ? Math.max(-1, Math.min(1, signed / total)) : 0;
}
