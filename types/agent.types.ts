import type { Candle } from "./market.types.js";
import type { OpenTrade } from "./trade.types.js";

export type AgentStatus = 'active' | 'paused' | 'stopped';

export type AgentMode = 'backtest' | 'paper' | 'live';

export type AgentState = 'IDLE' | 'IN_TRADE' | 'BLOCKED' | 'COOLDOWN' | 'PENDING_ENTRY' | 'WATCHING';

export type TradingStyle = 'scalp' | 'swing' | 'position' | 'auto';

export interface Agent {
  id:                string;
  // userId:            string;
  name:              string;
  pair:              string;          // e.g. BTCUSDT
  allocationPercent: number;          // % of total portfolio e.g. 30
  riskPercent:       number;          // % of agent capital per trade e.g. 2
  tradingStyle:      TradingStyle;
  mode:              AgentMode;
  status:            AgentStatus;
  learnedRules:      LearnedRule[];   // synthesised from past losses
  createdAt:         Date;
  updatedAt:         Date;
  leverage:          number;
  maxMarginPct:      number;       // fraction 0..1 — max % of allocated capital as margin per trade
}

export interface AgentRuntimeState {
  agentId:           string;
  state:             AgentState;
  openTrade:         OpenTrade | null;
  candleBuffer:      Candle[];        // last 200 candles in memory
  lastSignalAt:      Date | null;
  cooldownUntil:     Date | null;
  monthlyPnl:        number;          // running % this month
  consecutiveLosses: number;
}

export interface LearnedRule {
  patternTag: string;
  rule:       string;
  frequency:  number;
  createdAt:  Date;
}
