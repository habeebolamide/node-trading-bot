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
import { and, eq, inArray, sql } from 'drizzle-orm';
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
  /** m7-shadow-predictions: true for §18 shadow paper positions (counterfactuals). */
  isShadow?: boolean;
}

export interface PositionRow {
  id: string;
  portfolioId: string;
  predictionId: string;
  symbol: string;
  domain: Domain;
  direction: 'LONG' | 'SHORT';
  state: 'OPEN' | 'CLOSED' | 'PENDING_ENTRY' | 'EXPIRED';
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
  isShadow: boolean;
}

function toRow(r: typeof paperPosition.$inferSelect): PositionRow {
  const ls = (r.ladderState as { firedRungs?: number[] } | null) ?? {};
  return {
    id: r.id, portfolioId: r.portfolioId, predictionId: r.predictionId,
    symbol: r.symbol, domain: r.domain as Domain, direction: r.direction as 'LONG' | 'SHORT',
    state: r.state as PositionRow['state'],
    entryPrice: Number(r.entryPrice), size: Number(r.size), remainingSize: Number(r.remainingSize),
    currentStop: Number(r.currentStop),
    takeProfit: r.takeProfit === null ? null : Number(r.takeProfit),
    firedRungs: ls.firedRungs ?? [],
    openedAtEvent: r.openedAtEvent, openedAtProcessing: r.openedAtProcessing,
    closedAt: r.closedAt, closeReason: r.closeReason,
    realizedPnl: Number(r.realizedPnl), mfe: Number(r.mfe), mae: Number(r.mae),
    isShadow: r.isShadow,
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
      isShadow: i.isShadow ?? false,
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

/**
 * Count open REAL positions for a portfolio — enforces `maxConcurrentPositions`. Shadows are
 * excluded by construction (m7-shadow-predictions): they are measurement rows, not live-money-
 * equivalent exposure, so the cap they enforce is about the latter. A FLIP that opens
 * real+shadow does not blow through a 1-position cap.
 */
export async function openPositionCount(db: Db, portfolioId: string): Promise<number> {
  const r = await db.select({ n: sql<number>`count(*)::int` })
    .from(paperPosition)
    .where(and(
      eq(paperPosition.portfolioId, portfolioId),
      inArray(paperPosition.state, ['OPEN', 'PENDING_ENTRY']),
      eq(paperPosition.isShadow, false),
    ));
  return Number(r[0]!.n);
}


/**
 * m6-limit-orders-perp — open a PENDING_ENTRY paper position. Same shape as `openPosition` but
 * `state='PENDING_ENTRY'`, `remaining_size = size` (we track full size for later activation),
 * `openedAtProcessing` is set to the SIGNAL time (activation updates it to the fill time so
 * §21 T1 stays honest). No cash is committed at this point — the trade could never fill.
 *
 * `plannedEntryPrice` (i.e. the limit price) IS the `entryPrice` column — a small dual meaning
 * that keeps the schema unchanged. On activation the entry stays put (that IS the fill price
 * by construction of a resting limit), and `currentStop` / `takeProfit` were already sized
 * against it. So activation is really just a state flip + a fill row + a clock update.
 */
export async function openPendingPosition(db: Db, i: OpenPositionInput): Promise<PositionRow> {
  return db.transaction(async (tx) => {
    const id = randomUUID();
    await tx.insert(paperPosition).values({
      id, portfolioId: i.portfolioId, predictionId: i.predictionId,
      symbol: i.symbol, domain: i.domain, direction: i.direction,
      state: 'PENDING_ENTRY',
      entryPrice: String(i.entryPrice), size: String(i.size), remainingSize: String(i.size),
      currentStop: String(i.currentStop),
      takeProfit: i.takeProfit === null ? null : String(i.takeProfit),
      ladderState: { firedRungs: [] },
      openedAtEvent: i.openedAtEvent, openedAtProcessing: i.openedAtProcessing,
    });
    const row = (await tx.select().from(paperPosition).where(eq(paperPosition.id, id)).limit(1))[0]!;
    return toRow(row);
  });
}

/**
 * PENDING_ENTRY → OPEN on limit fill. `fillPrice` is passed in for future extension (a gap
 * across the limit could fill worse than the limit itself), but in MVP a resting limit fills
 * AT its price by construction and callers should pass the limit as `fillPrice`.
 *
 * Records a `LIMIT_FILL` reason on the fill row so downstream tooling can distinguish it from
 * an ENTRY (which represented an immediate MARKET fill).
 */
export async function activatePendingPosition(db: Db, input: {
  positionId: string; fillPrice: number; clocks: FillClocks;
}): Promise<PositionRow> {
  return db.transaction(async (tx) => {
    const r = (await tx.select().from(paperPosition).where(eq(paperPosition.id, input.positionId)).limit(1))[0];
    if (!r) throw new Error(`position ${input.positionId} not found`);
    if (r.state !== 'PENDING_ENTRY') return toRow(r); // idempotent — already activated or expired
    await tx.update(paperPosition).set({
      state: 'OPEN',
      entryPrice: String(input.fillPrice), // in case future gap-fill semantics allow worse fills
      openedAtEvent: input.clocks.fillAtEvent,
      openedAtProcessing: input.clocks.fillAtProcessing,
    }).where(eq(paperPosition.id, input.positionId));
    await tx.insert(paperPositionFill).values({
      id: randomUUID(), positionId: input.positionId,
      fillAtEvent: input.clocks.fillAtEvent, fillAtProcessing: input.clocks.fillAtProcessing,
      sizeFraction: '1', price: String(input.fillPrice), reason: 'LIMIT_FILL', isFinal: false,
    });
    const updated = (await tx.select().from(paperPosition).where(eq(paperPosition.id, input.positionId)).limit(1))[0]!;
    return toRow(updated);
  });
}

/**
 * PENDING_ENTRY → EXPIRED on LIMIT-expiry window elapsed. No P&L (the trade never opened),
 * no closing fill row (nothing to close). The `close_reason` = `LIMIT_EXPIRY` makes it visible
 * to reporting and to the Outcome Engine, which skips resolution for EXPIRED positions —
 * they never happened.
 */
export async function expirePendingPosition(db: Db, positionId: string, at: Date): Promise<PositionRow> {
  return db.transaction(async (tx) => {
    const r = (await tx.select().from(paperPosition).where(eq(paperPosition.id, positionId)).limit(1))[0];
    if (!r) throw new Error(`position ${positionId} not found`);
    if (r.state !== 'PENDING_ENTRY') return toRow(r);
    await tx.update(paperPosition).set({
      state: 'EXPIRED',
      closedAt: at,
      closeReason: 'LIMIT_EXPIRY',
    }).where(eq(paperPosition.id, positionId));
    const updated = (await tx.select().from(paperPosition).where(eq(paperPosition.id, positionId)).limit(1))[0]!;
    return toRow(updated);
  });
}
