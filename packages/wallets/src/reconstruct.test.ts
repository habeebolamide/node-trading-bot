import { describe, it, expect } from 'vitest';
import { reconstructTrades, type SwapInput } from './reconstruct.js';

const T = (s: number) => new Date(1_700_000_000_000 + s * 1000);
const buy = (sol: number, tokens: number, at: number): SwapInput => ({ action: 'BUY', amountSol: sol, tokenAmount: tokens, blockTime: T(at) });
const sell = (sol: number, tokens: number, at: number): SwapInput => ({ action: 'SELL', amountSol: sol, tokenAmount: tokens, blockTime: T(at) });

describe('reconstructTrades', () => {
  it('a clean round-trip → one CLOSED winning trade with SOL P&L', () => {
    const [t, ...rest] = reconstructTrades('W', 'M', [buy(2, 1000, 0), sell(3, 1000, 60)]);
    expect(rest).toHaveLength(0);
    expect(t!.status).toBe('CLOSED');
    expect(t!.totalSolIn).toBe(2);
    expect(t!.totalSolOut).toBe(3);
    expect(t!.realizedReturnPct).toBeCloseTo(0.5, 6);
    expect(t!.won).toBe(true);
    expect(t!.holdingPeriodSec).toBe(60);
    expect(t!.buyCount).toBe(1);
    expect(t!.sellCount).toBe(1);
  });

  it('accumulates partial sells until the position closes', () => {
    const trades = reconstructTrades('W', 'M', [buy(2, 1000, 0), sell(1.2, 400, 30), sell(1.8, 600, 60)]);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.totalSolOut).toBeCloseTo(3, 6);
    expect(trades[0]!.realizedReturnPct).toBeCloseTo(0.5, 6);
    expect(trades[0]!.sellCount).toBe(2);
  });

  it('re-entry after a full close produces two separate trades', () => {
    const trades = reconstructTrades('W', 'M', [
      buy(2, 1000, 0), sell(3, 1000, 60), // trade 1: win
      buy(1, 500, 120), sell(0.5, 500, 180), // trade 2: loss
    ]);
    expect(trades).toHaveLength(2);
    expect(trades[0]!.won).toBe(true);
    expect(trades[1]!.won).toBe(false);
    expect(trades[1]!.realizedReturnPct).toBeCloseTo(-0.5, 6);
  });

  it('leaves a still-held position OPEN with no realized outcome', () => {
    const trades = reconstructTrades('W', 'M', [buy(2, 1000, 0), sell(1, 400, 30)]); // 60% still held
    expect(trades).toHaveLength(1);
    expect(trades[0]!.status).toBe('OPEN');
    expect(trades[0]!.realizedReturnPct).toBeNull();
    expect(trades[0]!.won).toBeNull();
    expect(trades[0]!.closedAt).toBeNull();
  });

  it('treats a sub-1% remaining dust position as closed (moon-bag)', () => {
    const trades = reconstructTrades('W', 'M', [buy(2, 1000, 0), sell(3, 995, 60)]); // 0.5% left
    expect(trades[0]!.status).toBe('CLOSED');
  });

  it('clamps an oversell and flags a suspected transfer-in', () => {
    const trades = reconstructTrades('W', 'M', [buy(1, 100, 0), sell(5, 500, 60)]); // sold 5x tracked
    expect(trades[0]!.status).toBe('CLOSED');
    expect(trades[0]!.tokensSold).toBe(100); // clamped to what was bought
    expect(trades[0]!.flags).toContain('TRANSFER_IN_SUSPECTED');
  });

  it('skips a sell with no tracked position (untracked tokens)', () => {
    expect(reconstructTrades('W', 'M', [sell(1, 100, 0)])).toHaveLength(0);
  });

  it('guards divide-by-zero when cost basis is zero', () => {
    const trades = reconstructTrades('W', 'M', [buy(0, 1000, 0), sell(1, 1000, 60)]);
    expect(trades[0]!.realizedReturnPct).toBeNull();
    expect(trades[0]!.won).toBe(true); // proceeds > 0 cost
  });

  it('sorts unordered input by block time', () => {
    const trades = reconstructTrades('W', 'M', [sell(3, 1000, 60), buy(2, 1000, 0)]);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.status).toBe('CLOSED');
    expect(trades[0]!.openedAt.getTime()).toBe(T(0).getTime());
  });
});
