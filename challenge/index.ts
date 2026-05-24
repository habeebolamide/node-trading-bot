import { prisma } from '../lib/prisma';
import { notifications } from '../utils/notifications';
import logger from '../utils/logger';
import type {
  ChallengeExecutionMode,
  ChallengePromptContext,
  ChallengeRiskContext,
  ChallengeSessionRecord,
  ChallengeStatus,
  StartChallengeConfig,
} from '../types/challenge.types';

// ─────────────────────────────────────────────
// Mappers
// ─────────────────────────────────────────────

function mapSession(row: {
  id: string;
  agentId: string;
  startingCapital: number;
  targetCapital: number;
  maxDrawdownPct: number;
  startsAt: Date;
  endsAt: Date;
  executionMode: string;
  status: string;
  endedAt: Date | null;
  finalEquity: number | null;
  finalReturnPct: number | null;
  failReason: string | null;
  riskPercent: number | null;
  leverage: number | null;
}): ChallengeSessionRecord {
  return {
    id:              row.id,
    agentId:         row.agentId,
    startingCapital: row.startingCapital,
    targetCapital:   row.targetCapital,
    maxDrawdownPct:  row.maxDrawdownPct,
    startsAt:        row.startsAt,
    endsAt:          row.endsAt,
    executionMode:   row.executionMode as ChallengeExecutionMode,
    status:          row.status as ChallengeStatus,
    endedAt:         row.endedAt,
    finalEquity:     row.finalEquity,
    finalReturnPct:  row.finalReturnPct,
    failReason:      row.failReason,
    riskPercent:     row.riskPercent,
    leverage:        row.leverage,
  };
}

// ─────────────────────────────────────────────
// Start / load
// ─────────────────────────────────────────────

export async function startChallenge(
  agentId: string,
  config: StartChallengeConfig,
): Promise<ChallengeSessionRecord> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const existing = await prisma.challengeSession.findFirst({
    where: { agentId, status: 'active' },
  });
  if (existing) {
    throw new Error(`Agent already has an active challenge (${existing.id})`);
  }

  const startsAt = new Date();
  const endsAt   = new Date(startsAt.getTime() + config.durationDays * 24 * 60 * 60 * 1000);

  const session = await prisma.challengeSession.create({
    data: {
      agentId:         agentId,
      startingCapital: config.startingCapital,
      targetCapital:   config.targetCapital,
      maxDrawdownPct:  config.maxDrawdownPct ?? 1.0,
      startsAt,
      endsAt,
      executionMode:   config.executionMode,
      status:          'active',
      riskPercent:     config.riskPercent ?? null,
      leverage:        config.leverage ?? null,
    },
  });

  const mapped = mapSession(session);
  logger.info('Challenge started', {
    challengeId: mapped.id,
    agentId,
    startingCapital: config.startingCapital,
    targetCapital:   config.targetCapital,
    endsAt,
    executionMode:   config.executionMode,
  });

  await notifications.sendChallengeStarted(agent.name, mapped);
  return mapped;
}

export async function getActiveChallenge(
  agentId: string,
): Promise<ChallengeSessionRecord | null> {
  const row = await prisma.challengeSession.findFirst({
    where: { agentId, status: 'active' },
    orderBy: { createdAt: 'desc' },
  });
  return row ? mapSession(row) : null;
}

export async function getChallengeById(
  id: string,
): Promise<ChallengeSessionRecord | null> {
  const row = await prisma.challengeSession.findUnique({ where: { id } });
  return row ? mapSession(row) : null;
}

// ─────────────────────────────────────────────
// Equity
// ─────────────────────────────────────────────

export async function getChallengeEquity(
  session: ChallengeSessionRecord,
): Promise<number> {
  const closed = await prisma.trade.aggregate({
    where: { challengeId: session.id, status: 'closed' },
    _sum:  { realizedPnL: true },
  });

  const closedPnl = closed._sum.realizedPnL ?? 0;

  const openTrade = await prisma.trade.findFirst({
    where: { challengeId: session.id, status: 'open' },
    select: { unrealisedPnl: true },
  });

  const unrealized = openTrade?.unrealisedPnl ?? 0;
  return round(session.startingCapital + closedPnl + unrealized);
}

// ─────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────

export async function evaluateChallenge(
  session: ChallengeSessionRecord,
): Promise<ChallengeStatus> {
  if (session.status !== 'active') {
    return session.status;
  }

  const equity = await getChallengeEquity(session);

  if (equity >= session.targetCapital) {
    await endChallenge(session.id, 'passed', 'Target capital reached');
    return 'passed';
  }

  const failFloor = session.startingCapital * (1 - session.maxDrawdownPct);
  if (equity <= failFloor) {
    await endChallenge(session.id, 'failed', 'Maximum drawdown reached');
    return 'failed';
  }

  if (new Date() >= session.endsAt) {
    await endChallenge(session.id, 'expired', 'Time limit reached');
    return 'expired';
  }

  return 'active';
}

export async function endChallenge(
  sessionId: string,
  status: Exclude<ChallengeStatus, 'active'>,
  reason: string,
): Promise<ChallengeSessionRecord | null> {
  const session = await getChallengeById(sessionId);
  if (!session || session.status !== 'active') {
    return session;
  }

  const equity     = await getChallengeEquity(session);
  const returnPct  = session.startingCapital > 0
    ? ((equity - session.startingCapital) / session.startingCapital) * 100
    : 0;

  const stats = await computeChallengeStats(session.id);

  await prisma.challengeSession.update({
    where: { id: sessionId },
    data: {
      status,
      endedAt:        new Date(),
      finalEquity:    equity,
      finalReturnPct: returnPct,
      failReason:     reason,
      result:         stats as object,
    },
  });

  await prisma.agent.update({
    where: { id: session.agentId },
    data:  { status: 'paused' },
  });

  await teardownAgentRuntime(session.agentId);

  const agent = await prisma.agent.findUnique({
    where:  { id: session.agentId },
    select: { name: true },
  });

  const ended = await getChallengeById(sessionId);
  if (ended && agent) {
    await notifications.sendChallengeEnded(agent.name, ended, reason);
  }

  logger.info('Challenge ended', { sessionId, status, reason, equity, returnPct });
  return ended;
}

async function computeChallengeStats(challengeId: string) {
  const trades = await prisma.trade.findMany({
    where:  { challengeId, status: 'closed' },
    select: { realizedPnL: true, closedAt: true },
  });

  const totalTrades = trades.length;
  const winCount    = trades.filter(t => (t.realizedPnL ?? 0) > 0).length;
  const winRate     = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;
  const netPnl      = trades.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);

  return { totalTrades, winCount, winRate: round(winRate), netPnl: round(netPnl) };
}

// ─────────────────────────────────────────────
// Context builders
// ─────────────────────────────────────────────

export async function buildChallengeRiskContext(
  session: ChallengeSessionRecord,
): Promise<ChallengeRiskContext> {
  const equity = await getChallengeEquity(session);
  const returnPct = session.startingCapital > 0
    ? (equity - session.startingCapital) / session.startingCapital
    : 0;

  const targetReturn = session.targetCapital - session.startingCapital;
  const progressToTarget = targetReturn > 0
    ? (equity - session.startingCapital) / targetReturn
    : 0;

  const msLeft   = Math.max(0, session.endsAt.getTime() - Date.now());
  const daysLeft = msLeft / (24 * 60 * 60 * 1000);

  return {
    sessionId:        session.id,
    startingCapital:  session.startingCapital,
    targetCapital:    session.targetCapital,
    maxDrawdownPct:   session.maxDrawdownPct,
    endsAt:           session.endsAt,
    equity,
    returnPct,
    progressToTarget,
    daysLeft,
  };
}

export async function buildChallengePromptContext(
  session: ChallengeSessionRecord,
): Promise<ChallengePromptContext> {
  const risk = await buildChallengeRiskContext(session);
  const daysTotal = Math.max(
    1,
    (session.endsAt.getTime() - session.startsAt.getTime()) / (24 * 60 * 60 * 1000),
  );

  return {
    startingCapital:  session.startingCapital,
    targetCapital:    session.targetCapital,
    currentEquity:    risk.equity,
    returnPct:        risk.returnPct * 100,
    progressToTarget: risk.progressToTarget * 100,
    daysLeft:         risk.daysLeft,
    daysTotal,
    executionMode:    session.executionMode,
  };
}

export function getEffectiveExecutionMode(
  agentMode: 'paper' | 'live' | 'backtest',
  session: ChallengeSessionRecord | null,
): 'paper' | 'live' {
  if (session?.status === 'active') {
    return session.executionMode;
  }
  return agentMode === 'live' ? 'live' : 'paper';
}

// ─────────────────────────────────────────────
// Hourly tick — expire stale challenges
// ─────────────────────────────────────────────

export async function tickActiveChallenges(): Promise<void> {
  const active = await prisma.challengeSession.findMany({
    where: { status: 'active' },
  });

  for (const row of active) {
    try {
      await evaluateChallenge(mapSession(row));
    } catch (err: any) {
      logger.error('Challenge tick failed', { challengeId: row.id, error: err.message });
    }
  }
}

async function teardownAgentRuntime(agentId: string): Promise<void> {
  try {
    const { agentManager } = await import('../agents');
    const { clearTriggers } = await import('../agents/triggers');
    const { executionEngine } = await import('../execution');

    const runtime = agentManager.getAllAgents().find(a => a.id === agentId);
    if (!runtime) return;

    runtime.status = 'paused';
    await clearTriggers(agentId, { status: 'cancelled', triggeredBy: 'CHALLENGE_END' });

    if (runtime.state === 'IN_TRADE' && runtime.currentTrade) {
      await executionEngine.closeTrade(runtime, runtime.currentTrade, 'CHALLENGE_END');
    } else {
      runtime.setState('IDLE');
    }
  } catch (err: any) {
    logger.error('Challenge runtime teardown failed', { agentId, error: err.message });
  }
}

function round(n: number, d = 4): number {
  return Math.round(n * 10 ** d) / 10 ** d;
}
