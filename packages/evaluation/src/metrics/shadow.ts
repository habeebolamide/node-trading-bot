/**
 * Shadow evaluation (§23). Answers "does the Judge add value" via two comparisons:
 *   - FLIP: real (Judge dir) group vs. shadow (deterministic dir) group.
 *   - STAND_ASIDE: shadow (deterministic dir, no real trade) vs. the deterministic baseline
 *     across AGREE/DEFER predictions in the same domain + configVersion.
 *
 * Reads from `prediction_outcome` joined to `judge_decision` for grouping — NOT from the Brain
 * (m7-shadow-predictions design resolution: shadows are excluded from Brain writes so the
 * Judge cannot bake its preference into future signal scores).
 */
import { and, eq, inArray, lte } from 'drizzle-orm';
import { judgeDecision, prediction, predictionOutcome, type Db } from '@tip/database';
import { wilsonInterval } from '@tip/brain';
import type { Domain } from '@tip/trading-agents';

export interface ShadowGroupStats {
  readonly n: number;
  readonly wins: number;
  readonly winRate: number | null;
  readonly wilsonLower: number | null;
  readonly wilsonUpper: number | null;
  readonly medianReturn: number | null;
  readonly meanReturn: number | null;
  readonly maxDrawdown: number | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function statsFor(rows: readonly { won: boolean; returnPct: string }[]): ShadowGroupStats {
  const n = rows.length;
  if (n === 0) return { n: 0, wins: 0, winRate: null, wilsonLower: null, wilsonUpper: null, medianReturn: null, meanReturn: null, maxDrawdown: null };
  const returns = rows.map((r) => Number(r.returnPct));
  const wins = rows.filter((r) => r.won).length;
  const ci = n >= 3 ? wilsonInterval(wins, n, 0.95) : null;
  // Compounded drawdown of an even-notional replay through the rows in whatever order they came in.
  let equity = 1; let peak = 1; let maxDd = 0;
  for (const r of returns) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    n, wins,
    winRate: wins / n,
    wilsonLower: ci?.lower ?? null, wilsonUpper: ci?.upper ?? null,
    medianReturn: median(returns),
    meanReturn: returns.reduce((a, b) => a + b, 0) / n,
    maxDrawdown: maxDd,
  };
}

async function outcomesFor(db: Db, predictionIds: readonly string[], horizon: string) {
  const ids = [...predictionIds];
  if (predictionIds.length === 0) return [] as { won: boolean; returnPct: string }[];
  void 0;
  return db.select({ won: predictionOutcome.won, returnPct: predictionOutcome.returnPct })
    .from(predictionOutcome)
    .where(and(inArray(predictionOutcome.predictionId, ids), eq(predictionOutcome.horizon, horizon)));
}

export interface CompareShadowVsRealResult {
  readonly flipRealGroup: ShadowGroupStats;
  readonly flipShadowGroup: ShadowGroupStats;
}

/**
 * FLIP comparison — for every judge_decision with judgeAction='FLIP', collect the REAL
 * prediction (isShadow=false, sharing signal_id) and the SHADOW prediction (isShadow=true,
 * shadow_of=real.id, sharing signal_id). Compare their outcomes at the given horizon.
 */
export async function compareShadowVsReal(
  db: Db,
  input: { configVersion: number; horizon: string; asOf: Date },
): Promise<CompareShadowVsRealResult> {
  const flips = await db.select({ signalId: judgeDecision.signalId })
    .from(judgeDecision)
    .where(and(
      eq(judgeDecision.judgeAction, 'FLIP'),
      eq(judgeDecision.configVersion, input.configVersion),
    ));
  const signalIds = flips.map((r) => r.signalId);
  if (signalIds.length === 0) {
    return { flipRealGroup: statsFor([]), flipShadowGroup: statsFor([]) };
  }
  const preds = await db.select({ id: prediction.id, signalId: prediction.signalId, isShadow: prediction.isShadow })
    .from(prediction)
    .where(and(inArray(prediction.signalId, signalIds), lte(prediction.createdAt, input.asOf)));
  const realIds = preds.filter((p) => !p.isShadow).map((p) => p.id);
  const shadowIds = preds.filter((p) => p.isShadow).map((p) => p.id);
  return {
    flipRealGroup: statsFor(await outcomesFor(db, realIds, input.horizon)),
    flipShadowGroup: statsFor(await outcomesFor(db, shadowIds, input.horizon)),
  };
}

export interface CompareShadowVsBaselineResult {
  readonly standAsideShadowGroup: ShadowGroupStats;
  readonly baseline: ShadowGroupStats;
}

/**
 * STAND_ASIDE comparison — the SHADOW that ran because a real trade was prevented, vs. the
 * "baseline" of all AGREE/DEFER predictions in the same domain + configVersion. Answers §23's
 * "if the shadow group doesn't perform meaningfully worse than the domain's baseline, STAND
 * ASIDE isn't adding value either."
 */
export async function compareShadowVsBaseline(
  db: Db,
  input: { domain: Domain; configVersion: number; horizon: string; asOf: Date },
): Promise<CompareShadowVsBaselineResult> {
  // STAND_ASIDE shadows.
  const stands = await db.select({ signalId: judgeDecision.signalId })
    .from(judgeDecision)
    .where(and(
      eq(judgeDecision.judgeAction, 'STAND_ASIDE'),
      eq(judgeDecision.configVersion, input.configVersion),
    ));
  const shadowSignalIds = stands.map((r) => r.signalId);
  const shadowPredIds = shadowSignalIds.length === 0 ? [] :
    (await db.select({ id: prediction.id }).from(prediction)
      .where(and(inArray(prediction.signalId, shadowSignalIds), eq(prediction.isShadow, true), lte(prediction.createdAt, input.asOf)))
    ).map((p) => p.id);

  // Baseline: every REAL prediction NOT associated with a FLIP or STAND_ASIDE decision. That is
  // AGREE + DEFER + judge-absent — proxy by `isShadow=false` and signalId not in the FLIP set.
  const flipStandSignalIds = new Set([
    ...shadowSignalIds,
    ...(await db.select({ signalId: judgeDecision.signalId }).from(judgeDecision)
      .where(and(eq(judgeDecision.judgeAction, 'FLIP'), eq(judgeDecision.configVersion, input.configVersion)))
    ).map((r) => r.signalId),
  ]);
  const baselineReal = await db.select({ id: prediction.id, signalId: prediction.signalId })
    .from(prediction)
    .where(and(
      eq(prediction.domain, input.domain),
      eq(prediction.configVersion, input.configVersion),
      eq(prediction.isShadow, false),
      lte(prediction.createdAt, input.asOf),
    ));
  const baselineIds = baselineReal.filter((p) => !flipStandSignalIds.has(p.signalId)).map((p) => p.id);

  return {
    standAsideShadowGroup: statsFor(await outcomesFor(db, shadowPredIds, input.horizon)),
    baseline: statsFor(await outcomesFor(db, baselineIds, input.horizon)),
  };
}
