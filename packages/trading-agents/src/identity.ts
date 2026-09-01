/**
 * TradingAgent identity (§14, §8/Task 1). `{ id, name, domain, universe, tradingStyle }` is
 * immutable — changing `domain` or `tradingStyle` invalidates the whole TF/horizon basis (§8);
 * that's a new agent, not an edit. Everything tunable lives in the versioned `ScoringConfig`.
 */
export type Domain = 'perp' | 'memecoin';
export type TradingStyle = 'scalp' | 'day' | 'swing';

export const DOMAINS: readonly Domain[] = ['perp', 'memecoin'];
export const TRADING_STYLES: readonly TradingStyle[] = ['scalp', 'day', 'swing'];

export interface TradingAgentIdentity {
  readonly id: string;
  readonly name: string;
  readonly domain: Domain;
  readonly universe: readonly string[];
  readonly tradingStyle: TradingStyle;
}

/** Style → primary TF for CADENCE agents (§8 finalized mapping table). */
export const PRIMARY_TF: Record<TradingStyle, '5m' | '1h' | '4h'> = {
  scalp: '5m',
  day: '1h',
  swing: '4h',
};

/** Style → signal TTL (§8; memecoin overrides in the memecoin-specific table). */
export const SIGNAL_TTL_MS: Record<TradingStyle, { perp: number; memecoin: number }> = {
  scalp: { perp: 15 * 60_000, memecoin: 10 * 60_000 },
  day: { perp: 4 * 60 * 60_000, memecoin: 30 * 60_000 },
  swing: { perp: 24 * 60 * 60_000, memecoin: 2 * 60 * 60_000 },
};
