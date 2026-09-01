/**
 * Persist reconstructed trades. Reconstruction is a deterministic VIEW over `wallet_transaction`,
 * so a recompute REPLACES a (wallet, mint)'s `wallet_trade` rows (delete-then-insert in one
 * transaction) rather than trying to diff/merge — keeping the trades consistent with the latest
 * swap set. (Trades aren't immutable facts like Predictions; rule 10 governs Predictions, not
 * these reconstructed views.)
 */
import { randomUUID } from 'node:crypto';
import { and, eq, asc } from 'drizzle-orm';
import { walletTransaction, walletTrade, type Db } from '@tip/database';
import { reconstructTrades, type ReconstructedTrade, type SwapInput } from './reconstruct.js';

const numStr = (n: number | null): string | null => (n === null ? null : String(n));

function toRow(t: ReconstructedTrade) {
  return {
    id: randomUUID(),
    wallet: t.wallet,
    mint: t.mint,
    status: t.status,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    buyCount: t.buyCount,
    sellCount: t.sellCount,
    totalSolIn: String(t.totalSolIn),
    totalSolOut: String(t.totalSolOut),
    tokensBought: String(t.tokensBought),
    tokensSold: String(t.tokensSold),
    realizedReturnPct: numStr(t.realizedReturnPct),
    won: t.won,
    holdingPeriodSec: t.holdingPeriodSec,
    flags: t.flags,
  };
}

/** Recompute and persist one (wallet, mint)'s trades from its swaps. Returns the trades. */
export async function reconstructWalletMint(db: Db, wallet: string, mint: string): Promise<ReconstructedTrade[]> {
  const swaps = await db
    .select({
      action: walletTransaction.action,
      amountSol: walletTransaction.amountSol,
      tokenAmount: walletTransaction.tokenAmount,
      blockTime: walletTransaction.blockTime,
    })
    .from(walletTransaction)
    .where(and(eq(walletTransaction.wallet, wallet), eq(walletTransaction.mint, mint)))
    .orderBy(asc(walletTransaction.blockTime));

  const trades = reconstructTrades(
    wallet,
    mint,
    swaps.map((s): SwapInput => ({
      action: s.action === 'SELL' ? 'SELL' : 'BUY',
      amountSol: s.amountSol,
      tokenAmount: s.tokenAmount,
      blockTime: s.blockTime,
    })),
  );

  await db.transaction(async (tx) => {
    await tx.delete(walletTrade).where(and(eq(walletTrade.wallet, wallet), eq(walletTrade.mint, mint)));
    if (trades.length > 0) await tx.insert(walletTrade).values(trades.map(toRow));
  });

  return trades;
}

/** Recompute every mint a wallet has traded. Returns per-mint trade counts. */
export async function reconstructWallet(db: Db, wallet: string): Promise<{ mints: number; trades: number }> {
  const rows = await db
    .selectDistinct({ mint: walletTransaction.mint })
    .from(walletTransaction)
    .where(eq(walletTransaction.wallet, wallet));

  let trades = 0;
  for (const { mint } of rows) {
    const t = await reconstructWalletMint(db, wallet, mint);
    trades += t.length;
  }
  return { mints: rows.length, trades };
}
