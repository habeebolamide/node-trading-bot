// ─────────────────────────────────────────────
// Claude types
// ─────────────────────────────────────────────

import type { MarketRegime }  from './market.types';
import type { TradeDirection } from './trade.types';

export type ClaudeModel = 'claude-sonnet-4-5' | 'claude-haiku-4-5-20251001';

export type SignalAction = 'LONG' | 'SHORT' | 'NO_TRADE';

export type ManagementAction = 'HOLD' | 'ADJUST' | 'CLOSE' | 'PARTIAL_CLOSE';

// ─────────────────────────────────────────────
// Timeframe scoring — Claude fills this in
// ─────────────────────────────────────────────

export interface TimeframeScores {
  tf4h:  number;    // -2 to +2
  tf1h:  number;
  tf15m: number;
  tf5m:  number;
  total: number;    // sum — determines signal strength
}

// ─────────────────────────────────────────────
// Entry signal — Claude's response to entry prompt
// ─────────────────────────────────────────────

export interface EntrySignal {
  action:             SignalAction;
  direction:          TradeDirection | null;
  entry:              number | null;
  tp:                 number | null;
  sl:                 number | null;
  confidence:         number;             // 1-10
  timeframeScores:    TimeframeScores;
  regimeConfirmed:    MarketRegime;
  regimeOverride:     boolean;            // did Claude override code's regime?
  regimeReasoning:    string;
  primaryTimeframe:   string;             // which TF drove the decision
  entryTrigger:       string;             // e.g. "15m breakout above 67,400"
  reasoning:          string;             // full explanation
  lessonsApplied:     string[];           // which past lessons Claude used
}

// ─────────────────────────────────────────────
// Management decision — Claude's response to management prompt
// ─────────────────────────────────────────────

export interface ManagementDecision {
  action:         ManagementAction;
  newTp:          number | null;      // only set if action = ADJUST
  newSl:          number | null;      // only set if action = ADJUST
  closePercent:   number | null;      // only set if action = PARTIAL_CLOSE
  reasoning:      string;
  urgency:        'low' | 'medium' | 'high';  // how fast to act
}

// ─────────────────────────────────────────────
// Post-mortem — Claude's loss analysis
// ─────────────────────────────────────────────

export type LossVerdict = 'bad_trade' | 'bad_luck' | 'bad_management';

export interface PostMortemResult {
  primaryReason:   string;
  warningSigns:    string[];
  patternTag:      string;      // e.g. COUNTER_TREND_ENTRY
  ruleToAdd:       string;      // concrete avoidance rule
  verdict:         LossVerdict;
  marketRegime:    MarketRegime;
  avoidable:       boolean;
}

// ─────────────────────────────────────────────
// Claude API call wrapper
// ─────────────────────────────────────────────

export type PromptType = 'entry' | 'management' | 'postmortem' | 'synthesis';

export interface ClaudeCallOptions {
  model:      ClaudeModel;
  promptType: PromptType;
  agentId:    string;
  useCache:   boolean;          // whether to use prompt caching
}

export interface ClaudeCallResult<T> {
  success:      boolean;
  data:         T | null;
  rawResponse:  string;
  tokensUsed:   TokenUsage;
  error:        string | null;
  durationMs:   number;
}

export interface TokenUsage {
  inputTokens:  number;
  outputTokens: number;
  cacheHits:    number;         // cached tokens — cheaper
  totalCost:    number;         // estimated $ cost
}