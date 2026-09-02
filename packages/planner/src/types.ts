/**
 * Trade Planner types (§35, Part III §4, Part II §10). The Planner's contract with the Paper
 * Engine (change 3): a `PlanResult` is either a fully-formed setup or a first-class NO_TRADE.
 *
 * NO_TRADE is a returned RESULT, not a thrown error — a directionally-correct signal that fails
 * the R:R gate is a normal, expected outcome (Part III §4 says so explicitly), and modelling it
 * as an exception would make the common case look like a fault in logs and metrics.
 */
import type { Domain } from '@tip/trading-agents';

export type Horizon = '5m' | '15m' | '30m' | '1h' | '4h' | 'EOD' | '1d' | '3d' | '1w';

export interface TradeSetup {
  symbol: string;
  domain: Domain;
  direction: 'LONG' | 'SHORT';
  entryType: 'MARKET' | 'LIMIT'; // memecoin is always MARKET (Part II §10)
  entry: number;
  stopLoss: number;
  /** Null when a profit ladder is configured (Part II §10 — TP and ladder are mutually exclusive). */
  takeProfit: number | null;
  riskReward: number;
  positionSize: number;
  notional: number;
  /** perp only. */
  leverage: number | null;
  requiredMargin: number | null;
  /** The planning horizon — the middle of the style's three (§8). */
  horizon: Horizon;
  plannedAt: Date;
  /** rule 16 — carried into the Prediction so track records never blend across configs. */
  configVersion: number;
}

export type NoTradeReason =
  | 'INSUFFICIENT_RR'
  | 'CANNOT_SIZE_SAFELY'
  | 'NO_STOP_DERIVABLE'
  | 'STALE_OR_MISSING_DATA';

export type PlanResult =
  | { kind: 'TRADE'; setup: TradeSetup }
  | { kind: 'NO_TRADE'; reason: NoTradeReason; detail: string };

/**
 * The direction of a signal after m4-scoring's threshold pass. Any long-side maps to LONG,
 * any short-side to SHORT; NEUTRAL never reaches the planner (§35: no planning without a
 * direction).
 */
export type SignalDirection =
  | 'STRONG_LONG' | 'LONG' | 'WEAK_LONG'
  | 'NEUTRAL'
  | 'WEAK_SHORT' | 'SHORT' | 'STRONG_SHORT';

export function tradeDirection(d: SignalDirection): 'LONG' | 'SHORT' | null {
  if (d === 'NEUTRAL') return null;
  return d.endsWith('LONG') ? 'LONG' : 'SHORT';
}
