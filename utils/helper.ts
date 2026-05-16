import { TradingStyle } from "../types/agent.types";
import { EntrySignal } from "../types/claude.types";
import { OpenTrade } from "../types/trade.types";

export function mapToOpenTrade(dbTrade: any): OpenTrade {
  return {
    id: dbTrade.id,
    agentId: dbTrade.agentId, // Added: Ensure this field exists on your DB object
    mode: dbTrade.mode,       // Added: Ensure this field exists on your DB object
    
    pair: dbTrade.pair,
    direction: dbTrade.direction,
    entryPrice: dbTrade.entryPrice,

    // map fields properly
    currentSl: dbTrade.stopLoss,
    currentTp: dbTrade.takeProfit,

    positionSize: dbTrade.size,
    positionValue: dbTrade.size * dbTrade.entryPrice,

    openedAt: dbTrade.openedAt,

    // derived / defaults
    unrealisedPct: 0,
    unrealisedPnl: 0,

    entryReasoning: dbTrade.entryReasoning || '', 
  };
}

export function calculateManagementTimeout(style: TradingStyle): string {
  const minutes = {
    scalp:    15,
    swing:    30,
    position: 30,
    auto:     20,
  }[style] ?? 20;

  return new Date(Date.now() + minutes * 60_000).toISOString();
}

// System-controlled entry expiry. The LLM has repeatedly emitted entry_expiry
// values in the past (or so close to "now" that free-tier latency expires them
// before the response lands). We trust the LLM to choose tradeStyle, but the
// clock belongs to the bot — same pattern as calculateManagementTimeout.
export function calculateEntryExpiry(style: TradingStyle | string | null | undefined): string {
  const minutes = {
    scalp:    45,     // 45 min — enough for the next 5-10 candles on 5m
    swing:    240,    // 4 hours
    position: 1440,   // 24 hours
    auto:     120,    // 2 hours
  }[style as TradingStyle] ?? 120;

  return new Date(Date.now() + minutes * 60_000).toISOString();
}