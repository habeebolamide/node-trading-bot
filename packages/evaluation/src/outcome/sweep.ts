/**
 * Outcome sweep (§21). Find every (prediction × horizon) whose horizon has ELAPSED and lacks a
 * `prediction_outcome` row yet, resolve it, insert. On the PLANNING horizon only, feed the
 * Brain — the M5 call site both memory tables were waiting on (§41 / §16).
 *
 * ONE PREDICTION → ONE BRAIN OCCURRENCE. §41 takes a single `won` boolean; four horizons can
 * disagree. Feeding four would inflate effective-n 4× and turn every Wilson interval M5 relies
 * on into a lie. The `brain_written_at` marker (migration 0014) is the at-most-once guard even
 * under concurrent sweeps: the update is CONDITIONAL on `brain_written_at IS NULL`, so a lost
 * race stamps once and the second update touches zero rows.
 */
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  marketCandle, paperPosition, prediction, predictionOutcome, tradingAgent, type Db,
} from '@tip/database';
import type { TradingStyle } from '@tip/trading-agents';
import { recordAgentOutcome, recordSetupOutcome } from '@tip/brain';
import { benchmarkReturn } from './benchmark.js';
import { contributionsFor, featureTupleFor } from './feature-tuple.js';
import { HORIZON_MS, horizonSet, planningHorizonFor, type Horizon } from './horizons.js';
import { resolveOutcome, type ResolutionMode } from './resolve.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SweepOptions {
  /** Wall-clock now used to decide which horizons have elapsed. Injectable for tests + replay. */
  now?: Date;
  /**
   * Resolution mode. Defaults to CANDLE_1M_CONSERVATIVE (audit-2 fix): the old TICK default
   * was a footgun — TICK with no tick store falls through to `finalize(entry, …)` and records
   * EVERY outcome as `won=false, returnPct=0`. The live store has 1m candles, not ticks, so the
   * candle mode is the correct live default; pass TICK only when actual ticks are supplied.
   */
  mode?: ResolutionMode;
  /** Cap per sweep to keep long-lived processes bounded. */
  maxPredictions?: number;
  /** Called once per prediction that wrote ≥1 outcome this sweep — the scheduler publishes
   *  `prediction.resolved` from it (the §10 event that had no producer). */
  onResolved?: (predictionId: string, outcomesWritten: number) => Promise<void>;
}

export interface SweepStats {
  predictionsChecked: number;
  outcomesWritten: number;
  brainWrites: number;
  errors: number;
}

/**
 * The prediction's T1 (§21): the paper position's `openedAtProcessing`, or `createdAt` if
 * there's no position (seeded predictions, or predictions from an older run). Returns null
 * for positions that never actually opened — a PENDING_ENTRY that hasn't crossed the limit yet
 * or an EXPIRED one whose LIMIT window elapsed. Those predictions have nothing to resolve.
 */
async function t1For(db: Db, predictionId: string, createdAt: Date): Promise<Date | null> {
  const p = (await db.select({ t: paperPosition.openedAtProcessing, state: paperPosition.state })
    .from(paperPosition).where(eq(paperPosition.predictionId, predictionId)).limit(1))[0];
  if (!p) return createdAt; // no paper position — seeded / older; use signal time
  if (p.state === 'PENDING_ENTRY' || p.state === 'EXPIRED') return null;
  return p.t;
}

/** Fetch 1m bars in [from, to] — for CANDLE_1M_CONSERVATIVE resolution. */
async function barsForWindow(db: Db, symbol: string, from: Date, to: Date) {
  const rows = await db
    .select({ openTime: marketCandle.openTime, closeTime: marketCandle.closeTime,
              open: marketCandle.open, high: marketCandle.high, low: marketCandle.low, close: marketCandle.close })
    .from(marketCandle)
    .where(and(eq(marketCandle.symbol, symbol), eq(marketCandle.timeframe, '1m'),
               lte(marketCandle.closeTime, to)))
    .orderBy(asc(marketCandle.closeTime));
  return rows
    .filter((r) => r.closeTime.getTime() > from.getTime())
    .map((r) => ({ openTime: r.openTime, closeTime: r.closeTime, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
}

/**
 * Resolve every elapsed unresolved horizon for one prediction. Called from the batch sweep and
 * directly from the seeder (change 6) — same code path so seeded and live outcomes cannot drift.
 */
export async function resolvePrediction(
  db: Db,
  input: {
    predictionId: string;
    now: Date;
    mode: ResolutionMode;
    style: TradingStyle;
    /** Explicit ticks for TICK mode; ignored in CANDLE mode. */
    ticks?: readonly { at: Date; price: number }[];
  },
): Promise<number> {
  const p = (await db.select().from(prediction).where(eq(prediction.id, input.predictionId)).limit(1))[0];
  if (!p) return 0;
  const t1 = await t1For(db, p.id, p.createdAt);
  if (!t1) return 0; // LIMIT never filled — nothing to resolve, no Brain occurrence
  const horizons = horizonSet(input.style);

  // Which horizons have already been resolved?
  const done = new Set((await db.select({ h: predictionOutcome.horizon })
    .from(predictionOutcome)
    .where(eq(predictionOutcome.predictionId, p.id))).map((r) => r.h as Horizon));

  let written = 0;
  const dir = p.direction.includes('SHORT') ? 'SHORT' : 'LONG';
  const entry = Number(p.entry);
  const stop = Number(p.stopLoss);
  const tp = p.takeProfit === null ? null : Number(p.takeProfit);

  for (const h of horizons) {
    if (done.has(h)) continue;
    const horizonEnd = new Date(t1.getTime() + HORIZON_MS[h]);
    if (horizonEnd.getTime() > input.now.getTime()) continue; // not elapsed yet

    const benchmark = await benchmarkReturn(db, { domain: p.domain as 'perp' | 'memecoin', symbol: p.symbol, from: t1, to: horizonEnd }) ?? undefined;
    const bars = input.mode === 'CANDLE_1M_CONSERVATIVE' ? await barsForWindow(db, p.symbol, t1, horizonEnd) : undefined;

    const result = resolveOutcome({
      entry, stopLoss: stop, takeProfit: tp, direction: dir as 'LONG' | 'SHORT',
      t1, horizonEnd, mode: input.mode,
      ...(bars ? { bars } : {}),
      ...(input.ticks ? { ticks: input.ticks } : {}),
      ...(benchmark !== undefined ? { benchmarkReturnPct: benchmark } : {}),
    });

    // Idempotent by (predictionId, horizon) PK — a re-run inserts nothing.
    await db.insert(predictionOutcome).values({
      predictionId: p.id, horizon: h,
      resolvedAt: result.closedAt,
      returnPct: String(result.returnPct),
      benchmarkReturnPct: result.benchmarkReturnPct === null ? null : String(result.benchmarkReturnPct),
      alpha: result.alpha === null ? null : String(result.alpha),
      mfe: String(result.mfe), mae: String(result.mae),
      hitTarget: result.hitTarget, hitInvalidation: result.hitInvalidation,
      holdingPeriodSec: result.holdingPeriodSec,
      won: result.won,
      outcomeResolution: result.outcomeResolution,
    }).onConflictDoNothing();
    written++;
  }

  return written;
}

/**
 * Feed the Brain from a prediction's PLANNING-horizon outcome. At-most-once by
 * `brain_written_at`: the UPDATE is CONDITIONAL on that column being NULL, so a concurrent
 * sweep sees zero rows updated and skips.
 */
async function feedBrainOnce(db: Db, predictionId: string, style: TradingStyle): Promise<boolean> {
  const p = (await db.select().from(prediction).where(eq(prediction.id, predictionId)).limit(1))[0];
  if (!p || p.brainWrittenAt !== null) return false;
  // m7-shadow-predictions: shadows do NOT feed the Brain. A Judge that consistently flips right
  // would otherwise bake its own preference back into Historical Edge — the back channel §18's
  // narrow gate is designed to prevent. §33 rule 13 is about calculation; this is the same
  // idea for memory. Shadows are read directly from prediction_outcome in shadow reporting
  // (m7-shadow-predictions compareShadowVsReal/compareShadowVsBaseline).
  if (p.isShadow) return false;

  const planningH = planningHorizonFor(style);
  const outcome = (await db.select().from(predictionOutcome)
    .where(and(eq(predictionOutcome.predictionId, p.id), eq(predictionOutcome.horizon, planningH))).limit(1))[0];
  if (!outcome) return false; // planning horizon hasn't been resolved yet

  const domain = p.domain as 'perp' | 'memecoin';
  const features = await featureTupleFor(db, p.signalId, domain);
  const contributions = await contributionsFor(db, p.signalId);
  const closedAt = outcome.resolvedAt;
  const returnPct = Number(outcome.returnPct);

  // Stamp `brain_written_at` first, CONDITIONAL — this is the at-most-once guard. If someone
  // else already stamped, we skip the writes entirely. The Brain writes are themselves
  // idempotent (M5 unique keys), but this saves double work AND makes the invariant visible
  // in the DB rather than trusted from behavioural properties.
  const stamped = await db.update(prediction)
    .set({ brainWrittenAt: new Date() })
    .where(and(eq(prediction.id, p.id), isNull(prediction.brainWrittenAt)))
    .returning({ id: prediction.id });
  if (stamped.length === 0) return false;

  // realizedDirection = sign(close(T1+h) − entry). Signed return has direction baked in —
  // a positive signed return means the direction was right. Convert back to +1/-1 for §16.
  const realizedDirection: 1 | -1 = returnPct > 0 ? (p.direction.includes('SHORT') ? -1 : 1)
                                     : returnPct < 0 ? (p.direction.includes('SHORT') ? 1 : -1)
                                     : 1; // tie: break toward LONG (documented in design)

  await recordSetupOutcome(db, {
    predictionId: p.id, domain, features, closedAt,
    won: outcome.won, returnPct,
  });
  await recordAgentOutcome(db,
    { predictionId: p.id, domain, closedAt, realizedDirection },
    contributions,
  );
  return true;
}

/** Batch sweep — every unresolved elapsed horizon across every prediction, then feed the Brain. */
export async function outcomeSweep(db: Db, opts: SweepOptions = {}): Promise<SweepStats> {
  const now = opts.now ?? new Date();
  const mode = opts.mode ?? 'CANDLE_1M_CONSERVATIVE';
  const cap = opts.maxPredictions ?? 500;
  const stats: SweepStats = { predictionsChecked: 0, outcomesWritten: 0, brainWrites: 0, errors: 0 };

  // Preselect predictions whose creation is > 1w ago (max horizon) OR that already have some
  // outcomes but not brain_written yet. The 1w default bounds the scan cheaply; tighten later.
  const cutoff = new Date(now.getTime() - HORIZON_MS['1w']);
  const rows = await db.select({
    id: prediction.id, tradingAgentId: prediction.tradingAgentId,
    createdAt: prediction.createdAt, brainWrittenAt: prediction.brainWrittenAt,
  })
    .from(prediction)
    .where(lte(prediction.createdAt, new Date(now.getTime())))
    .orderBy(desc(prediction.createdAt))
    .limit(cap);

  // Resolve style per tradingAgent (cached).
  const styleCache = new Map<string, TradingStyle>();
  const uniqueAgents = [...new Set(rows.map((r) => r.tradingAgentId))];
  if (uniqueAgents.length > 0) {
    const agents = await db.select({ id: tradingAgent.id, style: tradingAgent.tradingStyle })
      .from(tradingAgent).where(inArray(tradingAgent.id, uniqueAgents));
    for (const a of agents) styleCache.set(a.id, a.style as TradingStyle);
  }

  for (const r of rows) {
    stats.predictionsChecked++;
    const style = styleCache.get(r.tradingAgentId);
    if (!style) continue; // agent gone / mismatch — skip rather than crash the whole sweep
    try {
      const written = await resolvePrediction(db, { predictionId: r.id, now, mode, style });
      stats.outcomesWritten += written;
      if (written > 0 && opts.onResolved) await opts.onResolved(r.id, written);
      if (!r.brainWrittenAt && (await feedBrainOnce(db, r.id, style))) stats.brainWrites++;
    } catch {
      stats.errors++;
      void cutoff;
    }
  }

  return stats;
}
