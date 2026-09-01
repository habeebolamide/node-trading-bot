/**
 * Observed-swap price approximation (the chosen early-entry data source). A token's price series
 * is assembled from the swaps we've actually seen on it (price = SOL / token per swap) — no bulk
 * historical archival needed (§25 scope). Forward returns read the nearest swap at/after a horizon;
 * horizons with no nearby swap return `null` (unknown), never a fabricated 0 (rule 14/25 spirit).
 * Coverage sharpens automatically as live swap volume fills the series.
 */
export interface PricePoint {
  time: number; // ms epoch
  price: number; // SOL per token
}

export interface SwapForSeries {
  amountSol: string | number;
  tokenAmount: string | number;
  blockTime: Date;
}

const HORIZONS_MS: Record<string, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};
export const HORIZON_KEYS = Object.keys(HORIZONS_MS);

const num = (v: string | number): number => (typeof v === 'number' ? v : Number(v));

/** Build an ascending price series from a token's swaps (skips zero-amount/zero-token swaps). */
export function buildSeries(swaps: readonly SwapForSeries[]): PricePoint[] {
  const pts: PricePoint[] = [];
  for (const s of swaps) {
    const sol = num(s.amountSol);
    const tokens = num(s.tokenAmount);
    if (sol <= 0 || tokens <= 0) continue;
    pts.push({ time: s.blockTime.getTime(), price: sol / tokens });
  }
  return pts.sort((a, b) => a.time - b.time);
}

export interface ForwardReturns {
  returns: Record<string, number | null>;
  /** Fraction of horizons that had a nearby swap (0..1). */
  coverage: number;
  /** Max forward return across horizons that had data, or null if none did. */
  peak: number | null;
}

/**
 * Forward returns from an entry, per horizon. For horizon h, the "price at +h" is the first series
 * point at time ≥ entryTime+h and within `tolerance` of it (tolerance defaults to h itself — a
 * generous window that suits sparse memecoin data). No qualifying point → null for that horizon.
 */
export function forwardReturns(
  entryPrice: number,
  entryTime: number,
  series: readonly PricePoint[],
  horizons: readonly string[] = HORIZON_KEYS,
): ForwardReturns {
  const returns: Record<string, number | null> = {};
  let covered = 0;
  let peak: number | null = null;

  for (const h of horizons) {
    const hMs = HORIZONS_MS[h]!;
    const target = entryTime + hMs;
    const tolerance = hMs; // accept a swap up to one horizon past the target
    const pt = series.find((p) => p.time >= target && p.time <= target + tolerance);
    if (!pt || entryPrice <= 0) {
      returns[h] = null;
      continue;
    }
    const r = (pt.price - entryPrice) / entryPrice;
    returns[h] = r;
    covered += 1;
    peak = peak === null ? r : Math.max(peak, r);
  }

  return { returns, coverage: horizons.length ? covered / horizons.length : 0, peak };
}
