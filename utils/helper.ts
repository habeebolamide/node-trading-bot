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