/**
 * `planTrade` — the domain-routed entry point (§35, Part III §4, Part II §10).
 *
 * Consumes a *finished* Signal; never re-derives one. The Signal Engine (M4) already produced the
 * direction — the planner's job is to add entry, SL, TP, size and (perp) leverage, or refuse.
 */
import { marketSymbol, ValidationError } from '@tip/domain';
import type { AsOfMarketData } from '@tip/evaluation';
import type { Domain, ScoringConfig, TradingStyle } from '@tip/trading-agents';
import { planMemecoin } from './memecoin.js';
import { planPerp } from './perp.js';
import type { HeldPosition } from './correlation.js';
import { tradeDirection, type PlanResult, type SignalDirection } from './types.js';

export interface SignalInput {
  symbol: string;
  domain: Domain;
  direction: SignalDirection;
}

export interface PlanContext {
  style: TradingStyle;
  config: ScoringConfig;
  configVersion: number;
  balance: number;
  view?: AsOfMarketData;      // perp — market-structure derivation
  fillPrice?: number;         // memecoin — observed fill at signal time
  plannedAt?: Date;           // memecoin only; perp uses view.asOf
  maintenanceMarginRate?: number;
  exchangeMaxLeverage?: number;
  /** §37 maxCorrelatedExposure gate (audit #14) — the caller's current holdings. */
  heldPositions?: readonly HeldPosition[];
}

export async function planTrade(signal: SignalInput, ctx: PlanContext): Promise<PlanResult> {
  const dir = tradeDirection(signal.direction);
  if (!dir) throw new ValidationError('planTrade: NEUTRAL signals never reach the planner');

  if (signal.domain === 'perp') {
    if (!ctx.view) throw new ValidationError('perp planner requires an AsOfMarketData view');
    return planPerp({
      symbol: marketSymbol(signal.symbol), direction: dir, style: ctx.style, config: ctx.config,
      configVersion: ctx.configVersion, balance: ctx.balance, view: ctx.view,
      ...(ctx.maintenanceMarginRate !== undefined ? { maintenanceMarginRate: ctx.maintenanceMarginRate } : {}),
      ...(ctx.exchangeMaxLeverage !== undefined ? { exchangeMaxLeverage: ctx.exchangeMaxLeverage } : {}),
      ...(ctx.heldPositions !== undefined ? { heldPositions: ctx.heldPositions } : {}),
    });
  }

  if (dir === 'SHORT') throw new ValidationError('memecoin: spot / long-only (§18)');
  if (ctx.fillPrice === undefined || !ctx.plannedAt) {
    throw new ValidationError('memecoin planner requires fillPrice + plannedAt');
  }
  return planMemecoin({
    symbol: marketSymbol(signal.symbol), direction: 'LONG', style: ctx.style, config: ctx.config,
    configVersion: ctx.configVersion, balance: ctx.balance,
    fillPrice: ctx.fillPrice, plannedAt: ctx.plannedAt,
  });
}
