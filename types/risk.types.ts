// ─────────────────────────────────────────────
// Risk types
// ─────────────────────────────────────────────

export type RiskBlockReason =
  | 'MONTHLY_CAP_HIT'
  | 'DAILY_CAP_HIT'
  | 'CORRELATION_LIMIT'
  | 'LOW_CONFIDENCE'
  | 'VOLATILITY_PAUSE'
  | 'CIRCUIT_BREAKER'
  | 'NEWS_BLACKOUT'
  | 'INSUFFICIENT_CAPITAL'
  | 'COOLDOWN_ACTIVE'
  | 'RECOVERY_MODE_FILTER'
  | 'INVALID_SIGNAL';

export type PerformanceMode =
  | 'NORMAL'        // 0-5% monthly — standard operation
  | 'GROWTH'        // 5%+ monthly — floor achieved, ride winners
  | 'CONSERVATIVE'  // approaching drawdown cap — tighten up
  | 'RECOVERY';     // in drawdown — capital preservation first

export interface ValidationResult {
  approved:     boolean;
  blockReason:  RiskBlockReason | null;
  positionSize: number | null;    // calculated size if approved
  message:      string;
}

export interface DrawdownState {
  agentId:          string;
  dailyPnlPct:      number;
  monthlyPnlPct:    number;
  peakPortfolioValue: number;
  currentDrawdown:  number;       // from peak %
  maxDrawdownHit:   number;       // worst drawdown this month
  performanceMode:  PerformanceMode;
}

export interface CircuitBreakerState {
  isTripped:        boolean;
  tripReason:       string | null;
  trippedAt:        Date | null;
  resumeAt:         Date | null;    // when auto-resume
  priceMove5m:      number;         // % move in last 5 mins
  spreadPct:        number;         // current bid/ask spread %
  volumeRatio:      number;         // current vs average volume
}

export interface CorrelationSnapshot {
  pair:             string;
  direction:        'LONG' | 'SHORT';
  activeAgentCount: number;         // how many agents in this direction
}

// ─────────────────────────────────────────────
// Capital types
// ─────────────────────────────────────────────

export interface Portfolio {
  // userId:           string;
  totalValue:       number;         // total in USDT
  availableValue:   number;         // not allocated to open trades
  allocatedValue:   number;         // locked in open positions
  reserveValue:     number;         // the 15% untouched reserve
  lastUpdatedAt:    Date;
}

export interface AgentCapital {
  agentId:          string;
  allocationPct:    number;         // % of portfolio
  allocationValue:  number;         // $ value
  inUseValue:       number;         // locked in open trade
  availableValue:   number;         // free to trade
}

// ─────────────────────────────────────────────
// Learning types
// ─────────────────────────────────────────────

export interface TradeLessonInput {
  agentId:         string;
  tradeId:         string;
  pair:            string;
  outcome:         'win' | 'loss';
  patternTag:      string;
  primaryReason:   string;
  ruleToAdd:       string;
  verdict:         string;
  marketRegime:    string;
  rsiAtEntry:      number;
  trendAtEntry:    string;
  volumeRatio:     number;
  newsAtEntry:     string | null;
  avoidable:       boolean;
}

export interface RelevantLesson {
  patternTag:      string;
  ruleToAdd:       string;
  primaryReason:   string;
  frequency:       number;
  similarity?:     number;          // set when using vector search
}

// ─────────────────────────────────────────────
// Backtest types
// ─────────────────────────────────────────────

export interface BacktestConfig {
  agentId:         string;
  pair:            string;
  startDate:       Date;
  endDate:         Date;
  initialCapital:  number;
  allocationPct:   number;
  riskPct:         number;
}

export interface BacktestResult {
  config:               BacktestConfig;
  totalTrades:          number;
  winRate:              number;       // 0-1
  profitFactor:         number;       // gross wins / gross losses
  netPnlPct:            number;       // total % return
  maxDrawdownPct:       number;
  sharpeRatio:          number;
  avgTradeDurationHrs:  number;
  monthlyReturns:       MonthlyReturn[];
  trades:               BacktestTrade[];
}

export interface MonthlyReturn {
  month:     string;    // e.g. "2025-01"
  returnPct: number;
  trades:    number;
}

export interface BacktestTrade {
  openTime:    Date;
  closeTime:   Date;
  direction:   'LONG' | 'SHORT';
  entry:       number;
  exit:        number;
  pnlPct:      number;
  outcome:     'win' | 'loss';
  reasoning:   string;
}

// ─────────────────────────────────────────────
// Notification types
// ─────────────────────────────────────────────

export type NotificationLevel = 'info' | 'success' | 'warning' | 'critical';

export interface Notification {
  level:    NotificationLevel;
  agentId:  string | null;
  title:    string;
  body:     string;
  sentAt:   Date;
}