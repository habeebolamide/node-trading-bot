/**
 * The provider seam (rule 17). Everything downstream — the event bus, agents, the replay
 * engine — depends only on these normalized shapes and the domain events derived from them,
 * never on an exchange-specific payload (§12). A second exchange would implement the same
 * interface without touching a single consumer.
 *
 * Every normalized shape carries BOTH clocks (§10): `eventTime` is the source's own timestamp
 * (when it happened), `processingTime` is when this system received it. The point-in-time
 * correctness the whole platform leans on (rules 21/22) needs this distinction present from
 * the first byte of ingestion.
 */
import type { MarketSymbol, Timeframe } from '@tip/domain';

export interface Clocks {
  /** ISO — when the event actually happened, from the source payload. */
  readonly eventTime: string;
  /** ISO — when this system received/created it. */
  readonly processingTime: string;
}

export interface NormalizedKline extends Clocks {
  readonly symbol: MarketSymbol;
  readonly timeframe: Timeframe;
  readonly openTime: Date;
  readonly closeTime: Date;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly turnover: string | null;
  /** True only when the candle has closed. Only confirmed candles are persistable (§25). */
  readonly confirm: boolean;
}

export interface NormalizedTicker extends Clocks {
  readonly symbol: MarketSymbol;
  readonly lastPrice: string | null;
  readonly markPrice: string | null;
  readonly indexPrice: string | null;
  readonly fundingRate: string | null;
  readonly nextFundingTime: Date | null;
  readonly openInterest: string | null;
}

export interface NormalizedLiquidation extends Clocks {
  readonly symbol: MarketSymbol;
  readonly side: 'BUY' | 'SELL';
  readonly size: string;
  readonly price: string;
  readonly time: Date;
}

export interface NormalizedAccountRatio extends Clocks {
  readonly symbol: MarketSymbol;
  readonly buyRatio: string;
  readonly sellRatio: string;
  /** buyRatio / sellRatio, precomputed for convenience. */
  readonly longShortRatio: string;
  readonly time: Date;
}

export interface HistoryQuery {
  readonly start?: number; // ms epoch, inclusive
  readonly end?: number; // ms epoch, inclusive
  readonly limit?: number;
}

/**
 * The historical-data half of the provider abstraction (the perp provider is the only one that
 * needs it — memecoin history is scoped out, §25). Live streaming is driven by the concrete
 * adapter's own start/stop lifecycle rather than through this interface, since the delivery
 * model (WS push vs webhook) differs too much to usefully unify at MVP.
 */
export interface MarketDataProvider {
  getKlines(symbol: MarketSymbol, timeframe: Timeframe, q?: HistoryQuery): Promise<NormalizedKline[]>;
  getAccountRatio(symbol: MarketSymbol, period: string): Promise<NormalizedAccountRatio>;
}
