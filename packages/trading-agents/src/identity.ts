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
/**
 * Analysis timeframes per style (§8 table). The primary TF (middle of each band) fires the
 * pipeline; the full stack is what CADENCE/CONDITIONAL agents read for multi-TF confirmation.
 *   scalp: 1m · 5m · 15m   day: 15m · 1h · 4h   swing: 4h · 1d
 */
export const ANALYSIS_TFS: Record<TradingStyle, readonly ('1m'|'5m'|'15m'|'1h'|'4h'|'1d')[]> = {
  scalp: ['1m', '5m', '15m'],
  day: ['15m', '1h', '4h'],
  swing: ['4h', '1d'],
};

/** Map a primary TF back to its style's analysis stack (agents get primaryTf, not style). */
export const ANALYSIS_TFS_FOR_PRIMARY: Record<'5m'|'1h'|'4h', readonly ('1m'|'5m'|'15m'|'1h'|'4h'|'1d')[]> = {
  '5m': ['1m', '5m', '15m'],
  '1h': ['15m', '1h', '4h'],
  '4h': ['4h', '1d'],
};

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
