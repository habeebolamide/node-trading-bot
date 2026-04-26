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