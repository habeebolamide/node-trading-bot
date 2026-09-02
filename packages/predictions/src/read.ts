/**
 * Read helpers for Prediction. Read-only by design — the module has no update/delete surface,
 * mirroring the DB-level trigger (rule 10). If a caller wants to "correct" a prediction they
 * are modelling something wrong (§19/rule 10 says so verbatim).
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { prediction, type Db } from '@tip/database';
import type { Domain } from '@tip/trading-agents';
import type { PredictionRow } from './types.js';

export type { PredictionRow };

function toRow(r: typeof prediction.$inferSelect): PredictionRow {
  return {
    id: r.id, tradingAgentId: r.tradingAgentId, signalId: r.signalId,
    domain: r.domain as Domain, symbol: r.symbol, direction: r.direction,
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

export async function getPrediction(db: Db, id: string): Promise<PredictionRow | null> {
  const rows = await db.select().from(prediction).where(eq(prediction.id, id)).limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export interface ListPredictionsFilter {
  tradingAgentId?: string;
  domain?: Domain;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function listPredictions(db: Db, f: ListPredictionsFilter): Promise<PredictionRow[]> {
  const conds = [] as ReturnType<typeof eq>[];
  if (f.tradingAgentId) conds.push(eq(prediction.tradingAgentId, f.tradingAgentId));
  if (f.domain) conds.push(eq(prediction.domain, f.domain));
  if (f.from) conds.push(gte(prediction.createdAt, f.from));
  if (f.to) conds.push(lte(prediction.createdAt, f.to));
  const q = db.select().from(prediction).orderBy(desc(prediction.createdAt)).limit(f.limit ?? 100);
  const rows = await (conds.length ? q.where(and(...conds)) : q);
  return rows.map(toRow);
}
