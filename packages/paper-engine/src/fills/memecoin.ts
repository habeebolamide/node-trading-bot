/**
 * Memecoin fill model (§20, Part II §10, rule 25).
 *
 * §20 is emphatic: "A flat bps or last/mid-price fill is NOT acceptable and MUST NOT be used.
 * Low-liquidity memecoin pools have large, non-linear price impact — a paper engine that fills
 * at last price will manufacture returns that don't survive contact with a real order book."
 *
 * Fills use constant-product AMM math against ACTUAL reserves at execution time. If reserves
 * are unavailable the position DOES NOT FILL — Part II §10 verbatim, rule 25 in general
 * ("no last-price fallback"). The return type is deliberately `Fill | NoFill` so a caller
 * cannot ignore the case: there is no overload that returns a bare number.
 *
 * DETECTION-TIME PRICING (§20): reserves are read at the pool state WHEN THE SYSTEM COULD
 * FIRST HAVE ACTED — processing time, not the wallet's on-chain action time. Pricing at action
 * time credits a fill the system could never have gotten.
 *
 * FINDING FROM TASK 2.0: the current M1 Helius parser projects only the wallet's
 * `tokenTransfers` (packages/ingestion/src/helius/parse.ts). Enhanced tx returns richer data —
 * `accountData[].tokenBalanceChanges` including the pool's own token accounts — but we don't
 * parse it yet. Deriving reserves from that field is a follow-up change to schedule after M6.
 * Until it lands, the memecoin paper engine will `NO_FILL` on every entry. That is rule 25
 * working, not a bug (§20's own answer when reserves are absent), but it is a SCOPE QUESTION
 * for the operator: the alternative is a last-price fallback that §20 forbids by name.
 */

/** AMM pool reserves at a specific time. `xToken` is the target token, `ySol` is the SOL leg. */
export interface PoolReserves {
  xToken: number;
  ySol: number;
  /** Pool fee — Raydium standard 0.0025; Pump.fun 0.01. Config, not hardcoded. */
  fee: number;
}

export type FillResult =
  | { readonly kind: 'FILL'; readonly price: number; readonly tokensOut: number; readonly effectiveNotional: number;
      /** True when the pool-share cap (§10) reduced the requested notional below what was asked. */
      readonly poolShareCapped?: boolean }
  | { readonly kind: 'NO_FILL'; readonly reason: 'RESERVES_UNAVAILABLE' | 'INSUFFICIENT_LIQUIDITY' | 'ZERO_NOTIONAL' | 'BELOW_MIN_AFTER_CAP'; readonly detail: string };

/**
 * BUY: solIn → tokensOut against `(xToken, ySol)`. Constant-product with fee taken on the input:
 *   tokensOut = (xToken · solIn·(1−fee)) / (ySol + solIn·(1−fee))
 * `effectivePrice = solIn / tokensOut` — includes price impact by construction.
 *
 * `NO_FILL(RESERVES_UNAVAILABLE)` is what §20 mandates when depth data is absent — this is the
 * type-level enforcement of rule 25.
 *
 * POOL-SHARE CAP (§10, HARD GATE per §9/§10): the notional may not exceed
 * `maxPoolShare × ySol` (quote-side reserves; default 0.01). §10 is explicit — "Cap first, then
 * fill. If the capped size falls below a usable minimum, output NO TRADE." The cap can only be
 * applied HERE, at fill time, because §20 reads reserves at detection time — the planner that
 * sized the position never saw them. `minNotional` (optional) is that usable-minimum floor;
 * a cap that pushes the size under it returns NO_FILL(BELOW_MIN_AFTER_CAP) rather than filling a
 * meaningless dust position.
 */
export function memecoinBuyFill(input: {
  solIn: number; reserves: PoolReserves | null; maxPoolShare?: number; minNotional?: number;
}): FillResult {
  if (input.solIn <= 0) return { kind: 'NO_FILL', reason: 'ZERO_NOTIONAL', detail: `solIn=${input.solIn}` };
  if (!input.reserves) return { kind: 'NO_FILL', reason: 'RESERVES_UNAVAILABLE', detail: 'depth data absent at detection time' };
  const { xToken, ySol, fee } = input.reserves;
  if (xToken <= 0 || ySol <= 0) return { kind: 'NO_FILL', reason: 'INSUFFICIENT_LIQUIDITY', detail: `reserves x=${xToken} y=${ySol}` };

  // Cap first (§10), then fill. Clamp the requested notional to maxPoolShare × quote reserves.
  let solIn = input.solIn;
  let poolShareCapped = false;
  if (input.maxPoolShare !== undefined) {
    const cap = input.maxPoolShare * ySol;
    if (solIn > cap) { solIn = cap; poolShareCapped = true; }
    if (input.minNotional !== undefined && solIn < input.minNotional) {
      return { kind: 'NO_FILL', reason: 'BELOW_MIN_AFTER_CAP',
        detail: `capped notional ${solIn} < min ${input.minNotional} (maxPoolShare=${input.maxPoolShare}, ySol=${ySol})` };
    }
  }

  const solEffective = solIn * (1 - fee);
  const tokensOut = (xToken * solEffective) / (ySol + solEffective);
  if (tokensOut <= 0) return { kind: 'NO_FILL', reason: 'INSUFFICIENT_LIQUIDITY', detail: 'tokensOut≤0' };
  return {
    kind: 'FILL',
    price: solIn / tokensOut,
    tokensOut,
    effectiveNotional: solIn,
    ...(poolShareCapped ? { poolShareCapped: true } : {}),
  };
}

/** SELL: tokensIn → solOut. Mirror of the buy — symmetry avoids two rounding paths. */
export function memecoinSellFill(input: { tokensIn: number; reserves: PoolReserves | null }): FillResult {
  if (input.tokensIn <= 0) return { kind: 'NO_FILL', reason: 'ZERO_NOTIONAL', detail: `tokensIn=${input.tokensIn}` };
  if (!input.reserves) return { kind: 'NO_FILL', reason: 'RESERVES_UNAVAILABLE', detail: 'depth data absent at detection time' };
  const { xToken, ySol, fee } = input.reserves;
  if (xToken <= 0 || ySol <= 0) return { kind: 'NO_FILL', reason: 'INSUFFICIENT_LIQUIDITY', detail: `reserves x=${xToken} y=${ySol}` };
  const tokensEffective = input.tokensIn * (1 - fee);
  const solOut = (ySol * tokensEffective) / (xToken + tokensEffective);
  if (solOut <= 0) return { kind: 'NO_FILL', reason: 'INSUFFICIENT_LIQUIDITY', detail: 'solOut≤0' };
  return {
    kind: 'FILL',
    price: solOut / input.tokensIn,
    tokensOut: solOut,
    effectiveNotional: solOut,
  };
}
