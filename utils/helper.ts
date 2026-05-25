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
    leverage: dbTrade.leverage ?? 10,
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

// Style-based default durations for entry validity. Used as the fallback when
// the LLM doesn't supply `entry_expiry_minutes`, and as the basis for clamping.
export function entryExpiryMinutesForStyle(style: TradingStyle | string | null | undefined): number {
  return ({
    scalp:    45,     // ~10 candles on 5m
    swing:    240,    // 4 hours
    position: 1440,   // 24 hours
    auto:     120,    // 2 hours
  } as Record<string, number>)[style as string] ?? 120;
}

// Default duration for NO_TRADE watch periods. The LLM can override via
// `triggers.timeout_minutes` (clamped). 30 min keeps re-analysis frequent
// enough to catch structure changes without burning API calls in dead markets.
export const WATCH_TIMEOUT_DEFAULT_MINUTES = 30;

// Clamp LLM-supplied minute values to safe bounds. The LLM can't reliably emit
// absolute timestamps (no clock), so we have it emit a duration and bound it
// here. Null / non-finite / non-positive values fall back to defaultMinutes.
export function clampMinutes(
  llmMinutes: number | null | undefined,
  defaultMinutes: number,
  options: { min?: number; maxMultiplier?: number } = {},
): number {
  const min = options.min ?? 5;
  const max = defaultMinutes * (options.maxMultiplier ?? 2);

  if (llmMinutes == null || !Number.isFinite(llmMinutes) || llmMinutes <= 0) {
    return defaultMinutes;
  }
  return Math.max(min, Math.min(max, Math.floor(llmMinutes)));
}