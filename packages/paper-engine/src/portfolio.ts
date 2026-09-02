/**
 * Paper portfolio primitives — virtual cash, equity, peak equity, max drawdown. Realized P&L
 * accrues at close (or on ladder fills); unrealized is computed on read against a live mark.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { paperPortfolio, type Db } from '@tip/database';

export interface CreatePortfolioInput {
  tradingAgentId: string;
  startingCash: number;
}

export interface PortfolioRow {
  id: string;
  tradingAgentId: string;
  startingCash: number;
  cash: number;
  equity: number;
  peakEquity: number;
  maxDrawdown: number;
  realizedPnl: number;
}

export async function createPortfolio(db: Db, i: CreatePortfolioInput): Promise<PortfolioRow> {
  const id = randomUUID();
  const cash = i.startingCash;
  const row = {
    id, tradingAgentId: i.tradingAgentId,
    startingCash: String(cash), cash: String(cash), equity: String(cash),
    peakEquity: String(cash), maxDrawdown: '0', realizedPnl: '0',
  };
  await db.insert(paperPortfolio).values(row);
  return { id, tradingAgentId: i.tradingAgentId, startingCash: cash, cash, equity: cash, peakEquity: cash, maxDrawdown: 0, realizedPnl: 0 };
}

export async function getPortfolio(db: Db, id: string): Promise<PortfolioRow | null> {
  const r = (await db.select().from(paperPortfolio).where(eq(paperPortfolio.id, id)).limit(1))[0];
  if (!r) return null;
  return {
    id: r.id, tradingAgentId: r.tradingAgentId,
    startingCash: Number(r.startingCash), cash: Number(r.cash), equity: Number(r.equity),
    peakEquity: Number(r.peakEquity), maxDrawdown: Number(r.maxDrawdown), realizedPnl: Number(r.realizedPnl),
  };
}

/**
 * Apply a realized P&L delta and refresh equity / peak / drawdown. Called from position closes
 * and ladder fills. Idempotency is the caller's problem — the fill row's insert should be part
 * of the same transaction to avoid double-crediting on retry.
 */
export async function applyPnl(db: Db, portfolioId: string, delta: number): Promise<PortfolioRow> {
  return db.transaction(async (tx) => {
    const r = (await tx.select().from(paperPortfolio).where(eq(paperPortfolio.id, portfolioId)).limit(1))[0];
    if (!r) throw new Error(`portfolio ${portfolioId} not found`);
    const cash = Number(r.cash) + delta;
    const realizedPnl = Number(r.realizedPnl) + delta;
    // Equity here uses cash only; unrealized is added by callers reading against a live mark.
    const equity = cash;
    const peakEquity = Math.max(Number(r.peakEquity), equity);
    // Drawdown is the deepest fractional trough below the peak SO FAR — never resets.
    const drawdown = peakEquity > 0 ? Math.max(Number(r.maxDrawdown), (peakEquity - equity) / peakEquity) : 0;
    await tx.update(paperPortfolio).set({
      cash: String(cash), equity: String(equity), peakEquity: String(peakEquity),
      maxDrawdown: String(drawdown), realizedPnl: String(realizedPnl),
      updatedAt: new Date(),
    }).where(eq(paperPortfolio.id, portfolioId));
    return { id: portfolioId, tradingAgentId: r.tradingAgentId, startingCash: Number(r.startingCash),
      cash, equity, peakEquity, maxDrawdown: drawdown, realizedPnl };
  });
}
