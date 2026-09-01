/**
 * Signal fingerprint (§9 correlation / dedup). A stable hash of the "same-candle same-idea"
 * axes: `(tradingAgentId, symbol, direction, primaryTfCloseMinute)`. Re-arrivals with the same
 * fingerprint hit the DB's unique constraint on `signal.fingerprint` → the aggregator/scoring
 * flow silently no-ops on the duplicate insert, per §9 correlation.
 */
import { createHash } from 'node:crypto';

/** Bucket a timestamp down to its whole minute (UTC). */
function toMinute(t: Date): number {
  return Math.floor(t.getTime() / 60_000);
}

export function signalFingerprint(input: {
  tradingAgentId: string;
  symbol: string;
  direction: string;
  primaryTfCloseAt: Date;
}): string {
  const key = `${input.tradingAgentId}|${input.symbol}|${input.direction}|${toMinute(input.primaryTfCloseAt)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32); // 128-bit hex prefix
}
