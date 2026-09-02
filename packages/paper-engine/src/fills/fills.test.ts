import { describe, it, expect } from 'vitest';
import { perpFillPrice } from './perp.js';
import { memecoinBuyFill, memecoinSellFill } from './memecoin.js';

describe('perp fill (§20 flat bps)', () => {
  it('LONG pays UP by bps + tick; SHORT pays DOWN', () => {
    const long = perpFillPrice({ last: 100_000, direction: 'LONG', slippageBps: 5.5, tickSize: 0.5 });
    const short = perpFillPrice({ last: 100_000, direction: 'SHORT', slippageBps: 5.5, tickSize: 0.5 });
    expect(long).toBeCloseTo(100_000 + (100_000 * 5.5 / 10_000) + 0.5, 6);
    expect(short).toBeCloseTo(100_000 - (100_000 * 5.5 / 10_000) - 0.5, 6);
    expect(long).toBeGreaterThan(short);
  });
  it('zero slippage returns the last price plus/minus one tick', () => {
    expect(perpFillPrice({ last: 100, direction: 'LONG', slippageBps: 0, tickSize: 0.1 })).toBeCloseTo(100.1, 6);
  });
});

describe('memecoin fill (§20 AMM, rule 25)', () => {
  const reserves = { xToken: 1_000_000, ySol: 100, fee: 0.003 };

  it('BUY: constant-product with fee — includes price impact by construction', () => {
    const r = memecoinBuyFill({ solIn: 10, reserves });
    expect(r.kind).toBe('FILL');
    if (r.kind !== 'FILL') return;
    // Sanity: tokensOut ≈ (1e6 · 10·0.997) / (100 + 10·0.997) = 90,663.8… ; price = 10/tokensOut
    expect(r.tokensOut).toBeCloseTo((1_000_000 * 10 * 0.997) / (100 + 10 * 0.997), 4);
    // Effective price is worse than 0.0001 (the no-impact price) because impact + fee.
    expect(r.price).toBeGreaterThan(100 / 1_000_000);
  });

  it('SELL: mirror math; larger sells impact price more', () => {
    const small = memecoinSellFill({ tokensIn: 1_000, reserves });
    const big = memecoinSellFill({ tokensIn: 100_000, reserves });
    if (small.kind !== 'FILL' || big.kind !== 'FILL') throw new Error('should fill');
    // Larger sell → worse per-token price
    expect(big.price).toBeLessThan(small.price);
  });

  it('RULE 25: NO_FILL(RESERVES_UNAVAILABLE) when reserves are null — never a last-price fallback', () => {
    const r = memecoinBuyFill({ solIn: 10, reserves: null });
    expect(r.kind).toBe('NO_FILL');
    if (r.kind === 'NO_FILL') {
      expect(r.reason).toBe('RESERVES_UNAVAILABLE');
      // No `price` field can exist — the return type structurally cannot carry one.
      expect((r as unknown as { price?: number }).price).toBeUndefined();
    }
  });

  it('NO_FILL on zero/negative notional and on empty pools', () => {
    expect(memecoinBuyFill({ solIn: 0, reserves }).kind).toBe('NO_FILL');
    expect(memecoinBuyFill({ solIn: -1, reserves }).kind).toBe('NO_FILL');
    expect(memecoinBuyFill({ solIn: 1, reserves: { xToken: 0, ySol: 100, fee: 0.003 } }).kind).toBe('NO_FILL');
  });

  it('fee reduces the input entering the pool', () => {
    const zeroFee = memecoinBuyFill({ solIn: 10, reserves: { ...reserves, fee: 0 } });
    const highFee = memecoinBuyFill({ solIn: 10, reserves: { ...reserves, fee: 0.01 } });
    if (zeroFee.kind !== 'FILL' || highFee.kind !== 'FILL') throw new Error('should fill');
    expect(highFee.tokensOut).toBeLessThan(zeroFee.tokensOut);
  });

  describe('§10 pool-share cap (HARD GATE, cap first then fill)', () => {
    // ySol = 100 → maxPoolShare 0.01 caps notional at 1.0 SOL.
    it('caps an oversized notional to maxPoolShare × ySol and flags it', () => {
      const r = memecoinBuyFill({ solIn: 10, reserves, maxPoolShare: 0.01 });
      if (r.kind !== 'FILL') throw new Error('should fill at the capped size');
      expect(r.effectiveNotional).toBeCloseTo(1.0, 9); // 0.01 × 100
      expect(r.poolShareCapped).toBe(true);
      // Capped fill buys fewer tokens than the uncapped 10-SOL fill would.
      const uncapped = memecoinBuyFill({ solIn: 10, reserves });
      if (uncapped.kind !== 'FILL') throw new Error('uncapped should fill');
      expect(r.tokensOut).toBeLessThan(uncapped.tokensOut);
    });

    it('does not cap (or flag) a notional already within the limit', () => {
      const r = memecoinBuyFill({ solIn: 0.5, reserves, maxPoolShare: 0.01 });
      if (r.kind !== 'FILL') throw new Error('should fill');
      expect(r.effectiveNotional).toBeCloseTo(0.5, 9);
      expect(r.poolShareCapped).toBeUndefined();
    });

    it('NO_FILL(BELOW_MIN_AFTER_CAP) when the cap pushes size under the usable minimum', () => {
      const r = memecoinBuyFill({ solIn: 10, reserves, maxPoolShare: 0.01, minNotional: 2 });
      expect(r.kind).toBe('NO_FILL');
      if (r.kind === 'NO_FILL') expect(r.reason).toBe('BELOW_MIN_AFTER_CAP');
    });
  });
});
