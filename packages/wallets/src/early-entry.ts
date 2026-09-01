/**
 * Per-wallet early-entry edge (§3, §40.17) via the observed-swap approximation. For each of the
 * wallet's trades, measure forward returns at the standard horizons against a price series built
 * from ALL observed swaps on that token (across every backfilled wallet — richer than one wallet's
 * own swaps). Persists one `trade_outcome` per priced trade and returns the aggregate for
 * `BrainWalletMemory`.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { walletTrade, walletTransaction, tradeOutcome, type Db } from '@tip/database';
import { buildSeries, forwardReturns, HORIZON_KEYS, type PricePoint } from './price-series.js';
import { median, mean } from './stats.js';
import type { EarlyEntryAggregate } from './metrics.js';

export interface EarlyEntryResult extends EarlyEntryAggregate {
  perHorizonMedian: Record<string, number | null>;
}

export async function computeWalletEarlyEntry(db: Db, walletId: string): Promise<EarlyEntryResult> {
  const trades = await db.select().from(walletTrade).where(eq(walletTrade.wallet, walletId));

  // Cache each token's observed-swap series (built from ALL wallets' swaps on that mint).
  const seriesByMint = new Map<string, PricePoint[]>();
  const loadSeries = async (mint: string): Promise<PricePoint[]> => {
    const cached = seriesByMint.get(mint);
    if (cached) return cached;
    const swaps = await db
      .select({ amountSol: walletTransaction.amountSol, tokenAmount: walletTransaction.tokenAmount, blockTime: walletTransaction.blockTime })
      .from(walletTransaction)
      .where(eq(walletTransaction.mint, mint))
      .orderBy(asc(walletTransaction.blockTime));
    const series = buildSeries(swaps);
    seriesByMint.set(mint, series);
    return series;
  };

  const perHorizon: Record<string, number[]> = Object.fromEntries(HORIZON_KEYS.map((h) => [h, []]));
  const peaks: number[] = [];
  const coverages: number[] = [];
  const outcomeRows: (typeof tradeOutcome.$inferInsert)[] = [];

  for (const t of trades) {
    const tokensBought = Number(t.tokensBought);
    const solIn = Number(t.totalSolIn);
    if (tokensBought <= 0 || solIn <= 0) continue; // can't price the entry
    const entryPrice = solIn / tokensBought;
    const series = await loadSeries(t.mint);
    const fr = forwardReturns(entryPrice, t.openedAt.getTime(), series);

    for (const h of HORIZON_KEYS) {
      const r = fr.returns[h];
      if (r !== null && r !== undefined) perHorizon[h]!.push(r);
    }
    if (fr.peak !== null) peaks.push(fr.peak);
    coverages.push(fr.coverage);

    outcomeRows.push({
      id: randomUUID(),
      tradeId: t.id,
      walletId,
      mint: t.mint,
      entryAt: t.openedAt,
      entryPriceSol: String(entryPrice),
      forwardReturns: fr.returns,
      peakReturn: fr.peak === null ? null : String(fr.peak),
      coverage: String(fr.coverage),
    });
  }

  // Recompute is a view over swaps: replace this wallet's trade_outcome rows.
  await db.transaction(async (tx) => {
    await tx.delete(tradeOutcome).where(eq(tradeOutcome.walletId, walletId));
    if (outcomeRows.length > 0) await tx.insert(tradeOutcome).values(outcomeRows);
  });

  const perHorizonMedian: Record<string, number | null> = {};
  for (const h of HORIZON_KEYS) perHorizonMedian[h] = median(perHorizon[h]!);

  return {
    perHorizonMedian,
    peakMedian: median(peaks),
    coverage: mean(coverages) ?? 0,
  };
}
