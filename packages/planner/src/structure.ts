/**
 * Market structure — swing-pivot fractals (§Part III §4 "recent support/resistance").
 *
 * AMBIGUITY RESOLVED (m6-trade-planner design.md): Part III §4 gives a worked example with concrete
 * levels ("Recent support: $64,850") but never says how they are found. Choices considered:
 *   - rolling min/max: a single wick sets it (rejected — that isn't "support")
 *   - volume profile / order-block clustering: needs per-price volume M1 does not ingest
 *   - swing-pivot fractals: computable from `market_candle` alone, deterministic, replay-stable
 * Fractals win because change 6 (Brain Seeding) demands byte-identical replays (rule 11); a
 * non-deterministic level rule would corrupt every seeded fingerprint.
 *
 * A swing high (low) is a bar whose high (low) strictly exceeds those of the `k` bars on each
 * side. `k = 2` — the standard fractal — with strict inequality on both sides so a flat plateau
 * doesn't spawn N stacked pivots. Only bars with `k` confirmed neighbours count; the trailing `k`
 * bars are UNCONFIRMED and never pivots. That is load-bearing for no-look-ahead (rule 21): a
 * pivot detected on the most recent bar is a pivot we could not have known about yet.
 */
export interface StructureBar {
  readonly high: number;
  readonly low: number;
  readonly closeTime: Date;
}

export interface Pivot {
  readonly price: number;
  readonly at: Date;
  readonly kind: 'HIGH' | 'LOW';
  readonly touches: number; // how many times price returned to within collapse distance
}

/**
 * `k` neighbours each side; strict inequality (a `>= ` would produce runs of duplicate pivots on
 * flat plateaus). Lookback is a slice of the caller's already-narrowed bar window.
 */
export function swingPivots(bars: readonly StructureBar[], k = 2): Pivot[] {
  const pivots: Pivot[] = [];
  if (bars.length < 2 * k + 1) return pivots;
  for (let i = k; i < bars.length - k; i++) {
    const b = bars[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= k; j++) {
      if (!(b.high > bars[i - j]!.high && b.high > bars[i + j]!.high)) isHigh = false;
      if (!(b.low < bars[i - j]!.low && b.low < bars[i + j]!.low)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) pivots.push({ price: b.high, at: b.closeTime, kind: 'HIGH', touches: 1 });
    if (isLow) pivots.push({ price: b.low, at: b.closeTime, kind: 'LOW', touches: 1 });
  }
  return pivots;
}

/**
 * Collapse pivots within `atrFactor × ATR` of each other into the more-touched one — otherwise a
 * cluster of near-identical levels each look like "the" support. Stable output: the earliest
 * survivor of each cluster wins, so re-runs produce identical outputs (rule 11).
 */
export function collapsePivots(pivots: readonly Pivot[], atr: number, atrFactor = 0.25): Pivot[] {
  if (pivots.length === 0 || atr <= 0) return [...pivots];
  const threshold = atr * atrFactor;
  const byKind = { HIGH: [] as Pivot[], LOW: [] as Pivot[] };
  for (const p of pivots) byKind[p.kind].push(p);

  const out: Pivot[] = [];
  for (const kind of ['HIGH', 'LOW'] as const) {
    const sorted = [...byKind[kind]].sort((a, b) => a.price - b.price);
    for (const p of sorted) {
      const near = out.find((q) => q.kind === kind && Math.abs(q.price - p.price) < threshold);
      if (near) {
        // Merge: more-touched wins; the survivor's price stays put so replays remain stable.
        (near as { touches: number }).touches += p.touches;
      } else {
        out.push({ ...p });
      }
    }
  }
  return out;
}

export interface NearestLevels {
  readonly supportBelow: Pivot | null;
  readonly resistanceAbove: Pivot | null;
}

/** Nearest LOW pivot strictly below the reference price, nearest HIGH strictly above. */
export function nearestLevels(price: number, pivots: readonly Pivot[]): NearestLevels {
  let supportBelow: Pivot | null = null;
  let resistanceAbove: Pivot | null = null;
  for (const p of pivots) {
    if (p.kind === 'LOW' && p.price < price) {
      if (!supportBelow || p.price > supportBelow.price) supportBelow = p;
    } else if (p.kind === 'HIGH' && p.price > price) {
      if (!resistanceAbove || p.price < resistanceAbove.price) resistanceAbove = p;
    }
  }
  return { supportBelow, resistanceAbove };
}
