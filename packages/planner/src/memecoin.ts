/**
 * Memecoin Trade Planner (Part II §10). Deliberately simpler than the perp planner because
 * the wallets ARE the thesis.
 *
 * - MARKET entry only — no zone, no LIMIT, no PENDING_ENTRY. Convergence edge decays within
 *   minutes (§8 memecoin Signal TTL), so waiting for a better price is self-defeating, and an
 *   AMM has no resting-order primitive to wait with. `PENDING_ENTRY` is STRUCTURALLY UNREACHABLE
 *   in this domain and that is expected.
 * - Stop is a fixed percentage of fill — "neither ATR nor structure exists for a token that is
 *   minutes old" — so `|entry − stop| = entry × stopPct` and §35's sizing formula is used
 *   unchanged.
 * - TP is null when a `profitLadder` is configured (mutually exclusive per Part II §10; M4's
 *   `validateScoringConfig` already rejects both together, this planner asserts the invariant).
 * - R:R on a laddered setup is measured against the FIRST rung — the first reward the position
 *   can actually realize. Computing it against the last rung would flatter every laddered setup
 *   past the gate.
 */
import type { MarketSymbol } from '@tip/domain';
import { ValidationError } from '@tip/domain';
import type { ScoringConfig, TradingStyle } from '@tip/trading-agents';
import { positionSize } from './sizing.js';
import { planningHorizon } from './horizons.js';
import type { PlanResult, TradeSetup } from './types.js';

export interface MemecoinPlanInputs {
  symbol: MarketSymbol;                  // the mint (memecoin universes are string mints)
  /** Memecoin is spot / long-only (§18 memecoin note). SHORT is rejected. */
  direction: 'LONG';
  style: TradingStyle;
  config: ScoringConfig;
  configVersion: number;
  balance: number;
  /** Observed fill price at signal time. §20's depth-aware AMM math is the Paper Engine's job. */
  fillPrice: number;
  plannedAt: Date;
}

export function planMemecoin(i: MemecoinPlanInputs): PlanResult {
  if ((i.direction as string) !== 'LONG') {
    throw new ValidationError('memecoin: spot / long-only (§18) — SHORT is not planable');
  }
  if (!i.config.stopPct || i.config.stopPct <= 0 || i.config.stopPct >= 1) {
    return { kind: 'NO_TRADE', reason: 'NO_STOP_DERIVABLE', detail: 'memecoin: stopPct required in (0, 1)' };
  }
  if (i.fillPrice <= 0) {
    return { kind: 'NO_TRADE', reason: 'STALE_OR_MISSING_DATA', detail: 'memecoin: fillPrice must be > 0' };
  }
  if (i.config.takeProfitPct !== undefined && i.config.profitLadder !== undefined && i.config.profitLadder.length > 0) {
    // M4 rejects this at config-write; asserting again is defensive, not duplicated logic —
    // Part II §10 is explicit that the two are mutually exclusive.
    throw new ValidationError('memecoin: takeProfitPct and profitLadder are mutually exclusive (Part II §10)');
  }

  const entry = i.fillPrice;
  const stopLoss = entry * (1 - i.config.stopPct);

  // TP + R:R basis. Under a ladder, TP is null and R:R uses the FIRST rung's multiple.
  let takeProfit: number | null;
  let rewardBasis: number;
  if (i.config.profitLadder && i.config.profitLadder.length > 0) {
    takeProfit = null;
    const firstRung = i.config.profitLadder[0]!.at; // the multiple at rung 0 (e.g. 2.0 → 2× fill)
    rewardBasis = entry * (firstRung - 1);
  } else if (i.config.takeProfitPct !== undefined && i.config.takeProfitPct > 0) {
    takeProfit = entry * (1 + i.config.takeProfitPct);
    rewardBasis = takeProfit - entry;
  } else {
    return { kind: 'NO_TRADE', reason: 'NO_STOP_DERIVABLE', detail: 'memecoin: neither takeProfitPct nor profitLadder configured' };
  }

  const stopDistance = entry - stopLoss; // positive by construction (stopPct < 1)
  const rr = rewardBasis / stopDistance;
  if (rr < i.config.minRR) {
    return { kind: 'NO_TRADE', reason: 'INSUFFICIENT_RR', detail: `R:R ${rr.toFixed(2)} < minRR ${i.config.minRR}` };
  }

  let sizing;
  try {
    sizing = positionSize({ balance: i.balance, riskPercent: i.config.riskPercent, entry, stopLoss, direction: 'LONG' });
  } catch (e) {
    if (e instanceof ValidationError) return { kind: 'NO_TRADE', reason: 'CANNOT_SIZE_SAFELY', detail: e.message };
    throw e;
  }

  // Memecoin is spot — no leverage, no required margin.
  const setup: TradeSetup = {
    symbol: i.symbol, domain: 'memecoin', direction: 'LONG', entryType: 'MARKET',
    entry, stopLoss, takeProfit, riskReward: rr,
    positionSize: sizing.positionSize, notional: sizing.notional,
    leverage: null, requiredMargin: null,
    horizon: planningHorizon(i.style, 'memecoin'),
    plannedAt: i.plannedAt, configVersion: i.configVersion,
  };
  return { kind: 'TRADE', setup };
}
