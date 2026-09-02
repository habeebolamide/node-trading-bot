/**
 * Calibration (Task 7 — first-class, not an afterthought).
 *
 * "When we say 0.7, do we hit ~70%?" A Brier score alone is not enough and Task 7 asks for both:
 * Brier says HOW WRONG on average; the reliability diagram says WHICH DIRECTION — systematically
 * overconfident is a different fix from systematically underconfident.
 *
 * Bucketing is by `confidence × horizon × regime` (Task 7 verbatim). Regime is read off the
 * Setup Memory fingerprint (already stored — same "regime falls out for free" argument M5's
 * Market Memory used). Version isolation same as every other metric — no all-versions accessor.
 *
 * Reliability bins each carry effective-n + Wilson interval so a sparse bin is reported as
 * sparse rather than as an implausibly-precise point on the curve.
 */
import { wilsonInterval } from '@tip/brain';

export interface CalibrationPoint {
  readonly confidence: number;
  readonly won: boolean;
}

/**
 * Brier score = mean((confidence − outcome)²). Bounded [0, 1]. Perfect prediction → 0;
 * always-wrong → 1; always saying 0.5 on a balanced set → 0.25 (a common sanity anchor).
 */
export function brierScore(points: readonly CalibrationPoint[]): number | null {
  if (points.length === 0) return null;
  let sum = 0;
  for (const p of points) {
    const outcome = p.won ? 1 : 0;
    sum += (p.confidence - outcome) ** 2;
  }
  return sum / points.length;
}

export interface ReliabilityBin {
  readonly binIndex: number;
  readonly lower: number;
  readonly upper: number;
  readonly midpoint: number;
  readonly n: number;
  readonly winRate: number | null;
  readonly wilsonLower: number | null;
  readonly wilsonUpper: number | null;
}

/**
 * `bins` equal-width buckets on [0, 1]. Standard default 10. The last bin is right-closed so
 * confidence = 1.0 lands in the top bin instead of being silently dropped.
 */
export function reliabilityDiagram(points: readonly CalibrationPoint[], bins = 10): ReliabilityBin[] {
  if (bins <= 0) throw new Error(`bins must be > 0, got ${bins}`);
  const width = 1 / bins;
  const bucket: { n: number; wins: number }[] = Array.from({ length: bins }, () => ({ n: 0, wins: 0 }));
  for (const p of points) {
    const c = Math.min(1, Math.max(0, p.confidence));
    const idx = c === 1 ? bins - 1 : Math.floor(c / width);
    bucket[idx]!.n++;
    if (p.won) bucket[idx]!.wins++;
  }
  return bucket.map((b, i) => {
    const winRate = b.n > 0 ? b.wins / b.n : null;
    const ci = b.n >= 3 ? wilsonInterval(b.wins, b.n, 0.95) : null;
    return {
      binIndex: i,
      lower: i * width,
      upper: (i + 1) * width,
      midpoint: (i + 0.5) * width,
      n: b.n,
      winRate,
      wilsonLower: ci?.lower ?? null,
      wilsonUpper: ci?.upper ?? null,
    };
  });
}

/**
 * Compact calibration verdict — the numbers dashboards need without asking every caller to walk
 * the bin list. `expectedCalibrationError` (ECC) = n-weighted mean |confidence − winRate| across
 * populated bins.
 */
export interface CalibrationSummary {
  readonly brier: number | null;
  readonly ece: number | null;
  readonly bins: readonly ReliabilityBin[];
  readonly n: number;
}

export function calibrationSummary(points: readonly CalibrationPoint[], bins = 10): CalibrationSummary {
  const brier = brierScore(points);
  const rd = reliabilityDiagram(points, bins);
  let ece: number | null = null;
  const total = points.length;
  if (total > 0) {
    let sum = 0; let counted = 0;
    for (const b of rd) {
      if (b.winRate === null) continue;
      sum += (b.n / total) * Math.abs(b.midpoint - b.winRate);
      counted++;
    }
    ece = counted > 0 ? sum : null;
  }
  return { brier, ece, bins: rd, n: total };
}
