/**
 * Pure round-trip trade reconstruction (Part II §2). Turns a wallet's ordered swaps on ONE mint
 * into round-trip trades with realized, SOL-denominated P&L. Average-cost model: buys accumulate
 * tokens + SOL cost, sells realize proceeds, and a trade CLOSES when the position returns to ~0
 * (dust tolerance) — the next buy opens a fresh trade. A position still held at the end stays OPEN
 * with no realized outcome.
 *
 * Deterministic and side-effect-free (no DB, no clock, no id generation) — ids are assigned at
 * persist time so this stays fixture-testable and reproducible.
 */
export interface SwapInput {
  action: 'BUY' | 'SELL';
  amountSol: string | number;
  tokenAmount: string | number;
  blockTime: Date;
}

export interface ReconstructedTrade {
  wallet: string;
  mint: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: Date;
  closedAt: Date | null;
  buyCount: number;
  sellCount: number;
  totalSolIn: number;
  totalSolOut: number;
  tokensBought: number;
  tokensSold: number;
  realizedReturnPct: number | null;
  won: boolean | null;
  holdingPeriodSec: number | null;
  flags: string[];
}

/** A position under this fraction of its total tokens bought counts as closed (moon-bag dust). */
const DUST_FRACTION = 0.01;

const num = (v: string | number): number => (typeof v === 'number' ? v : Number(v));

interface OpenState {
  openedAt: Date;
  lastAt: Date;
  buyCount: number;
  sellCount: number;
  solIn: number;
  solOut: number;
  tokensBought: number;
  tokensSold: number;
  pos: number;
  flags: Set<string>;
}

function close(s: OpenState, wallet: string, mint: string, closedAt: Date): ReconstructedTrade {
  const realizedReturnPct = s.solIn > 0 ? (s.solOut - s.solIn) / s.solIn : null;
  return {
    wallet,
    mint,
    status: 'CLOSED',
    openedAt: s.openedAt,
    closedAt,
    buyCount: s.buyCount,
    sellCount: s.sellCount,
    totalSolIn: s.solIn,
    totalSolOut: s.solOut,
    tokensBought: s.tokensBought,
    tokensSold: s.tokensSold,
    realizedReturnPct,
    won: s.solOut > s.solIn,
    holdingPeriodSec: Math.round((closedAt.getTime() - s.openedAt.getTime()) / 1000),
    flags: [...s.flags],
  };
}

export function reconstructTrades(wallet: string, mint: string, swaps: readonly SwapInput[]): ReconstructedTrade[] {
  const ordered = [...swaps].sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());
  const trades: ReconstructedTrade[] = [];
  let open: OpenState | null = null;

  for (const swap of ordered) {
    const sol = num(swap.amountSol);
    const tokens = num(swap.tokenAmount);

    if (swap.action === 'BUY') {
      if (!open) {
        open = {
          openedAt: swap.blockTime, lastAt: swap.blockTime, buyCount: 0, sellCount: 0,
          solIn: 0, solOut: 0, tokensBought: 0, tokensSold: 0, pos: 0, flags: new Set(),
        };
      }
      open.pos += tokens;
      open.solIn += sol;
      open.tokensBought += tokens;
      open.buyCount += 1;
      open.lastAt = swap.blockTime;
      continue;
    }

    // SELL
    if (!open) {
      // A sell with no tracked position: tokens arrived by transfer/airdrop, not a buy we saw.
      // Can't form a round-trip from proceeds alone — skip it (no trade to attribute it to).
      continue;
    }
    const sold = Math.min(tokens, open.pos);
    if (tokens > open.pos * (1 + DUST_FRACTION)) open.flags.add('TRANSFER_IN_SUSPECTED');
    open.solOut += sol;
    open.tokensSold += sold;
    open.pos -= sold;
    open.sellCount += 1;
    open.lastAt = swap.blockTime;

    if (open.pos <= open.tokensBought * DUST_FRACTION) {
      trades.push(close(open, wallet, mint, swap.blockTime));
      open = null;
    }
  }

  if (open) {
    // Still holding — OPEN trade, no realized outcome yet.
    trades.push({
      wallet, mint, status: 'OPEN', openedAt: open.openedAt, closedAt: null,
      buyCount: open.buyCount, sellCount: open.sellCount, totalSolIn: open.solIn, totalSolOut: open.solOut,
      tokensBought: open.tokensBought, tokensSold: open.tokensSold,
      realizedReturnPct: null, won: null, holdingPeriodSec: null, flags: [...open.flags],
    });
  }

  return trades;
}
