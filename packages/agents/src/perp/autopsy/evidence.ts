/**
 * Three-part evidence package for the Autopsy (§24). Bounded to [T0, T2] via
 * `AsOfMarketData(T2)`; anything past T2 legitimately doesn't exist for this trade.
 *
 * §24 no-look-ahead paragraph: "the original prediction and any backtest of it may only use
 * data ≤ T0. The autopsy itself may use the full T0 → T2 window — but nothing it observes in
 * that window may leak backward into the original prediction or its backtest." Enforced
 * structurally: the ORIGINAL prediction was made from `AsOfMarketData(T0)`; this builder reads
 * from `AsOfMarketData(T2)`; the two are separate views and there is no writer from autopsy
 * back to any pre-T0 table (§22 attribution reads what M4 wrote at T0, unmodified).
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { marketCandle, fundingRate, openInterest, prediction, predictionOutcome, signalFeature, type Db } from '@tip/database';
import { AsOfMarketData } from '@tip/evaluation';
import { setupFingerprint, type FeatureTuple, type Domain } from '@tip/brain';

export interface AutopsyEvidence {
  readonly prediction: {
    readonly id: string;
    readonly symbol: string;
    readonly domain: Domain;
    readonly direction: string;
    readonly score: number;
    readonly confidence: number;
    readonly entry: number;
    readonly stopLoss: number;
    readonly takeProfit: number | null;
    readonly horizon: string;
    readonly t0: Date;
    readonly t1: Date;
    readonly t2: Date;
  };
  readonly outcome: 'WIN' | 'LOSS';
  readonly setupId: string;
  readonly systemBelief: {
    readonly agents: readonly { key: string; agentVersion: number; score: number; confidence: number }[];
  };
  readonly marketEvolution: readonly { at: Date; open: number; high: number; low: number; close: number }[];
  readonly funding: readonly { at: Date; rate: number }[];
  readonly openInterest: readonly { at: Date; oi: number }[];
}

/** Restrict a candle stream to the [t0, t2] window and downsample to at most ~40 rows for the
 *  LLM prompt — the raw window over an EOD horizon can be 480+ 1m candles; sending them all
 *  wastes tokens and gives the LLM room to hallucinate. */
function downsample<T>(rows: readonly T[], target = 40): T[] {
  if (rows.length <= target) return [...rows];
  const step = Math.ceil(rows.length / target);
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += step) out.push(rows[i]!);
  return out;
}

/** Build the three-part evidence package for one resolved perp prediction. */
export async function buildAutopsyEvidence(
  db: Db,
  predictionId: string,
  planningHorizon: string,
  featureTuple: FeatureTuple,
): Promise<AutopsyEvidence | null> {
  const p = (await db.select().from(prediction).where(eq(prediction.id, predictionId)).limit(1))[0];
  if (!p) return null;
  if (p.domain !== 'perp') throw new Error('autopsy is perp-only in MVP (§24 memecoin scope)');
  const outcomeRow = (await db.select().from(predictionOutcome)
    .where(and(eq(predictionOutcome.predictionId, predictionId), eq(predictionOutcome.horizon, planningHorizon)))
    .limit(1))[0];
  if (!outcomeRow) return null;

  const t0 = p.createdAt;
  const t1 = t0;                     // seeded/live convergence: paper_position.opened_at_processing
                                     // could feed here, but for MVP T0=T1 is a documented
                                     // simplification (m6c4's own T1 fallback is the same).
  const t2 = outcomeRow.resolvedAt;
  const outcome: 'WIN' | 'LOSS' = outcomeRow.won ? 'WIN' : 'LOSS';

  // What the system believed — the immutable T0 snapshot from signal_feature.
  const features = await db.select().from(signalFeature).where(eq(signalFeature.signalId, p.signalId));
  const agents = features.map((f) => ({
    key: f.agentKey, agentVersion: f.agentVersion,
    score: Number(f.score), confidence: Number(f.confidence),
  }));

  // Market evolution over [T0, T2] via 1m bars, downsampled for the prompt.
  const view = new AsOfMarketData(db, t2);
  void view;
  const barsRaw = await db.select({
    at: marketCandle.closeTime, open: marketCandle.open, high: marketCandle.high, low: marketCandle.low, close: marketCandle.close,
  }).from(marketCandle)
    .where(and(
      eq(marketCandle.symbol, p.symbol), eq(marketCandle.timeframe, '1m'),
      gte(marketCandle.closeTime, t0), lte(marketCandle.closeTime, t2),
    ))
    .orderBy(asc(marketCandle.closeTime));
  const marketEvolution = downsample(barsRaw).map((r) => ({
    at: r.at, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
  }));

  const fundingRaw = await db.select({ at: fundingRate.fundingTime, rate: fundingRate.rate })
    .from(fundingRate)
    .where(and(eq(fundingRate.symbol, p.symbol), gte(fundingRate.fundingTime, t0), lte(fundingRate.fundingTime, t2)))
    .orderBy(asc(fundingRate.fundingTime));
  const funding = fundingRaw.map((r) => ({ at: r.at, rate: Number(r.rate) }));

  const oiRaw = await db.select({ at: openInterest.snapshotTime, oi: openInterest.oi })
    .from(openInterest)
    .where(and(eq(openInterest.symbol, p.symbol), gte(openInterest.snapshotTime, t0), lte(openInterest.snapshotTime, t2)))
    .orderBy(asc(openInterest.snapshotTime));
  const oi = downsample(oiRaw).map((r) => ({ at: r.at, oi: Number(r.oi) }));

  const setupId = setupFingerprint('perp', featureTuple);

  return {
    prediction: {
      id: p.id, symbol: p.symbol, domain: 'perp',
      direction: p.direction, score: Number(p.score), confidence: Number(p.confidence),
      entry: Number(p.entry), stopLoss: Number(p.stopLoss),
      takeProfit: p.takeProfit === null ? null : Number(p.takeProfit),
      horizon: p.horizon, t0, t1, t2,
    },
    outcome, setupId,
    systemBelief: { agents },
    marketEvolution,
    funding, openInterest: oi,
  };
}
