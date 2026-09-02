/**
 * Positions — open, ladder-fill, closeRemaining. THE single close primitive is
 * `closeRemaining()`; every "full close" (STOP LOSS / WALLET EXIT / TAKE PROFIT / HORIZON) routes
 * through it, so no call site sizes from the ORIGINAL notional. Part II §10 demands this be
 * explicit "to prevent negative-size fills" — a property test in exit.test.ts asserts a mixed
 * ladder + close sequence can never take remaining_size below zero.
 *
 * Ladder fills go through `applyLadderRung()` which writes a fractional fill row and updates
 * `remaining_size` and optionally the stop (via `applyPostTakeAction` in exit.ts).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { paperPosition, paperPositionFill, type Db } from '@tip/database';
import type { Domain } from '@tip/trading-agents';
import { applyPnl } from './portfolio.js';
import { applyPostTakeAction } from './exit.js';
import type { LadderRungConfig } from './types.js';

export interface OpenPositionInput {
  portfolioId: string;
  predictionId: string;
  symbol: string;
  domain: Domain;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  size: number;
  currentStop: number;
  takeProfit: number | null;
  ladder: readonly LadderRungConfig[] | null;
  /** §20 "record both clocks". */
  openedAtEvent: Date;
  openedAtProcessing: Date;
}

export interface PositionRow {
  id: string;
  portfolioId: string;
  predictionId: string;
  symbol: string;
  domain: Domain;
  direction: 'LONG' | 'SHORT';
  state: 'OPEN' | 'CLOSED';
  entryPrice: number;
  size: number;
  remainingSize: number;
  currentStop: number;
  takeProfit: number | null;
  firedRungs: number[];
  openedAtEvent: Date;
  openedAtProcessing: Date;
  closedAt: Date | null;
  closeReason: string | null;
  realizedPnl: number;
  mfe: number;
  mae: number;
}

function toRow(r: typeof paperPosition.$inferSelect): PositionRow {
  const ls = (r.ladderState as { firedRungs?: number[] } | null) ?? {};
  return {
    id: r.id, portfolioId: r.portfolioId, predictionId: r.predictionId,
    symbol: r.symbol, domain: r.domain as Domain, direction: r.direction as 'LONG' | 'SHORT',
    state: r.state as 'OPEN' | 'CLOSED',
    entryPrice: Number(r.entryPrice), size: Number(r.size), remainingSize: Number(r.remainingSize),
    currentStop: Number(r.currentStop),
    takeProfit: r.takeProfit === null ? null : Number(r.takeProfit),
    firedRungs: ls.firedRungs ?? [],
    openedAtEvent: r.openedAtEvent, openedAtProcessing: r.openedAtProcessing,
    closedAt: r.closedAt, closeReason: r.closeReason,
    realizedPnl: Number(r.realizedPnl), mfe: Number(r.mfe), mae: Number(r.mae),
  };
}

/**
 * Open a position. `unique(prediction_id)` on paper_position enforces "one prediction → at most
 * one position" (rule 12 — DB-level, not application check). A second open on the same
 * prediction throws; the caller decides whether that's a retry (idempotent handling) or a bug.
 */
export async function openPosition(db: Db, i: OpenPositionInput): Promise<PositionRow> {
  return db.transaction(async (tx) => {
    const id = randomUUID();
    await tx.insert(paperPosition).values({
      id, portfolioId: i.portfolioId, predictionId: i.predictionId,
      symbol: i.symbol, domain: i.domain, direction: i.direction,
      state: 'OPEN',
      entryPrice: String(i.entryPrice), size: String(i.size), remainingSize: String(i.size),
      currentStop: String(i.currentStop),
      takeProfit: i.takeProfit === null ? null : String(i.takeProfit),
      ladderState: { firedRungs: [] },
      openedAtEvent: i.openedAtEvent, openedAtProcessing: i.openedAtProcessing,
    });
    await tx.insert(paperPositionFill).values({
      id: randomUUID(), positionId: id,
      fillAtEvent: i.openedAtEvent, fillAtProcessing: i.openedAtProcessing,
      sizeFraction: '1', price: String(i.entryPrice), reason: 'ENTRY', isFinal: false,
    });
    const row = (await tx.select().from(paperPosition).where(eq(paperPosition.id, id)).limit(1))[0]!;
    return toRow(row);
  });
}

export interface FillClocks { fillAtEvent: Date; fillAtProcessing: Date }

/**
 * Ladder-rung fill (Part II §10). Sells `rung.sellFraction` of the ORIGINAL size at `rungPrice`,
 * updates `remaining_size`, records the fired rung, optionally moves the stop per
 * `postTakeAction`. Idempotent by (position, rung): the fired-rungs list prevents a re-fire.
 */
export async function applyLadderRung(db: Db, input: {
  positionId: string;
  rungIndex: number;
  rungPrice: number;
  rung: LadderRungConfig;
  clocks: FillClocks;
}): Promise<PositionRow> {
  return db.transaction(async (tx) => {
    const r = (await tx.select().from(paperPosition).where(eq(paperPosition.id, input.positionId)).limit(1))[0];
    if (!r) throw new Error(`position ${input.positionId} not found`);
    const ls = (r.ladderState as { firedRungs?: number[] } | null) ?? {};
    const fired = ls.firedRungs ?? [];
    if (fired.includes(input.rungIndex)) return toRow(r); // already fired — no-op
    if (r.state !== 'OPEN') return toRow(r);

    const size = Number(r.size);
    const remaining = Number(r.remainingSize);
    // sellFraction is of the ORIGINAL notional; clamp so cumulative can never exceed remaining.
    const sellSize = Math.min(remaining, size * input.rung.sellFraction);
    if (sellSize <= 0) return toRow(r);

    const entry = Number(r.entryPrice);
    const pnl = (input.rungPrice - entry) * sellSize; // LONG-only (memecoin ladders are long-only)
    const newRemaining = remaining - sellSize;
    const newStop = applyPostTakeAction({
      entryPrice: entry, currentStop: Number(r.currentStop), currentPrice: input.rungPrice,
      action: input.rung.postTakeAction ?? null,
    });

    await tx.update(paperPosition).set({
      remainingSize: String(newRemaining),
      currentStop: String(newStop),
      ladderState: { firedRungs: [...fired, input.rungIndex] },
      realizedPnl: String(Number(r.realizedPnl) + pnl),
    }).where(eq(paperPosition.id, input.positionId));

    await tx.insert(paperPositionFill).values({
      id: randomUUID(), positionId: input.positionId,
      fillAtEvent: input.clocks.fillAtEvent, fillAtProcessing: input.clocks.fillAtProcessing,
      sizeFraction: String(sellSize / size), price: String(input.rungPrice),
      reason: `LADDER_RUNG_${input.rungIndex}`, isFinal: false,
    });
    // Portfolio cash accrues the realized delta right away; unrealized on the leftover is a live view.
    await applyPnl(tx as unknown as Db, r.portfolioId, pnl);

    const updated = (await tx.select().from(paperPosition).where(eq(paperPosition.id, input.positionId)).limit(1))[0]!;
    return toRow(updated);
  });
}

/**
 * THE single full-close primitive. Closes 100% of `remaining_size`, not of the original entry —
 * Part II §10's rule that "full close" is 100% of what is CURRENTLY held. Anywhere else in the
 * codebase computing a size from `size` instead of `remaining_size` is a bug.
 */
export async function closeRemaining(db: Db, input: {
  positionId: string;
  price: number;
  reason: 'STOP_LOSS' | 'WALLET_EXIT' | 'TAKE_PROFIT' | 'HORIZON_EXPIRY';
  clocks: FillClocks;
}): Promise<PositionRow> {
  return db.transaction(async (tx) => {
    const r = (await tx.select().from(paperPosition).where(eq(paperPosition.id, input.positionId)).limit(1))[0];
    if (!r) throw new Error(`position ${input.positionId} not found`);
    if (r.state !== 'OPEN') return toRow(r); // idempotent — already closed

    const entry = Number(r.entryPrice);
    const size = Number(r.size);
    const remaining = Number(r.remainingSize);
    if (remaining <= 0) {
      // The ladder took everything; mark closed but book no additional P&L.
      await tx.update(paperPosition).set({
        state: 'CLOSED', closedAt: input.clocks.fillAtProcessing, closeReason: input.reason,
      }).where(eq(paperPosition.id, input.positionId));
      const updated = (await tx.select().from(paperPosition).where(eq(paperPosition.id, input.positionId)).limit(1))[0]!;
      return toRow(updated);
    }

    const directionSign = r.direction === 'LONG' ? 1 : -1;
    const pnl = (input.price - entry) * remaining * directionSign;

    await tx.update(paperPosition).set({
      state: 'CLOSED',
      remainingSize: '0',
      realizedPnl: String(Number(r.realizedPnl) + pnl),
      closedAt: input.clocks.fillAtProcessing,
      closeReason: input.reason,
    }).where(eq(paperPosition.id, input.positionId));

    await tx.insert(paperPositionFill).values({
      id: randomUUID(), positionId: input.positionId,
      fillAtEvent: input.clocks.fillAtEvent, fillAtProcessing: input.clocks.fillAtProcessing,
      sizeFraction: String(remaining / size), price: String(input.price),
      reason: input.reason, isFinal: true,
    });
    await applyPnl(tx as unknown as Db, r.portfolioId, pnl);

    const updated = (await tx.select().from(paperPosition).where(eq(paperPosition.id, input.positionId)).limit(1))[0]!;
    return toRow(updated);
  });
}

/**
 * Update MFE/MAE from an observed mid-tick. Called by the tick monitor between exit checks.
 * Bounded to the trade's direction: MFE is favourable movement, MAE is adverse.
 */
export async function updateExcursion(db: Db, positionId: string, price: number): Promise<void> {
  const r = (await db.select().from(paperPosition).where(eq(paperPosition.id, positionId)).limit(1))[0];
  if (!r || r.state !== 'OPEN') return;
  const entry = Number(r.entryPrice);
  const sign = r.direction === 'LONG' ? 1 : -1;
  const excursion = (price - entry) * sign;
  const mfe = Math.max(Number(r.mfe), excursion);
  const mae = Math.min(Number(r.mae), excursion);
  await db.update(paperPosition).set({ mfe: String(mfe), mae: String(mae) })
    .where(and(eq(paperPosition.id, positionId), eq(paperPosition.state, 'OPEN')));
}

/** Count open positions for a portfolio — enforces `maxConcurrentPositions`. */
export async function openPositionCount(db: Db, portfolioId: string): Promise<number> {
  const r = await db.select({ n: sql<number>`count(*)::int` })
    .from(paperPosition)
    .where(and(eq(paperPosition.portfolioId, portfolioId), eq(paperPosition.state, 'OPEN')));
  return Number(r[0]!.n);
}
