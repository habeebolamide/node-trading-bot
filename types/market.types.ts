// ─────────────────────────────────────────────
// Market types
// ─────────────────────────────────────────────

export interface Candle {
  openTime:  number;      // unix ms
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
  closeTime: number;      // unix ms
  pair:      string;
  interval:  CandleInterval;
}

export type CandleInterval =
  | '1'    // 1 minute
  | '5'    // 5 minutes
  | '15'   // 15 minutes
  | '60'   // 1 hour
  | '240'  // 4 hours
  | 'D';   // 1 day

export interface OrderBook {
  pair:      string;
  bids:      OrderBookLevel[];  // [price, size]
  asks:      OrderBookLevel[];  // [price, size]
  timestamp: number;
}

export interface OrderBookLevel {
  price: number;
  size:  number;
}

export interface Ticker {
  pair:          string;
  lastPrice:     number;
  priceChange24: number;  // %
  volume24:      number;
  high24:        number;
  low24:         number;
  timestamp:     number;
}

export interface NewsItem {
  id:        string;
  headline:  string;
  source:    string;
  sentiment: 'positive' | 'negative' | 'neutral';
  impact:    'high' | 'medium' | 'low';
  pairs:     string[];   // which pairs this affects e.g. ['BTCUSDT']
  url:       string;
  publishedAt: Date;
}

export interface EconomicEvent {
  name:        string;    // e.g. "US CPI Release"
  impact:      'high' | 'medium' | 'low';
  scheduledAt: Date;
  currency:    string;    // affected currency
}

// ─────────────────────────────────────────────
// Indicator types
// ─────────────────────────────────────────────

export interface Indicators {
  rsi:        number;           // 0-100
  ema20:      number;
  ema50:      number;
  ema200:     number;
  macd:       MacdResult;
  bollinger:  BollingerResult;
  adx:        number;           // 0-100 trend strength
  atr:        number;           // average true range
  volume:     VolumeResult;
}

export interface MacdResult {
  macd:      number;
  signal:    number;
  histogram: number;
}

export interface BollingerResult {
  upper:  number;
  middle: number;
  lower:  number;
  width:  number;   // (upper - lower) / middle — volatility measure
}

export interface VolumeResult {
  current:    number;
  average:    number;       // 20 candle average
  ratio:      number;       // current / average — spike detector
  trend:      'increasing' | 'decreasing' | 'flat';
}

// ─────────────────────────────────────────────
// Market regime
// ─────────────────────────────────────────────

export type MarketRegime =
  | 'TRENDING_BULL'
  | 'TRENDING_BEAR'
  | 'RANGING'
  | 'VOLATILE'
  | 'NEUTRAL';

export interface RegimeAnalysis {
  regime:        MarketRegime;
  confidence:    number;          // 0-1 how confident the code is
  adx:           number;
  bbWidth:       number;
  emaSlope:      number;
  volumeTrend:   string;
}

// ─────────────────────────────────────────────
// Multi-timeframe snapshot
// ─────────────────────────────────────────────

export interface MultiTimeframeData {
  pair:   string;
  tf4h:   TimeframeSnapshot;
  tf1h:   TimeframeSnapshot;
  tf15m:  TimeframeSnapshot;
  tf5m:   TimeframeSnapshot;
}

export interface TimeframeSnapshot {
  interval:   CandleInterval;
  candles:    Candle[];           // last 50 candles
  indicators: Indicators;
  regime:     RegimeAnalysis;
}