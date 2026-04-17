import { Candle } from "./market.types";
import { OpenTrade } from "./trade.types";

export type AgentStatus = 'active' | 'paused' | 'stopped';

export type AgentMode = 'backtest' | 'paper' | 'live';

export type AgentState = 'IDLE' | 'IN_TRADE' | 'BLOCKED' | 'COOLDOWN' | 'PENDING_ENTRY';

export type TradingStyle = 'scalp' | 'swing' | 'auto';

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
