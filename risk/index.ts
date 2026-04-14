import { Agent, AgentRuntimeState } from '../types/agent.types';
import { EntrySignal, ManagementDecision } from '../types/claude.types';
import { CircuitBreakerState, CorrelationSnapshot, DrawdownState, PerformanceMode, Portfolio, ValidationResult } from '../types/risk.types';
import logger from '../utils/logger';
import { prisma } from "../lib/prisma";



// ─────────────────────────────────────────────
// Config — tune these after backtesting
// ─────────────────────────────────────────────

const LIMITS = {
  monthlyDrawdownCap: 0.10,  // 10% — all agents pause beyond this
  dailyDrawdownCap: 0.05,  // 5%  — agent pauses for rest of day
  maxCorrelatedTrades: 2,     // max agents in same direction same pair
  minConfidence: 7,     // Claude confidence below this = blocked
  maxSpreadPct: 0.005, // 0.5% spread — market too illiquid
  maxPriceMove5m: 0.03,  // 3% move in 5 mins = circuit breaker
  maxVolatilityRatio: 3.0,   // volume 3x average = circuit breaker
  recoveryModeThreshold: 0.05,  // -5% monthly triggers recovery mode
  conservativeThreshold: 0.07,  // -7% monthly triggers conservative mode
  growthModeThreshold: 0.05,  // +5% monthly triggers growth mode
  cooldownAfterLoss: 2,     // candles to wait after a loss
};

// ─────────────────────────────────────────────
// In-memory circuit breaker state
// ─────────────────────────────────────────────

let circuitBreaker: CircuitBreakerState = {
  isTripped: false,
  tripReason: null,
  trippedAt: null,
  resumeAt: null,
  priceMove5m: 0,
  spreadPct: 0,
  volumeRatio: 1,
};

// ─────────────────────────────────────────────
// Main validator — called before every trade action
// Returns approved + calculated position size
// or blocked + reason
// ─────────────────────────────────────────────

export async function validateEntrySignal(
  signal: EntrySignal,
  agent: Agent,
  runtime: AgentRuntimeState,
  portfolio: Portfolio,
): Promise<ValidationResult> {

  // ── 1. Circuit breaker ──
  if (circuitBreaker.isTripped) {
    return block('CIRCUIT_BREAKER', `Market halted: ${circuitBreaker.tripReason}`);
  }

  // ── 2. No trade signal ──
  if (signal.action === 'NO_TRADE') {
    return block('LOW_CONFIDENCE', 'Claude returned NO_TRADE');
  }

  if (signal.entry == null || signal.sl == null) {
    return block('INVALID_SIGNAL', 'Missing entry or SL price — rejecting signal');
  }

  if (signal.action === 'LONG' && signal?.sl >= signal.entry) {
    return block('INVALID_SIGNAL', 'Invalid SL placement — rejecting signal');
  }

  if (signal.action === 'SHORT' && signal.sl <= signal.entry) {
    return block('INVALID_SIGNAL', 'Invalid SL placement — rejecting signal');
  }

  // ── 3. Confidence threshold ──
  if (signal.confidence < LIMITS.minConfidence) {
    return block('LOW_CONFIDENCE', `Confidence ${signal.confidence} below minimum ${LIMITS.minConfidence}`);
  }

  // ── 4. Monthly drawdown cap ──
  const drawdown = await getDrawdownState(agent.id);
  if (drawdown.monthlyPnlPct <= -LIMITS.monthlyDrawdownCap) {
    return block('MONTHLY_CAP_HIT', `Monthly drawdown ${(drawdown.monthlyPnlPct * 100).toFixed(1)}% hit cap`);
  }

  // ── 5. Daily drawdown cap ──
  if (drawdown.dailyPnlPct <= -LIMITS.dailyDrawdownCap) {
    return block('DAILY_CAP_HIT', `Daily drawdown ${(drawdown.dailyPnlPct * 100).toFixed(1)}% hit cap`);
  }

  // ── 6. Correlation guard ──
  const correlation = await getCorrelationSnapshot(signal, agent.id);
  if (correlation.activeAgentCount >= LIMITS.maxCorrelatedTrades) {
    return block(
      'CORRELATION_LIMIT',
      `${correlation.activeAgentCount} agents already ${signal.action} on ${signal.action === 'LONG' ? 'long' : 'short'} ${agent.pair}`
    );
  }

  // ── 7. Cooldown after consecutive losses ──
  if (runtime.cooldownUntil && new Date() < runtime.cooldownUntil) {
    return block('COOLDOWN_ACTIVE', 'Agent in cooldown after consecutive losses');
  }

  // ── 8. Recovery mode — only A+ setups ──
  if (drawdown.performanceMode === 'RECOVERY' && signal.confidence < 9) {
    return block('RECOVERY_MODE_FILTER', 'Recovery mode requires confidence 9+');
  }

  // ── 9. Conservative mode — tighten confidence ──
  if (drawdown.performanceMode === 'CONSERVATIVE' && signal.confidence < 8) {
    return block('RECOVERY_MODE_FILTER', 'Conservative mode requires confidence 8+');
  }

  // ── 10. Calculate position size ──
  const positionSize = calculatePositionSize(signal, agent, portfolio, drawdown.performanceMode);

  if (positionSize <= 0) {
    return block('INSUFFICIENT_CAPITAL', 'Calculated position size is zero');
  }

  logger.info('Signal approved', {
    agentId: agent.id,
    pair: agent.pair,
    action: signal.action,
    confidence: signal.confidence,
    positionSize,
  });

  return {
    approved: true,
    blockReason: null,
    positionSize,
    message: 'Approved',
  };
}

// ─────────────────────────────────────────────
// Validate management decision
// Lighter checks — trade is already open
// ─────────────────────────────────────────────

export function validateManagementDecision(
  decision: ManagementDecision,
  currentSl: number,
  newSl: number | null,
  direction: 'LONG' | 'SHORT',
): ValidationResult {

  // Never widen SL
  if (newSl !== null) {
    const isWidening =
      direction === 'LONG' ? newSl < currentSl :
        direction === 'SHORT' ? newSl > currentSl :
          false;

    if (isWidening) {
      logger.warn('Rejected SL widening attempt', { currentSl, newSl, direction });
      // Override — keep current SL, change action to HOLD
      return {
        approved: true,
        blockReason: null,
        positionSize: null,
        message: 'SL widening rejected — holding current SL',
      };
    }
  }

  return {
    approved: true,
    blockReason: null,
    positionSize: null,
    message: 'Management decision approved',
  };
}

// ─────────────────────────────────────────────
// Position sizing
// Risk amount / distance to SL = position size
// Adjusted for performance mode
// ─────────────────────────────────────────────

export function calculatePositionSize(
  signal: EntrySignal,
  agent: Agent,
  portfolio: Portfolio,
  performanceMode: PerformanceMode,
): number {
  if (!signal.entry || !signal.sl) return 0;

  // How much capital this agent controls
  const agentCapital = portfolio.totalValue * (agent.allocationPercent / 100);

  // Reduce size in conservative/recovery modes
  const sizeMultiplier: Record<PerformanceMode, number> = {
    NORMAL: 1.0,
    GROWTH: 1.0,
    CONSERVATIVE: 0.75,
    RECOVERY: 0.5,
  };

  const adjustedCapital = agentCapital * sizeMultiplier[performanceMode];

  // How much to risk on this trade
  const riskAmount = adjustedCapital * (agent.riskPercent / 100);

  // Distance from entry to stop loss
  const distanceToSl = Math.abs(signal.entry - signal.sl);

  if (distanceToSl === 0) return 0;

  // Position size in base currency units
  const positionSize = riskAmount / distanceToSl;

  // Hard cap — never use more than agent's full allocation
  const maxPositionValue = adjustedCapital;
  const positionValue = positionSize * signal.entry;

  if (positionValue > maxPositionValue) {
    return maxPositionValue / signal.entry;
  }

  // Round to 4 decimal places (crypto precision)
  return Math.round(positionSize * 10_000) / 10_000;
}

// ─────────────────────────────────────────────
// Drawdown tracker
// Reads from DB — accurate across restarts
// ─────────────────────────────────────────────

export async function getDrawdownState(agentId: string): Promise<DrawdownState> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Sum today's P&L
  const dailyTrades = await prisma.trade.findMany({
    where: {
      agentId,
      closedAt: { gte: todayStart },
      status: 'closed',
    },
    select: { realizedPnL: true },
  });

  // Sum this month's P&L
  const monthlyTrades = await prisma.trade.findMany({
    where: {
      agentId,
      closedAt: { gte: monthStart },
      status: 'closed',
    },
    select: { realizedPnL: true },
  });

  const dailyPnl = dailyTrades.reduce((sum, t) => sum + (t.realizedPnL ?? 0), 0);
  const monthlyPnl = monthlyTrades.reduce((sum, t) => sum + (t.realizedPnL ?? 0), 0);

  // Get portfolio value for % calculation
  const portfolio = await getPortfolioValue();

  const dailyPnlPct = portfolio > 0 ? dailyPnl / portfolio : 0;
  const monthlyPnlPct = portfolio > 0 ? monthlyPnl / portfolio : 0;

  const performanceMode = resolvePerformanceMode(monthlyPnlPct);

  return {
    agentId,
    dailyPnlPct,
    monthlyPnlPct,
    peakPortfolioValue: portfolio, // simplified — could track peak separately
    currentDrawdown: Math.min(0, monthlyPnlPct),
    maxDrawdownHit: Math.min(0, monthlyPnlPct),
    performanceMode,
  };
}

// ─────────────────────────────────────────────
// Performance mode resolver
// ─────────────────────────────────────────────

export function resolvePerformanceMode(monthlyPnlPct: number): PerformanceMode {
  if (monthlyPnlPct <= -LIMITS.conservativeThreshold) return 'RECOVERY';
  if (monthlyPnlPct <= -LIMITS.recoveryModeThreshold) return 'CONSERVATIVE';
  if (monthlyPnlPct >= LIMITS.growthModeThreshold) return 'GROWTH';
  return 'NORMAL';
}

// ─────────────────────────────────────────────
// Circuit breaker
// Monitors market conditions — trips on extreme moves
// ─────────────────────────────────────────────

export function updateCircuitBreaker(
  priceMove5m: number,
  spreadPct: number,
  volumeRatio: number,
): void {
  circuitBreaker.priceMove5m = priceMove5m;
  circuitBreaker.spreadPct = spreadPct;
  circuitBreaker.volumeRatio = volumeRatio;

  // Already tripped — check if it should auto-resume
  if (circuitBreaker.isTripped) {
    if (circuitBreaker.resumeAt && new Date() > circuitBreaker.resumeAt) {
      logger.info('Circuit breaker auto-resuming');
      resetCircuitBreaker();
    }
    return;
  }

  // Check trip conditions
  if (priceMove5m > LIMITS.maxPriceMove5m) {
    tripCircuitBreaker(`Price moved ${(priceMove5m * 100).toFixed(1)}% in 5 minutes`, 30);
    return;
  }

  if (spreadPct > LIMITS.maxSpreadPct) {
    tripCircuitBreaker(`Spread ${(spreadPct * 100).toFixed(2)}% too wide`, 15);
    return;
  }

  if (volumeRatio > LIMITS.maxVolatilityRatio) {
    tripCircuitBreaker(`Volume ${volumeRatio.toFixed(1)}x average — unusual activity`, 20);
    return;
  }
}

function tripCircuitBreaker(reason: string, resumeInMinutes: number): void {
  circuitBreaker = {
    ...circuitBreaker,
    isTripped: true,
    tripReason: reason,
    trippedAt: new Date(),
    resumeAt: new Date(Date.now() + resumeInMinutes * 60_000),
  };

  logger.warn('Circuit breaker tripped', { reason, resumeInMinutes });
}

function resetCircuitBreaker(): void {
  circuitBreaker = {
    isTripped: false,
    tripReason: null,
    trippedAt: null,
    resumeAt: null,
    priceMove5m: circuitBreaker.priceMove5m,
    spreadPct: circuitBreaker.spreadPct,
    volumeRatio: circuitBreaker.volumeRatio,
  };
}

export function getCircuitBreakerState(): CircuitBreakerState {
  return { ...circuitBreaker };
}

export function manuallyResetCircuitBreaker(): void {
  resetCircuitBreaker();
  logger.info('Circuit breaker manually reset');
}

// ─────────────────────────────────────────────
// Correlation guard
// Prevents multiple agents piling into same direction
// ─────────────────────────────────────────────

async function getCorrelationSnapshot(
  signal: EntrySignal,
  agentId: string,
): Promise<CorrelationSnapshot> {
  const direction = signal.action === 'LONG' ? 'LONG' : 'SHORT';

  // Count other agents currently in this pair + direction
  const count = await prisma.trade.count({
    where: {
      pair: { contains: signal.action === 'LONG' ? 'USDT' : 'USDT' },
      direction,
      status: 'open',
      agentId: { not: agentId }, // exclude this agent
    },
  });

  return {
    pair: signal.action,
    direction,
    activeAgentCount: count,
  };
}

// ─────────────────────────────────────────────
// Portfolio value — reads from DB
// ─────────────────────────────────────────────

async function getPortfolioValue(): Promise<number> {
  // Sum of all closed trade P&L + initial capital from env
  const initialCapital = parseFloat(process.env.INITIAL_CAPITAL ?? '1000');

  const result = await prisma.trade.aggregate({
    where: { status: 'closed' },
    _sum: { realizedPnL: true },
  });

  return initialCapital + (result._sum.realizedPnL ?? 0);
}

// ─────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────

function block(
  reason: ValidationResult['blockReason'],
  message: string,
): ValidationResult {
  logger.info('Signal blocked', { reason, message });
  return {
    approved: false,
    blockReason: reason,
    positionSize: null,
    message,
  };
}