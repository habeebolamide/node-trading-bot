import ccxt from 'ccxt';
import { prisma } from '../lib/prisma.js';
import type { AgentCapital, Portfolio } from '../types/risk.types.js';
import type { ChallengePortfolio, ChallengeSessionRecord } from '../types/challenge.types.js';
import logger from '../utils/logger.js';

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const RESERVE_PERCENT    = 0.15;  // 15% always untouched
const MAX_ALLOCATION_PCT = 0.85;  // agents can only use 85% total

// ─────────────────────────────────────────────
// Portfolio tracker
// Single source of truth for portfolio value
// Used by risk layer for position sizing
// ─────────────────────────────────────────────


// ─────────────────────────────────────────────
// Fetch real balance from Bybit
// Used by capital allocator in live mode
// ─────────────────────────────────────────────

const exchange = new ccxt.bybit({
  apiKey: process.env.BYBIT_API_KEY ?? '',
  secret: process.env.BYBIT_SECRET ?? '',
  options: {
    defaultType: 'linear',
  },
  ...(process.env.BYBIT_TESTNET === 'true' && {
    urls: {
      api: {
        public: 'https://api.bybit.com',
        private: 'https://api.bybit.com',
      },
    },
  }),
});

export async function fetchBybitBalance(): Promise<number> {
  try {
    const balance = await exchange.fetchBalance({ type: 'unified' });
    const usdt = balance['USDT']?.free ?? 0;

    logger.info('Bybit balance fetched', { usdt });
    return usdt;
  } catch (error: any) {
    logger.error('Failed to fetch Bybit balance', { error: error.message });
    throw error;
  }
}

export async function getPortfolio(): Promise<Portfolio> {

  const isTestnet = process.env.BYBIT_TESTNET === 'true';
  const initialCapital = isTestnet
    ? parseFloat(process.env.INITIAL_CAPITAL ?? '1000')
    : await fetchBybitBalance();

  const agents = await prisma.agent.findMany({
    select: { id: true },
  });

  const agentIds = agents.map(a => a.id);

  // ─── Challenge carve-out ───
  // When a challenge session is active, its starting capital is excluded
  // from the main pool's totalValue and its realised + open trades are
  // excluded from main P&L / allocation. Frozen carve-out — main agents
  // see a stable pool, unaffected by challenge swings. Once a session ends
  // (status != active), the filter stops applying and the bucket's
  // realisedPnL folds back into the main pool automatically.
  const activeSessions = await prisma.challengeSession.findMany({
    where:  { status: 'active' },
    select: { id: true, startingCapital: true },
  });

  const activeSessionIds = activeSessions.map(s => s.id);
  const carvedOut        = activeSessions.reduce((sum, s) => sum + s.startingCapital, 0);

  const result = await prisma.trade.aggregate({
    where: {
      agentId: { in: agentIds },
      status:  'closed',
      ...(activeSessionIds.length > 0
        ? { challengeId: { notIn: activeSessionIds } }
        : {}),
    },
    _sum: { realizedPnL: true },
  });

  const totalPnl   = result._sum?.realizedPnL ?? 0;
  // Subtract the frozen carve-out so main agents do not "see" the bucketed capital.
  // Math.max guard: if user has only $4 and a $4 challenge, main pool is exactly 0
  // — but a misconfigured Bybit balance below the carve-out shouldn't go negative.
  const totalValue = Math.max(0, initialCapital + totalPnl - carvedOut);

  // Sum value locked in open trades — excluding open challenge trades.
  const openTrades = await prisma.trade.findMany({
    where: {
      agentId: { in: agentIds },
      status:  'open',
      ...(activeSessionIds.length > 0
        ? { challengeId: { notIn: activeSessionIds } }
        : {}),
    },
    select: { size: true, entryPrice: true },
  });

  const allocatedValue = openTrades.reduce(
    (sum, t) => sum + t.size * t.entryPrice,
    0,
  );

  const reserveValue   = totalValue * RESERVE_PERCENT;
  const availableValue = Math.max(0, totalValue - allocatedValue - reserveValue);

  return {
    totalValue:      round(totalValue),
    availableValue:  round(availableValue),
    allocatedValue:  round(allocatedValue),
    reserveValue:    round(reserveValue),
    lastUpdatedAt:   new Date(),
  };
}

// ─────────────────────────────────────────────
// Challenge portfolio
// Isolated bucket view scoped to a single session — used by the challenge
// agent's entry/exit cycle in place of getPortfolio(). No reserve carve-out
// (every dollar must be deployable inside the bucket). Equity is
// startingCapital + realised challenge PnL + open challenge trade unrealised.
// ─────────────────────────────────────────────

export async function getChallengePortfolio(
  session: ChallengeSessionRecord | { id: string; startingCapital: number },
): Promise<ChallengePortfolio> {
  // Realised PnL from closed challenge trades.
  const realisedResult = await prisma.trade.aggregate({
    where:  { challengeId: session.id, status: 'closed' },
    _sum:   { realizedPnL: true },
  });
  const realisedPnL = realisedResult._sum?.realizedPnL ?? 0;

  // Open challenge trade (max one per agent given the existing single-trade-
  // per-agent constraint) — use its in-DB unrealisedPnl which is kept current
  // by updateLivePnl (throttled writes, accurate within ~10s).
  const openTrade = await prisma.trade.findFirst({
    where:  { challengeId: session.id, status: 'open' },
    select: { size: true, entryPrice: true, unrealisedPnl: true },
  });

  const unrealisedPnL  = openTrade?.unrealisedPnl ?? 0;
  const allocatedValue = openTrade ? openTrade.size * openTrade.entryPrice : 0;
  const equity         = session.startingCapital + realisedPnL + unrealisedPnL;

  // No reserve carve-out — every dollar in the bucket is deployable.
  const availableValue = Math.max(0, equity - allocatedValue);

  return {
    sessionId:       session.id,
    totalValue:      round(equity),
    availableValue:  round(availableValue),
    allocatedValue:  round(allocatedValue),
    reserveValue:    0,
    startingCapital: round(session.startingCapital),
    realisedPnL:     round(realisedPnL),
    unrealisedPnL:   round(unrealisedPnL),
    lastUpdatedAt:   new Date(),
  };
}

// ─────────────────────────────────────────────
// Raw account total — used by pre-flight INSUFFICIENT_FUNDS check.
// Bypasses the challenge carve-out filter so it reflects what's actually on
// Bybit (or INITIAL_CAPITAL in testnet) before deciding whether a new
// session's startingCapital fits.
// ─────────────────────────────────────────────

export async function getRawAccountTotal(): Promise<number> {
  const isTestnet = process.env.BYBIT_TESTNET === 'true';
  const initialCapital = isTestnet
    ? parseFloat(process.env.INITIAL_CAPITAL ?? '1000')
    : await fetchBybitBalance();

  const result = await prisma.trade.aggregate({
    where: { status: 'closed' },
    _sum:  { realizedPnL: true },
  });

  return initialCapital + (result._sum?.realizedPnL ?? 0);
}

// ─────────────────────────────────────────────
// Agent capital breakdown
// How much a specific agent controls and
// how much of that is free vs in a trade
// ─────────────────────────────────────────────

export async function getAgentCapital(
  agentId:        string,
  allocationPct:  number,
  portfolio:      Portfolio,
): Promise<AgentCapital> {
  const allocationValue = portfolio.totalValue * (allocationPct / 100);

  // Check if agent has an open trade
  const openTrade = await prisma.trade.findFirst({
    where:  { agentId, status: 'open' },
    select: { size: true, entryPrice: true },
  });

  const inUseValue     = openTrade ? openTrade.size * openTrade.entryPrice : 0;
  const availableValue = Math.max(0, allocationValue - inUseValue);

  return {
    agentId,
    allocationPct,
    allocationValue: round(allocationValue),
    inUseValue:      round(inUseValue),
    availableValue:  round(availableValue),
  };
}

// ─────────────────────────────────────────────
// Allocation validator
// Ensures total agent allocations never exceed 85%
// Called when creating or updating an agent
// ─────────────────────────────────────────────

export async function validateAllocation(
  userId:        string,
  newPercent:    number,
  excludeAgentId?: string,
): Promise<{ valid: boolean; available: number; message: string }> {
  const agents = await prisma.agent.findMany({
    where: {
      status: { not: 'stopped' },
      ...(excludeAgentId ? { id: { not: excludeAgentId } } : {}),
    },
    select: { allocationPercent: true },
  });

  const currentTotal = agents.reduce((sum, a) => sum + a.allocationPercent, 0);
  const maxAllowed   = MAX_ALLOCATION_PCT * 100; // 85
  const available    = Math.max(0, maxAllowed - currentTotal);
  const newTotal     = currentTotal + newPercent;

  if (newTotal > maxAllowed) {
    return {
      valid:     false,
      available: round(available),
      message:   `Allocation would reach ${newTotal.toFixed(1)}% — max is ${maxAllowed}%. Available: ${available.toFixed(1)}%`,
    };
  }

  return {
    valid:     true,
    available: round(available - newPercent),
    message:   'Allocation valid',
  };
}

// ─────────────────────────────────────────────
// Monthly performance summary
// Used by risk layer to determine performance mode
// and by dashboard for reporting
// ─────────────────────────────────────────────

export async function getMonthlyPerformance(
  agentId: string,
): Promise<{
  pnlAmount:  number;
  pnlPercent: number;
  tradeCount: number;
  winCount:   number;
  winRate:    number;
}> {
  const monthStart = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1,
  );

  const trades = await prisma.trade.findMany({
    where: {
      agentId,
      status:   'closed',
      closedAt: { gte: monthStart },
    },
    select: {
      realizedPnL: true,
      entryPrice:  true,
      size:        true,
    },
  });

  const pnlAmount  = trades.reduce((sum, t) => sum + (t.realizedPnL ?? 0), 0);
  const winCount   = trades.filter(t => (t.realizedPnL ?? 0) > 0).length;
  const tradeCount = trades.length;
  // Returned as a percentage (0-100), not a 0-1 fraction.
  const winRate    = tradeCount > 0 ? (winCount / tradeCount) * 100 : 0;

  // P&L as % of agent's allocated capital
  const initialCapital  = parseFloat(process.env.INITIAL_CAPITAL ?? '1000');
  const agent           = await prisma.agent.findUnique({
    where:  { id: agentId },
    select: { allocationPercent: true },
  });

  const agentCapital = initialCapital * ((agent?.allocationPercent ?? 10) / 100);
  const pnlPercent   = agentCapital > 0 ? (pnlAmount / agentCapital) * 100 : 0;

  return {
    pnlAmount:  round(pnlAmount),
    pnlPercent: round(pnlPercent),
    tradeCount,
    winCount,
    winRate:    round(winRate, 2),
  };
}

// ─────────────────────────────────────────────
// Full portfolio summary across all agents
// Used by dashboard overview page
// ─────────────────────────────────────────────

export async function getPortfolioSummary() {
  const portfolio = await getPortfolio();

  const agents = await prisma.agent.findMany({
    // where: { userId },
    select: {
      id:                true,
      name:              true,
      pair:              true,
      allocationPercent: true,
      status:            true,
    },
  });

  const agentSummaries = await Promise.all(
    agents.map(async agent => {
      const capital     = await getAgentCapital(agent.id, agent.allocationPercent, portfolio);
      const performance = await getMonthlyPerformance(agent.id);

      return {
        ...agent,
        capital,
        monthlyPerformance: performance,
      };
    }),
  );

  const totalAllocationPct = agents.reduce((sum, a) => sum + a.allocationPercent, 0);

  return {
    portfolio,
    agents:           agentSummaries,
    totalAllocation:  round(totalAllocationPct),
    reservePct:       RESERVE_PERCENT * 100,
    availablePct:     round(MAX_ALLOCATION_PCT * 100 - totalAllocationPct),
  };
}

// ─────────────────────────────────────────────
// Util
// ─────────────────────────────────────────────

function round(value: number, decimals = 2): number {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}