// ─────────────────────────────────────────────
// Trade types
// ─────────────────────────────────────────────

export type TradeDirection = 'LONG' | 'SHORT';

export type TradeStatus = 'open' | 'closed' | 'cancelled';

export type TradeOutcome = 'win' | 'loss' | 'breakeven';

export type CloseReason =
  | 'TP_HIT'
  | 'SL_HIT'
  | 'CLAUDE_CLOSE'
  | 'PARTIAL_CLOSE'
  | 'CIRCUIT_BREAKER'
  | 'MANUAL_CLOSE'
  | 'MONTHLY_CAP';

export interface OpenTrade {
  id:            string;
  agentId:       string;
  pair:          string;
  direction:     TradeDirection;
  entryPrice:    number;
  currentTp:     number;
  currentSl:     number;
  positionSize:  number;          // in base currency units e.g. 0.023 BTC
  positionValue: number;          // in USDT
  unrealisedPnl: number;          // current $ P&L
  unrealisedPct: number;          // current % P&L
  openedAt:      Date;
  entryReasoning: string;         // Claude's reasoning at entry
  mode:          'paper' | 'live';
  leverage:      number;

  // ─── Challenge mode (set when this trade was opened inside an active session) ───
  // challengeBaseline = startingCapital + realised challenge PnL at the moment
  // this trade was opened. Live bucket equity = challengeBaseline + unrealisedPnl.
  // challengeFloor    = absolute $ equity at/below which the drawdown floor breaks.
  // updateLivePnl uses these to fire force-close on breach without re-querying
  // the DB on every ticker tick.
  challengeId?:        string;
  challengeBaseline?:  number;
  challengeFloor?:     number;
}

export interface ClosedTrade extends OpenTrade {
  exitPrice:     number;
  realisedPnl:   number;          // $ P&L
  realisedPct:   number;          // % P&L
  closeReason:   CloseReason;
  outcome:       TradeOutcome;
  closedAt:      Date;
  durationHours: number;
  postMortemId:  string | null;   // links to lesson if loss
}

export interface TradeAdjustment {
  tradeId:    string;
  adjustedAt: Date;
  prevTp:     number;
  newTp:      number;
  prevSl:     number;
  newSl:      number;
  reason:     string;             // Claude's reasoning for adjustment
}

// ─────────────────────────────────────────────
// Execution types
// ─────────────────────────────────────────────

export type OrderType = 'market' | 'limit';

export interface OrderRequest {
  agentId:      string;
  pair:         string;
  direction:    TradeDirection;
  orderType:    OrderType;
  price:        number;           // entry price
  positionSize: number;
  tp:           number;
  sl:           number;
  mode:         'paper' | 'live';
  leverage?:    number
}

export interface OrderResult {
  success:    boolean;
  orderId:    string | null;
  fillPrice:  number | null;
  error:      string | null;
}