import { prisma } from '../lib/prisma';
import { AgentCapital, Portfolio } from '../types/risk.types';

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

export async function getPortfolio(): Promise<Portfolio> {
  const initialCapital = parseFloat(process.env.INITIAL_CAPITAL ?? '1000');

  const agents = await prisma.agent.findMany({
    select: { id: true },
  });

  const agentIds = agents.map(a => a.id);

  const result = await prisma.trade.aggregate({
    where: {
      agentId: { in: agentIds },
      status:  'closed',
    },
    _sum: { realizedPnL: true },
  });

  const totalPnl   = result._sum.realizedPnL ?? 0;
  const totalValue = initialCapital + totalPnl;

  // Sum value locked in open trades
  const openTrades = await prisma.trade.findMany({
    where: {
      agentId: { in: agentIds },
      status:  'open',
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
  const winRate    = tradeCount > 0 ? winCount / tradeCount : 0;

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
    winRate:    round(winRate, 4),
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