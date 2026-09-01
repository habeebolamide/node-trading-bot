/**
 * Shared domain primitives. Kept deliberately small — only the vocabulary that
 * genuinely crosses package boundaries lives here (CLAUDE.md — "grow an existing
 * one" over inventing types). Domain-specific enums (regimes, exit reasons, etc.)
 * belong to the package that owns that concept, not here.
 */

/** The two trading domains. Their intelligence never mixes (§4, rule 6). */
export const DOMAINS = ['perp', 'memecoin'] as const;
export type Domain = (typeof DOMAINS)[number];

/**
 * Candle timeframes used across analysis, backfill and the historical store.
 * Matches the trading-style band table (§8) plus 1m — the finest historical
 * granularity used for seeded-outcome resolution (§25).
 */
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/**
 * Trading style (§8) — drives analysis TFs, primary TF, horizons, ATR window,
 * and signal TTL together. Identity of a TradingAgent (immutable, §8/Task 1).
 */
export const TRADING_STYLES = ['scalp', 'day', 'swing'] as const;
export type TradingStyle = (typeof TRADING_STYLES)[number];

/**
 * Branded string aliases. Zero runtime cost — they only stop a raw string being
 * passed where a specific identifier is expected (e.g. a mint where a symbol
 * belongs). Construct via the helpers so intent is explicit at the call site.
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A Bybit perp symbol, e.g. "BTCUSDT". */
export type MarketSymbol = Brand<string, 'MarketSymbol'>;
export const marketSymbol = (s: string): MarketSymbol => s as MarketSymbol;

/** A Solana token mint address. */
export type Mint = Brand<string, 'Mint'>;
export const mint = (s: string): Mint => s as Mint;

/** A Solana wallet address. */
export type WalletAddress = Brand<string, 'WalletAddress'>;
export const walletAddress = (s: string): WalletAddress => s as WalletAddress;
