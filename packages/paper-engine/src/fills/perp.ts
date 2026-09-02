/**
 * Perp fill model (§20). Flat bps — Task 7 fixes it at "5.5bps taker + 1 tick" for perp.
 *
 * §20 blesses this for major perp books ("deep enough that a reasonably-sized paper position
 * doesn't meaningfully move the market"). It is NOT acceptable for memecoin (see fills/memecoin.ts
 * for the rule 25 argument) and importing this from memecoin code is a modelling mistake caught
 * at review; the `domain: 'perp'` on the setup makes the routing structural anyway.
 */
export const DEFAULT_PERP_SLIPPAGE_BPS = 5.5;

/**
 * Fill = last ± (last × bps/10_000), signed against the trade direction.
 * A LONG pays UP (fills above last); a SHORT pays DOWN. `tickSize` adds one tick to the bps
 * cost — this is Task 7's "+1 tick" component.
 */
export function perpFillPrice(input: {
  last: number;
  direction: 'LONG' | 'SHORT';
  slippageBps?: number;
  tickSize?: number;
}): number {
  const bps = input.slippageBps ?? DEFAULT_PERP_SLIPPAGE_BPS;
  const impact = input.last * bps / 10_000 + (input.tickSize ?? 0);
  return input.direction === 'LONG' ? input.last + impact : input.last - impact;
}
