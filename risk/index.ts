import type { Agent, AgentRuntimeState } from '../types/agent.types.js';
import type { EntrySignal, ManagementDecision } from '../types/claude.types.js';
import type { CircuitBreakerState, CorrelationSnapshot, DrawdownState, PerformanceMode, Portfolio, ValidationResult } from '../types/risk.types.js';
import type { ChallengeRiskContext } from '../types/challenge.types.js';
import logger from '../utils/logger.js';
import { prisma } from "../lib/prisma.js";



// ─────────────────────────────────────────────
// Config — tune these after backtesting
// ─────────────────────────────────────────────

const LIMITS = {
  monthlyDrawdownCap: 0.10,  // 10% — all agents pause beyond this
  dailyDrawdownCap: 0.05,  // 5%  — agent pauses for rest of day
  maxCorrelatedTrades: 2,     // max agents in same direction same pair
  minConfidence: 6,     // Claude confidence below this = blocked
  maxSpreadPct: 0.005, // 0.5% spread — market too illiquid
  maxPriceMove5m: 0.03,  // 3% move in 5 mins = circuit breaker
  maxVolatilityRatio: 3.0,   // volume 3x average = circuit breaker
  recoveryModeThreshold: 0.05,  // -5% monthly triggers recovery mode
  conservativeThreshold: 0.07,  // -7% monthly triggers conservative mode
  growthModeThreshold: 0.05,  // +5% monthly triggers growth mode
  cooldownAfterLoss: 2,     // candles to wait after a loss
};

// Per-mode reward/risk floor. In drawdown we demand asymmetric payoffs
// rather than rarer high-confidence calls — size shrinks via sizeMultiplier,
// quality is enforced here.
const MIN_RR_BY_MODE: Record<PerformanceMode, number> = {
  NORMAL:       1.0,
  GROWTH:       1.0,
  CONSERVATIVE: 1.8,
  RECOVERY:     2.5,
};

// Per-mode confidence floor — calibration safety net on top of R/R-by-mode.
// Without this, an LLM that over-rates its setups could push thin-confidence
// trades through using only the R/R gate. Floors are generous (well below the
// prompt's "honest 6+" range) to avoid the original problem of over-filtering.
const MIN_CONFIDENCE_BY_MODE: Record<PerformanceMode, number> = {
  NORMAL:       6.0,
  GROWTH:       6.0,
  CONSERVATIVE: 6.5,
  RECOVERY:     7.0,
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
  challengeContext?: ChallengeRiskContext,
): Promise<ValidationResult> {

  // ── 1. Circuit breaker ──
  if (circuitBreaker.isTripped) {
    return block('CIRCUIT_BREAKER', `Market halted: ${circuitBreaker.tripReason}`);
  }

  // ── 2. No trade signal ──
  if (signal.action === 'NO_TRADE') {
    return block('LOW_CONFIDENCE', 'Claude returned NO_TRADE');
  }

  if (signal.entry == null || signal.sl == null || signal.tp == null) {
    return block('INVALID_SIGNAL', 'Missing entry, SL, or TP price — rejecting signal');
  }

  if (signal.action === 'LONG' && signal?.sl >= signal.entry) {
    return block('INVALID_SIGNAL', 'Invalid SL placement — rejecting signal');
  }

  if (signal.action === 'SHORT' && signal.sl <= signal.entry) {
    return block('INVALID_SIGNAL', 'Invalid SL placement — rejecting signal');
  }

  if (signal.action === 'LONG' && signal.tp <= signal.entry) {
    return block('INVALID_SIGNAL', 'TP must be above entry for LONG — rejecting signal');
  }

  if (signal.action === 'SHORT' && signal.tp >= signal.entry) {
    return block('INVALID_SIGNAL', 'TP must be below entry for SHORT — rejecting signal');
  }

  // ── 3. Confidence threshold (mode-independent floor) ──
  if (signal.confidence < LIMITS.minConfidence) {
    return block('LOW_CONFIDENCE', `Confidence ${signal.confidence} below minimum ${LIMITS.minConfidence}`);
  }

  // ── 4. Drawdown / performance mode — challenge-scoped when in challenge ──
  // In challenge mode, drawdown is the bucket's shortfall from startingCapital,
  // not the agent's monthly P&L vs main pool. The session's own maxDrawdownPct
  // serves as the floor; the monthly/daily caps below are bypassed because the
  // bucket's drawdown floor (checked live in updateLivePnl) handles that.
  const drawdown = challengeContext
    ? buildChallengeDrawdownState(agent.id, challengeContext)
    : await getDrawdownState(agent.id);

  if (!challengeContext) {
    // ── 4a. Monthly drawdown cap ──
    if (drawdown.monthlyPnlPct <= -LIMITS.monthlyDrawdownCap) {
      return block('MONTHLY_CAP_HIT', `Monthly drawdown ${(drawdown.monthlyPnlPct * 100).toFixed(1)}% hit cap`);
    }

    // ── 4b. Daily drawdown cap ──
    if (drawdown.dailyPnlPct <= -LIMITS.dailyDrawdownCap) {
      return block('DAILY_CAP_HIT', `Daily drawdown ${(drawdown.dailyPnlPct * 100).toFixed(1)}% hit cap`);
    }
  }

  // ── 5. Correlation guard ──
  const correlation = await getCorrelationSnapshot(signal, agent.id, agent.pair);
  if (correlation.activeAgentCount >= LIMITS.maxCorrelatedTrades) {
    return block(
      'CORRELATION_LIMIT',
      `${correlation.activeAgentCount} agents already ${signal.action} on ${agent.pair}`
    );
  }

  // ── 6. Cooldown after consecutive losses ──
  if (runtime.cooldownUntil && new Date() < runtime.cooldownUntil) {
    return block('COOLDOWN_ACTIVE', 'Agent in cooldown after consecutive losses');
  }

  // ── 7. Mode-aware confidence floor (calibration safety net) ──
  const minConfMode = MIN_CONFIDENCE_BY_MODE[drawdown.performanceMode];
  if (signal.confidence < minConfMode) {
    return block(
      'LOW_CONFIDENCE',
      `Confidence ${signal.confidence} below ${drawdown.performanceMode} floor ${minConfMode}`,
    );
  }

  // ── 8. Risk/reward floor — stricter in degraded performance modes ──
  const risk   = Math.abs(signal.entry - signal.sl);
  const reward = Math.abs(signal.tp   - signal.entry);
  const rr     = risk > 0 ? reward / risk : 0;
  const minRr  = MIN_RR_BY_MODE[drawdown.performanceMode];

  if (rr < minRr) {
    return block(
      'POOR_RISK_REWARD',
      `R/R ${rr.toFixed(2)} below ${drawdown.performanceMode} floor ${minRr.toFixed(2)}`,
    );
  }

  // ── 9. Calculate position size ──
  const positionSize = calculatePositionSize(
    signal,
    agent,
    portfolio,
    drawdown.performanceMode,
    challengeContext,
  );

  if (positionSize <= 0) {
    return block('INSUFFICIENT_CAPITAL', 'Calculated position size is zero');
  }

  // ── 10. Per-trade minimum notional (challenge mode) ──
  // Rejects individual signals whose computed notional falls below the
  // exchange minimum without killing the session. The session-level
  // unwinnable-equity check (in evaluateChallenge) handles the case where
  // the bucket can't ever clear minimum.
  if (challengeContext) {
    const notional = positionSize * signal.entry;
    if (notional < challengeContext.minNotionalFloor) {
      return block(
        'INSUFFICIENT_CAPITAL',
        `Challenge trade notional $${notional.toFixed(2)} below min $${challengeContext.minNotionalFloor}`,
      );
    }
  }

  logger.info('Signal approved', {
    agentId: agent.id,
    pair: agent.pair,
    action: signal.action,
    confidence: signal.confidence,
    positionSize,
    challenge: challengeContext?.sessionId ?? null,
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
  challengeContext?: ChallengeRiskContext,
): number {
  if (!signal.entry || !signal.sl) return 0;

  const sizeMultiplier: Record<PerformanceMode, number> = {
    NORMAL: 1.0,
    GROWTH: 1.0,
    CONSERVATIVE: 0.75,
    RECOVERY: 0.5,
  };

  // ─── Challenge sizing ───
  // Bucket-scoped sizing replaces the global allocationPercent × totalValue
  // math. Notional cap = equity × leverage; risk cap = equity × riskPercent.
  // Performance mode still scales — RECOVERY/CONSERVATIVE shrink the bucket
  // size proportionally, same as outside challenge.
  const agentCapital = challengeContext
    ? challengeContext.equity
    : portfolio.totalValue * (agent.allocationPercent / 100);

  const adjustedCapital = agentCapital * sizeMultiplier[performanceMode];
  const leverage = challengeContext
    ? challengeContext.leverage
    : (agent.leverage ?? 1);

  const riskPct = challengeContext
    ? challengeContext.riskPercent
    : agent.riskPercent;

  const distanceToSl = Math.abs(signal.entry - signal.sl);
  if (distanceToSl === 0) return 0;

  // ─────────────────────────────────────────────
  // 1. MAX POSITION (constrained by the margin-allocation cap)
  // ─────────────────────────────────────────────
  // Challenge mode: maxMarginPct caps how much of the bucket can be locked
  // as margin per trade (e.g. 30% of $5 = $1.50 max). Non-challenge agents
  // default this to 1.0 (no extra cap beyond raw leverage).
  const marginCapFraction = challengeContext?.maxMarginPct ?? 1.0;
  const maxMargin         = adjustedCapital * marginCapFraction;
  const maxPositionValue  = maxMargin * leverage;
  const maxPositionSize   = maxPositionValue / signal.entry;

  // ─────────────────────────────────────────────
  // 1b. RISK CAP — semantics depend on mode
  // ─────────────────────────────────────────────
  // Challenge mode: riskPct is a fraction of the MARGIN allocated for THIS
  //   trade. e.g. maxMarginPct=0.30, riskPct=50 → 50% of the $1.50 allocation
  //   = $0.75 max loss. Nested model the user actually thinks in.
  // Non-challenge agents: riskPct is a fraction of the agent's adjusted
  //   capital (legacy behaviour — main-pool risk is sized vs equity, not
  //   vs margin). Unchanged.
  const maxRisk = challengeContext
    ? maxMargin * (riskPct / 100)
    : adjustedCapital * (riskPct / 100);

  // ─────────────────────────────────────────────
  // 2. RISK AT MAX SIZE
  // ─────────────────────────────────────────────
  const riskAtMaxSize = maxPositionSize * distanceToSl;

  // ─────────────────────────────────────────────
  // 3. IF RISK IS SAFE → USE FULL SIZE
  // ─────────────────────────────────────────────
  if (riskAtMaxSize <= maxRisk) {
    logger.info('Using max size (risk below cap)', {
      agentId: agent.id,
      maxPositionSize,
      riskAtMaxSize,
      maxRisk,
      marginCapFraction,
    });

    return Math.round(maxPositionSize * 10_000) / 10_000;
  }

  // ─────────────────────────────────────────────
  // 4. OTHERWISE → SCALE DOWN TO RISK CAP
  //    Also re-check the margin cap — risk-scaled size could still exceed it
  //    if maxMarginPct < 1 (it usually won't because the bigger size was
  //    already capped above, but defensive math here keeps the invariant).
  // ─────────────────────────────────────────────
  const riskScaledSize    = maxRisk / distanceToSl;
  const safePositionSize  = Math.min(riskScaledSize, maxPositionSize);

  const safePositionValue = safePositionSize * signal.entry;
  const requiredMargin    = safePositionValue / leverage;

  // Safety check — should never fire because maxPositionSize is already
  // capped at adjustedCapital × leverage. Defensive only.
  if (requiredMargin > adjustedCapital) {
    logger.warn('Trade rejected — cannot fit within margin even after scaling', {
      agentId: agent.id,
      requiredMargin,
      adjustedCapital,
    });
    return 0;
  }

  logger.info('Scaled to risk cap', {
    agentId: agent.id,
    safePositionSize,
    actualRisk: safePositionSize * distanceToSl,
    maxRisk,
    requiredMargin,
    marginCapFraction,
  });

  return Math.round(safePositionSize * 10_000) / 10_000;
}

// ─────────────────────────────────────────────
// Drawdown tracker
// Reads from DB — accurate across restarts
// ─────────────────────────────────────────────

export async function getDrawdownState(
  agentId: string,
): Promise<DrawdownState> {
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
  pair:    string,
): Promise<CorrelationSnapshot> {
  const direction = signal.action === 'LONG' ? 'LONG' : 'SHORT';

  // Count OTHER agents currently in the same pair + same direction
  const count = await prisma.trade.count({
    where: {
      pair,
      direction,
      status:  'open',
      agentId: { not: agentId },
    },
  });

  return {
    pair,
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

// ─────────────────────────────────────────────
// Challenge-scoped drawdown state
// Builds a DrawdownState shaped for the bucket so the rest of
// validateEntrySignal doesn't need a separate code path. Performance mode
// here scales off the bucket's drawdown only — never the agent's monthly P&L.
// ─────────────────────────────────────────────

export function buildChallengeDrawdownState(
  agentId: string,
  ctx: ChallengeRiskContext,
): DrawdownState {
  // Treat the bucket's shortfall-from-start as the "monthly" pnl pct that
  // drives mode resolution. drawdownPct is positive (0..1) when behind start.
  // Use the negative form so existing thresholds (-5%, -7%) line up.
  const equityPnlPct = -ctx.drawdownPct;
  const performanceMode = resolvePerformanceMode(equityPnlPct);

  return {
    agentId,
    dailyPnlPct:        equityPnlPct,
    monthlyPnlPct:      equityPnlPct,
    peakPortfolioValue: ctx.startingCapital,
    currentDrawdown:    Math.min(0, equityPnlPct),
    maxDrawdownHit:     Math.min(0, equityPnlPct),
    performanceMode,
  };
}