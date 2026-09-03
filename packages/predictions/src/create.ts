/**
 * `createPrediction` — the sole write path (§19, rule 10, §36).
 *
 * One transaction, all-or-nothing:
 *   1. Move the signal ACTIVE → CONSUMED using a CONDITIONAL UPDATE keyed on state='ACTIVE'.
 *      A stale request or a concurrent second attempt updates zero rows, and we bail out
 *      cleanly. The `unique(signal_id)` on `prediction` is the DB-level guard against a
 *      lost-update race even if two callers pass the ACTIVE check simultaneously.
 *   2. Insert the prediction row.
 * A failure at (2) rolls back the CONSUMED transition — either both, or neither.
 *
 * The prediction row is INSERT-only per rule 10; the Postgres trigger appended to migration
 * 0012 blocks UPDATE and DELETE. The API surface here mirrors that: no `updatePrediction`,
 * no `deletePrediction`. If one appears, it's a schema-modelling mistake (rule 10 — "if a
 * schema field seems to want UPDATE, you're modelling it wrong").
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { prediction, signal, type Db } from '@tip/database';
import type { PredictionRow, CreatePredictionInput, CreatePredictionOutcome } from './types.js';

function toRow(r: typeof prediction.$inferSelect): PredictionRow {
  return {
    id: r.id, tradingAgentId: r.tradingAgentId, signalId: r.signalId,
    domain: r.domain as PredictionRow['domain'], symbol: r.symbol, direction: r.direction,
    score: Number(r.score), confidence: Number(r.confidence), horizon: r.horizon as PredictionRow['horizon'],
    entry: Number(r.entry), stopLoss: Number(r.stopLoss),
    takeProfit: r.takeProfit === null ? null : Number(r.takeProfit),
    positionSize: Number(r.positionSize), notional: Number(r.notional),
    leverage: r.leverage === null ? null : Number(r.leverage),
    requiredMargin: r.requiredMargin === null ? null : Number(r.requiredMargin),
    riskReward: Number(r.riskReward), thesis: r.thesis, features: r.features,
    invalidators: r.invalidators, configVersion: r.configVersion,
    isShadow: r.isShadow, shadowOf: r.shadowOf, createdAt: r.createdAt,
  };
}

export async function createPrediction(db: Db, input: CreatePredictionInput): Promise<CreatePredictionOutcome> {
  return db.transaction(async (tx) => {
    // Duplicate-signal guard — if a prediction already exists, do not touch the signal state.
    const existing = await tx
      .select({ id: prediction.id })
      .from(prediction)
      .where(eq(prediction.signalId, input.signalId))
      .limit(1);
    if (existing.length > 0) {
      return { created: false as const, reason: 'DUPLICATE_SIGNAL' as const, existingPredictionId: existing[0]!.id };
    }

    // Conditional ACTIVE → CONSUMED. Zero rows updated = signal is not ACTIVE (or gone).
    const consumed = await tx
      .update(signal)
      .set({ state: 'CONSUMED' })
      .where(and(eq(signal.id, input.signalId), eq(signal.state, 'ACTIVE')))
      .returning({ id: signal.id });

    if (consumed.length === 0) {
      const cur = await tx.select({ state: signal.state }).from(signal).where(eq(signal.id, input.signalId)).limit(1);
      return { created: false as const, reason: 'SIGNAL_NOT_ACTIVE' as const, currentState: cur[0]?.state ?? null };
    }

    const id = randomUUID();
    const { setup } = input;
    const inserted = await tx
      .insert(prediction)
      .values({
        id,
        tradingAgentId: input.tradingAgentId,
        signalId: input.signalId,
        domain: setup.domain,
        symbol: setup.symbol as string,
        direction: input.direction,
        score: String(input.signalScore),
        confidence: String(input.confidence),
        horizon: setup.horizon,
        entry: String(setup.entry),
        stopLoss: String(setup.stopLoss),
        takeProfit: setup.takeProfit === null ? null : String(setup.takeProfit),
        positionSize: String(setup.positionSize),
        notional: String(setup.notional),
        leverage: setup.leverage === null ? null : String(setup.leverage),
        requiredMargin: setup.requiredMargin === null ? null : String(setup.requiredMargin),
        riskReward: String(setup.riskReward),
        thesis: input.thesis ?? null,
        features: input.features,
        invalidators: input.invalidators ?? null,
        configVersion: setup.configVersion,
        isShadow: input.isShadow ?? false,
        shadowOf: input.shadowOf ?? null,
        // §25 replay: the seeder walks historical bars, so `createdAt` must be the BAR's
        // close time (T0), not `now()`. Without the override, `defaultNow()` stamps today,
        // t1 anchors on today, and the outcome resolver looks for 1m candles past today —
        // finds none, and every seeded outcome finalizes as `won=false, returnPct=0`.
        // Optional so live callers keep the default-now behaviour.
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      })
      .returning();

    return { created: true as const, prediction: toRow(inserted[0]!) };
  });
}
