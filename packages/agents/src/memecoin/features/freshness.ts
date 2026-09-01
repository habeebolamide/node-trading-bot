/**
 * Memecoin Signal Freshness feature (§40.18). Aggregator-only — NOT an Agent. Time-decay
 * function: `exp(−Δt/τ)` where Δt is elapsed ms since the triggering wallet activity.
 * τ default = 15s (§9a placeholder — tune from seed-analysis).
 *
 * A signal acted on 2s after the wallet buy is worth more than one acted on 20s later because
 * early wallets already got better prices.
 */
export const DEFAULT_FRESHNESS_TAU_MS = 15_000;

export function freshness(deltaMs: number, tauMs = DEFAULT_FRESHNESS_TAU_MS): number {
  if (tauMs <= 0) return 0;
  if (deltaMs <= 0) return 1;
  return Math.exp(-deltaMs / tauMs);
}
