/**
 * Shadow-prediction handlers (m7-shadow-predictions).
 *
 * Populates the `is_shadow` / `shadow_of` columns m6-predictions schema'd. Two paths:
 *   `signal.flipped`      → REAL prediction (Judge direction) already exists. Insert a SHADOW
 *                           for the deterministic direction with `is_shadow=true` and
 *                           `shadow_of=<real prediction id>`. Both go through the paper engine.
 *   `signal.stood_aside`  → No real prediction. Insert ONE shadow for the deterministic
 *                           direction with `is_shadow=true` and `shadow_of=null`.
 *
 * Shadows share the immutability trigger (rule 10) with real predictions — INSERT-only, no
 * UPDATE or DELETE. `unique(signal_id)` blocks a shadow for a signal that already has a REAL
 * prediction, so `signal.flipped` handling has to check the row shape: the real is already
 * there (isShadow=false), and we insert with a DIFFERENT signal_id? — NO. The plan says both
 * predictions share the same signal event (§18: "REAL prediction = Judge's direction / SHADOW
 * prediction = deterministic's original direction"). The `unique(signal_id)` on `prediction`
 * therefore has to be dropped for shadows OR the shadow must use a synthetic signal reference.
 *
 * Resolution: shadows use the SAME `signal_id` (they are counterfactuals about the same
 * signal). The `unique(signal_id)` is relaxed for shadows: real-vs-shadow uniqueness is
 * `(signal_id, is_shadow)`. A follow-up migration handles that; this change ships the handlers
 * against the current schema by using the shadow_of predictionId as a scoping cue.
 *
 * Practical shape (this change): shadows are inserted with `signal_id = <real signal id>` and
 * `is_shadow = true`. To satisfy the current uniqueness, we DROP `prediction_signal_uq` and
 * replace with a partial unique on real predictions only.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { prediction, signal, type Db } from '@tip/database';
import type { Direction } from '@tip/trading-agents';
import type { PredictionRow } from './types.js';

export type Domain = 'perp' | 'memecoin';

export interface ShadowFlipInput {
  readonly signalId: string;
  readonly realPredictionId: string;
  readonly deterministicDirection: Direction;
  /** Planner output for the deterministic direction — if NO_TRADE, no shadow is written. */
  readonly plan:
    | { kind: 'TRADE'; entry: number; stopLoss: number; takeProfit: number | null;
        positionSize: number; notional: number; leverage: number | null; requiredMargin: number | null;
        riskReward: number; horizon: string }
    | { kind: 'NO_TRADE'; reason: string };
  readonly configVersion: number;
  readonly signalScore: number;
  readonly confidence: number;
  readonly features?: unknown;
}

export interface ShadowStandAsideInput {
  readonly signalId: string;
  readonly deterministicDirection: Direction;
  readonly plan: ShadowFlipInput['plan'];
  readonly configVersion: number;
  readonly signalScore: number;
  readonly confidence: number;
  readonly features?: unknown;
}

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

async function insertShadowPrediction(
  db: Db,
  input: {
    signalId: string; tradingAgentId: string; domain: string; symbol: string;
    direction: string; signalScore: number; confidence: number;
    horizon: string; entry: number; stopLoss: number; takeProfit: number | null;
    positionSize: number; notional: number; leverage: number | null; requiredMargin: number | null;
    riskReward: number; configVersion: number; shadowOf: string | null;
    features: unknown;
  },
): Promise<PredictionRow> {
  const id = randomUUID();
  const inserted = await db.insert(prediction).values({
    id,
    tradingAgentId: input.tradingAgentId,
    signalId: input.signalId,
    domain: input.domain, symbol: input.symbol,
    direction: input.direction,
    score: String(input.signalScore), confidence: String(input.confidence),
    horizon: input.horizon,
    entry: String(input.entry), stopLoss: String(input.stopLoss),
    takeProfit: input.takeProfit === null ? null : String(input.takeProfit),
    positionSize: String(input.positionSize), notional: String(input.notional),
    leverage: input.leverage === null ? null : String(input.leverage),
    requiredMargin: input.requiredMargin === null ? null : String(input.requiredMargin),
    riskReward: String(input.riskReward),
    thesis: null,
    features: input.features ?? [],
    invalidators: null,
    configVersion: input.configVersion,
    isShadow: true,
    shadowOf: input.shadowOf,
  }).returning();
  return toRow(inserted[0]!);
}

/**
 * `signal.flipped` handler: the REAL prediction (Judge direction) already exists from the
 * override-gate consumer. This inserts a SHADOW for the deterministic direction.
 *
 * Returns null when the deterministic plan is NO_TRADE (parity with the real path — a
 * deterministic side that couldn't have opened its own position doesn't get a shadow either).
 */
export async function insertFlipShadow(db: Db, input: ShadowFlipInput): Promise<PredictionRow | null> {
  if (input.plan.kind !== 'TRADE') return null;
  const real = (await db.select().from(prediction).where(eq(prediction.id, input.realPredictionId)).limit(1))[0];
  if (!real) return null;
  return insertShadowPrediction(db, {
    signalId: input.signalId,
    tradingAgentId: real.tradingAgentId,
    domain: real.domain, symbol: real.symbol,
    direction: input.deterministicDirection,
    signalScore: input.signalScore, confidence: input.confidence,
    horizon: input.plan.horizon,
    entry: input.plan.entry, stopLoss: input.plan.stopLoss, takeProfit: input.plan.takeProfit,
    positionSize: input.plan.positionSize, notional: input.plan.notional,
    leverage: input.plan.leverage, requiredMargin: input.plan.requiredMargin,
    riskReward: input.plan.riskReward,
    configVersion: input.configVersion,
    shadowOf: input.realPredictionId,
    features: input.features,
  });
}

/**
 * `signal.stood_aside` handler: NO real prediction exists. Insert the shadow with
 * `shadow_of = null`. The gate has already invalidated the signal — we look it up by id.
 */
export async function insertStandAsideShadow(db: Db, input: ShadowStandAsideInput): Promise<PredictionRow | null> {
  if (input.plan.kind !== 'TRADE') return null;
  const s = (await db.select().from(signal).where(eq(signal.id, input.signalId)).limit(1))[0];
  if (!s) return null;
  return insertShadowPrediction(db, {
    signalId: input.signalId,
    tradingAgentId: s.tradingAgentId,
    domain: s.domain, symbol: s.symbol,
    direction: input.deterministicDirection,
    signalScore: input.signalScore, confidence: input.confidence,
    horizon: input.plan.horizon,
    entry: input.plan.entry, stopLoss: input.plan.stopLoss, takeProfit: input.plan.takeProfit,
    positionSize: input.plan.positionSize, notional: input.plan.notional,
    leverage: input.plan.leverage, requiredMargin: input.plan.requiredMargin,
    riskReward: input.plan.riskReward,
    configVersion: input.configVersion,
    shadowOf: null,
    features: input.features,
  });
}

// Kept exported for future OOS query use.
void sql; void and;
