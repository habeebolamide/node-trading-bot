// ─────────────────────────────────────────────
// Challenge mode
// Per-agent, time-boxed "flip the bucket" sessions. See guides/CHALLENGE_MODE.md.
//
// Public surface:
//   startChallenge(agent)                 — pre-flight + create session
//   endChallenge(sessionId, status, why)  — finalize, teardown, fold capital back
//   evaluateChallenge(sessionId)          — check terminal states; called per-tick / per-close
//   tickActiveChallenges()                — iterate all active sessions (hourly)
//   reconcileAgentChallengeToggles()      — watch challengeMode boolean flips
//   getActiveChallengeForAgent(agentId)   — fetch active session row
//   buildChallengeRiskContext(session)    — build ChallengeRiskContext from live equity
// ─────────────────────────────────────────────

import { prisma } from '../lib/prisma.js';
import logger from '../utils/logger.js';
import { notifications } from '../utils/notifications.js';
import { getChallengePortfolio, getRawAccountTotal } from '../capital/index.js';
import { clearTriggers, clearTriggerMemory } from '../agents/triggers.js';
import type {
  ChallengeEvaluation,
  ChallengeRiskContext,
  ChallengeSessionRecord,
  ChallengeStartFailureReason,
  ChallengeStatus,
  ChallengeExecutionMode,
  StartChallengeResult,
} from '../types/challenge.types.js';

// ─────────────────────────────────────────────
// Constants
// One-line edits when the floor matures or the broker min changes.
// ─────────────────────────────────────────────

const MIN_STARTING_CAPITAL  = 4;     // TODO: raise to 5 once initial testing is done
const MAX_TARGET_MULTIPLIER = 10;    // target may be at most start × 10
const MIN_NOTIONAL_FLOOR    = 5;     // Bybit linear perp min

// ─────────────────────────────────────────────
// Public: getActiveChallengeForAgent
// Returns the active session (status='active') for the agent, or null.
// ─────────────────────────────────────────────

export async function getActiveChallengeForAgent(
  agentId: string,
): Promise<ChallengeSessionRecord | null> {
  const session = await prisma.challengeSession.findFirst({
    where: { agentId, status: 'active' },
  });
  return session as ChallengeSessionRecord | null;
}

// ─────────────────────────────────────────────
// Public: buildChallengeRiskContext
// Reads the live bucket equity (realised + unrealised) and packages it
// for validateEntrySignal + calculatePositionSize.
// ─────────────────────────────────────────────

export async function buildChallengeRiskContext(
  session: ChallengeSessionRecord,
): Promise<ChallengeRiskContext> {
  const portfolio = await getChallengePortfolio(session);
  const equity    = portfolio.totalValue;

  // Leverage now lives ONLY on the agent — fetch it here and bubble up
  // through the risk context. Single source of truth across the bot.
  const agent = await prisma.agent.findUnique({
    where:  { id: session.agentId },
    select: { leverage: true },
  });
  const leverage = agent?.leverage ?? 10;

  // drawdownPct: shortfall from starting capital, positive when behind.
  // realisedPnLPct: realised gain/loss as fraction of starting capital.
  const drawdownPct   = session.startingCapital > 0
    ? Math.max(0, (session.startingCapital - equity) / session.startingCapital)
    : 0;
  const realisedPnLPct = session.startingCapital > 0
    ? portfolio.realisedPnL / session.startingCapital
    : 0;

  return {
    sessionId:        session.id,
    equity,
    startingCapital:  session.startingCapital,
    targetCapital:    session.targetCapital,
    leverage,
    riskPercent:      session.riskPercent,
    maxDrawdownPct:   session.maxDrawdownPct,
    minNotionalFloor: session.minNotionalFloor,
    maxMarginPct:     (session as { maxMarginPct?: number }).maxMarginPct ?? 0.2,
    // Risk context is only built for ACTIVE sessions, which have non-null
    // endsAt (set during activation). Pending/terminal sessions never reach here.
    endsAt:           session.endsAt ?? new Date(0),
    realisedPnLPct,
    drawdownPct,
  };
}

// ─────────────────────────────────────────────
// Public: startChallenge
// Activates a pending ChallengeSession for an agent. The user creates the
// session row (status='pending') with config; the toggle on Agent.challengeMode
// is the "start" trigger.
//
// Flow:
//   1. Look up the latest pending session for the agent.
//   2. Run all 8 pre-flight checks against the session config.
//   3. On accept: flip session status='active', set startsAt + endsAt, auto-resume agent.
//   4. On reject: flip session status='failed' with failReason, fire start-failed alert.
// ─────────────────────────────────────────────

interface StartChallengeAgentInput {
  id:     string;
  name:   string;
  status: string;
  mode:   string;
}

export async function startChallenge(
  agent: StartChallengeAgentInput,
): Promise<StartChallengeResult> {
  // ── Locate the pending session the user created ──
  const pending = await prisma.challengeSession.findFirst({
    where:   { agentId: agent.id, status: 'pending' },
    orderBy: { createdAt: 'desc' },
  });

  if (!pending) {
    return reject('NO_PENDING_SESSION',
      'No pending ChallengeSession row exists for this agent. Create one in Prisma Studio with status="pending" + your config, then toggle challengeMode again.');
  }

  const startingCapital = pending.startingCapital;
  const targetCapital   = pending.targetCapital;
  const durationDays    = pending.durationDays;

  // Leverage comes from the agent, not the session — single source of truth.
  const agentRow = await prisma.agent.findUnique({
    where:  { id: agent.id },
    select: { leverage: true },
  });
  const leverage = agentRow?.leverage ?? 10;

  // Cheap config-level checks run before any DB or Bybit calls. Order matters
  // for error feedback: catch misconfiguration before we go to the network.

  // ── 1. BELOW_MIN_START ──
  if (startingCapital < MIN_STARTING_CAPITAL) {
    return failPending(pending.id, 'BELOW_MIN_START',
      `Starting capital $${startingCapital} below minimum $${MIN_STARTING_CAPITAL}`);
  }

  // ── 2. BUCKET_TOO_SMALL_FOR_LEVERAGE ──
  if (startingCapital * leverage < MIN_NOTIONAL_FLOOR) {
    return failPending(pending.id, 'BUCKET_TOO_SMALL_FOR_LEVERAGE',
      `$${startingCapital} × ${leverage}× = $${(startingCapital * leverage).toFixed(2)} below min notional $${MIN_NOTIONAL_FLOOR}`);
  }

  // ── 3. INVALID_TARGET ──
  if (targetCapital <= startingCapital) {
    return failPending(pending.id, 'INVALID_TARGET',
      `Target $${targetCapital} must exceed starting capital $${startingCapital}`);
  }

  // ── 4. TARGET_EXCEEDS_MAX_MULTIPLIER ──
  const maxTarget = startingCapital * MAX_TARGET_MULTIPLIER;
  if (targetCapital > maxTarget) {
    return failPending(pending.id, 'TARGET_EXCEEDS_MAX_MULTIPLIER',
      `Target $${targetCapital} exceeds ${MAX_TARGET_MULTIPLIER}× cap ($${maxTarget.toFixed(2)})`);
  }

  // ── 5. INVALID_DURATION ──
  if (durationDays < 1) {
    return failPending(pending.id, 'INVALID_DURATION',
      `Duration ${durationDays} days must be ≥ 1`);
  }

  // ── 6. SESSION_ALREADY_ACTIVE ──
  const existing = await prisma.challengeSession.findFirst({
    where:  { agentId: agent.id, status: 'active' },
    select: { id: true },
  });
  if (existing) {
    return failPending(pending.id, 'SESSION_ALREADY_ACTIVE',
      `Session ${existing.id} is already active for this agent`);
  }

  // ── 7. AGENT_HAS_OPEN_TRADE ──
  const openMainTrade = await prisma.trade.findFirst({
    where:  { agentId: agent.id, status: 'open', challengeId: null },
    select: { id: true },
  });
  if (openMainTrade) {
    return failPending(pending.id, 'AGENT_HAS_OPEN_TRADE',
      `Agent has an open non-challenge trade (${openMainTrade.id}). Wait for it to close, then toggle challengeMode again.`);
  }

  // ── 8. INSUFFICIENT_FUNDS ──
  // Last because it triggers a Bybit call in live mode. Equal-to is allowed.
  const accountTotal = await getRawAccountTotal();
  if (accountTotal < startingCapital) {
    return failPending(pending.id, 'INSUFFICIENT_FUNDS',
      `Account total $${accountTotal.toFixed(2)} below requested starting capital $${startingCapital}`);
  }

  // ── All checks passed — activate ──
  const startsAt = new Date();
  const endsAt   = new Date(startsAt.getTime() + durationDays * 86_400_000);

  const activated = await prisma.$transaction(async (tx) => {
    const updated = await tx.challengeSession.update({
      where: { id: pending.id },
      data: {
        status:   'active',
        startsAt,
        endsAt,
      },
    });
    // Auto-resume paused agents — toggling challengeMode implies "run this."
    if (agent.status === 'paused') {
      await tx.agent.update({
        where: { id: agent.id },
        data:  { status: 'active' },
      });
    }
    return updated;
  });

  const sessionRecord = activated as unknown as ChallengeSessionRecord;

  logger.info('Challenge activated', {
    agentId:         agent.id,
    sessionId:       sessionRecord.id,
    startingCapital,
    targetCapital,
    durationDays,
    executionMode:   pending.executionMode,
  });

  void notifications.sendChallengeStarted(
    { name: agent.name, pair: '' /* filled by caller if needed */ },
    {
      startingCapital,
      targetCapital,
      endsAt,
      leverage,
      riskPercent:   pending.riskPercent,
      executionMode: pending.executionMode,
    },
  );

  return { ok: true, session: sessionRecord };
}

// Helper: pending session rejected by pre-flight. Mark it 'failed' so it
// won't be picked up again on the next toggle attempt, and surface the
// reason so the user can see why in the session row.
async function failPending(
  sessionId: string,
  reason:    ChallengeStartFailureReason,
  detail:    string,
): Promise<StartChallengeResult> {
  await prisma.challengeSession.update({
    where: { id: sessionId },
    data: {
      status:     'failed',
      endedAt:    new Date(),
      failReason: `${reason}: ${detail}`,
    },
  });
  return { ok: false, reason, detail };
}

// Helper: pre-flight rejection that didn't even reach a pending session
// (e.g. NO_PENDING_SESSION). No DB cleanup needed — the toggle reconciler
// flips challengeMode back to false at the caller layer.
function reject(
  reason: ChallengeStartFailureReason,
  detail: string,
): StartChallengeResult {
  return { ok: false, reason, detail };
}

// ─────────────────────────────────────────────
// Public: evaluateChallenge
// Decides whether the session has reached a terminal state. Returns the
// outcome without mutating anything — caller (closeTrade hook, hourly tick,
// reconciler) decides whether to call endChallenge.
//
// Uses bucket equity = startingCapital + realised + unrealised. Live updateLivePnl
// keeps the unrealisedPnl column current, so this is accurate within ~10s.
// ─────────────────────────────────────────────

export async function evaluateChallenge(
  sessionId: string,
): Promise<ChallengeEvaluation> {
  const session = await prisma.challengeSession.findUnique({
    where: { id: sessionId },
  });
  if (!session || session.status !== 'active') {
    return { terminal: false };
  }

  const portfolio = await getChallengePortfolio(session);
  const equity    = portfolio.totalValue;
  const now       = Date.now();

  // ── 1. Expiry ──
  // session.endsAt is non-null for active sessions (set at activation).
  // We guarded above on session.status === 'active', so the ! is safe.
  const endsAt = session.endsAt!;
  if (now >= endsAt.getTime()) {
    return {
      terminal: true,
      status:   'expired',
      reason:   `Duration elapsed (ended at ${endsAt.toUTCString()})`,
    };
  }

  // ── 2. Pass ──
  if (equity >= session.targetCapital) {
    return {
      terminal: true,
      status:   'passed',
      reason:   `Bucket equity $${equity.toFixed(2)} reached target $${session.targetCapital}`,
    };
  }

  // ── 3. Drawdown floor (realised + unrealised) ──
  const drawdownFloor = session.startingCapital * (1 - session.maxDrawdownPct);
  if (equity <= drawdownFloor) {
    return {
      terminal:   true,
      status:     'failed',
      reason:     `Drawdown floor breached: equity $${equity.toFixed(2)} <= floor $${drawdownFloor.toFixed(2)}`,
      forceClose: portfolio.allocatedValue > 0,
    };
  }

  // ── 4. Unwinnable equity ──
  // If even a fully-leveraged trade can't clear the broker minimum, the bucket
  // can't make a compliant move from here. Fail with a distinct reason so the
  // user can see why (vs drawdown). Leverage comes from the agent now.
  const agentForLev = await prisma.agent.findUnique({
    where:  { id: session.agentId },
    select: { leverage: true },
  });
  const evalLeverage = agentForLev?.leverage ?? 10;
  if (equity * evalLeverage < session.minNotionalFloor) {
    return {
      terminal:   true,
      status:     'failed',
      reason:     `Below minimum viable equity: $${equity.toFixed(2)} × ${evalLeverage}× < $${session.minNotionalFloor}`,
      forceClose: portfolio.allocatedValue > 0,
    };
  }

  return { terminal: false };
}

// ─────────────────────────────────────────────
// Public: endChallenge
// Final terminal flow. Atomically updates the session row + agent fields,
// pauses the agent, tears down runtime (force-closes open trade if any,
// clears triggers), and notifies. Once status flips off 'active', the
// challenge carve-out filter in capital/getPortfolio stops applying and
// the bucket's realised P&L folds back into the main pool automatically.
// ─────────────────────────────────────────────

export async function endChallenge(
  sessionId:  string,
  status:     Exclude<ChallengeStatus, 'active' | 'pending'>,
  reason:     string,
  options?:   { forceClose?: boolean },
): Promise<void> {
  const session = await prisma.challengeSession.findUnique({
    where: { id: sessionId },
  });
  if (!session) {
    logger.warn('endChallenge: session not found', { sessionId });
    return;
  }
  if (session.status !== 'active') {
    logger.info('endChallenge: session already terminal', {
      sessionId,
      status: session.status,
    });
    return;
  }

  // Compute final stats. Equity uses the same realised+unrealised view as
  // evaluateChallenge — consistent across all terminal paths.
  const portfolio = await getChallengePortfolio(session);
  const finalEquity = portfolio.totalValue;
  const finalReturnPct = session.startingCapital > 0
    ? ((finalEquity / session.startingCapital) - 1) * 100
    : 0;

  // Trade stats for the result blob.
  const trades = await prisma.trade.findMany({
    where:  { challengeId: session.id, status: 'closed' },
    select: { realizedPnL: true },
  });
  const tradeCount = trades.length;
  const winCount   = trades.filter(t => (t.realizedPnL ?? 0) > 0).length;
  const winRate    = tradeCount > 0 ? (winCount / tradeCount) * 100 : 0;

  // ── Force-close open trade if asked (or implicitly required) ──
  // We dynamic-import executionEngine to avoid a hard module-init cycle with
  // execution/index.ts (which imports from this module). At call time both
  // sides are fully loaded.
  if (options?.forceClose || status !== 'cancelled') {
    const openTrade = await prisma.trade.findFirst({
      where: { challengeId: session.id, status: 'open' },
    });
    if (openTrade) {
      try {
        const { executionEngine } = await import('../execution/index.js');
        const { agentManager }    = await import('../agents/index.js');
        const runtime             = agentManager.getSingleAgent(session.agentId);
        if (runtime?.currentTrade) {
          await executionEngine.closeTrade(
            runtime,
            runtime.currentTrade,
            `CHALLENGE_${status.toUpperCase()}`,
          );
        } else {
          // No live runtime (e.g. paused agent). Close at DB level only by
          // marking the trade closed with its current unrealised PnL.
          // This is a defensive path — normally the runtime would exist.
          await prisma.trade.update({
            where: { id: openTrade.id },
            data: {
              status:      'closed',
              realizedPnL: openTrade.unrealisedPnl ?? 0,
              closeReason: `CHALLENGE_${status.toUpperCase()}`,
              closedAt:    new Date(),
            },
          });
        }
      } catch (err: any) {
        logger.error('endChallenge: force-close failed', {
          sessionId,
          tradeId: openTrade.id,
          error:   err?.message ?? err,
        });
      }
    }
  }

  // ── Atomic update: session + agent ──
  // Flip session to terminal; toggle challengeMode back to false; pause the
  // agent. The carve-out filter in capital/getPortfolio() keys off status,
  // so the bucket's realised P&L folds back into the main pool the moment
  // status leaves 'active'.
  await prisma.$transaction([
    prisma.challengeSession.update({
      where: { id: sessionId },
      data: {
        status,
        endedAt:        new Date(),
        finalEquity,
        finalReturnPct,
        failReason:     status === 'failed' || status === 'expired' || status === 'cancelled' ? reason : null,
        result: {
          tradeCount,
          winCount,
          winRate,
          realisedPnL:   portfolio.realisedPnL,
          unrealisedPnL: portfolio.unrealisedPnL,
        } as any,
      },
    }),
    prisma.agent.update({
      where: { id: session.agentId },
      data: {
        challengeMode: false,
        status:        'paused',
      },
    }),
  ]);

  // ── Runtime teardown: in-memory agent state + triggers ──
  try {
    const { agentManager } = await import('../agents/index.js');
    const runtime = agentManager.getSingleAgent(session.agentId);
    if (runtime) {
      runtime.status = 'paused';
      runtime.clearTrade();
      clearTriggerMemory(session.agentId);
      await clearTriggers(session.agentId, {
        status:      'cancelled',
        triggeredBy: 'CHALLENGE_END',
      });
    }
  } catch (err: any) {
    logger.warn('endChallenge: runtime teardown skipped', {
      sessionId,
      error: err?.message ?? err,
    });
  }

  // ── Notify ──
  const agent = await prisma.agent.findUnique({
    where:  { id: session.agentId },
    select: { name: true, pair: true },
  });
  if (agent) {
    void notifications.sendChallengeEnded(
      { name: agent.name, pair: agent.pair },
      {
        status,
        startingCapital: session.startingCapital,
        targetCapital:   session.targetCapital,
        finalEquity,
        finalReturnPct,
        failReason:      status === 'passed' ? null : reason,
      },
    );
  }

  logger.info('Challenge ended', {
    sessionId,
    status,
    reason,
    finalEquity,
    finalReturnPct,
  });
}

// ─────────────────────────────────────────────
// Public: tickActiveChallenges
// Iterates active sessions and evaluates each. Called hourly from
// startChallengeChecker() in index.ts. Catches expiry + drawdown cases
// that didn't trigger via a trade close.
// ─────────────────────────────────────────────

export async function tickActiveChallenges(): Promise<void> {
  const sessions = await prisma.challengeSession.findMany({
    where:  { status: 'active' },
    select: { id: true },
  });

  for (const { id } of sessions) {
    try {
      const evalResult = await evaluateChallenge(id);
      if (!evalResult.terminal) continue;
      const forceClose = evalResult.status === 'failed' ? evalResult.forceClose : true;
      await endChallenge(id, evalResult.status, evalResult.reason, { forceClose });
    } catch (err: any) {
      logger.error('tickActiveChallenges: error evaluating session', {
        sessionId: id,
        error: err?.message ?? err,
      });
    }
  }
}

// ─────────────────────────────────────────────
// Public: reconcileAgentChallengeToggles
// Watches Agent.challengeMode for flips. Called on a short interval so
// toggle-on / toggle-off feel responsive (DB-driven UX, not CLI).
//
// Per agent we cross-reference the challengeMode boolean with whether
// there's an active session for that agent. Active session lookups use the
// (agentId, status) index — same cost as the old pointer-field approach.
//
// Cases handled:
//   challengeMode=true  AND no active session → activate latest pending
//   challengeMode=false AND active session    → manual cancel
//   challengeMode=true  AND active session    → evaluateChallenge (terminal detection)
// ─────────────────────────────────────────────

export async function reconcileAgentChallengeToggles(): Promise<void> {
  // We need to look at agents that either have the toggle on OR have an
  // active/pending session. The IN-subquery would be cleaner but two
  // queries + a merge is simpler and still fast at this scale.
  const toggleOnAgents = await prisma.agent.findMany({
    where: { challengeMode: true },
  });

  const agentsWithLiveSession = await prisma.agent.findMany({
    where: {
      challengeMode:     false,
      challengeSessions: { some: { status: 'active' } },
    },
  });

  const agents = [...toggleOnAgents, ...agentsWithLiveSession];

  for (const agent of agents) {
    try {
      // Look up the active session for this agent (max one, enforced by
      // the SESSION_ALREADY_ACTIVE pre-flight check + the agentId+status index).
      const activeSession = await prisma.challengeSession.findFirst({
        where: { agentId: agent.id, status: 'active' },
      });

      // ── challengeMode=true, no active session → try to activate ──
      if (agent.challengeMode && !activeSession) {
        const result = await startChallenge({
          id:     agent.id,
          name:   agent.name,
          status: agent.status,
          mode:   agent.mode,
        });

        if (!result.ok) {
          // Pre-flight rejected (or no pending session). Flip the toggle
          // back to false and surface the reason. If the rejection came
          // with a pending session, that row is now status='failed' with
          // failReason populated (see failPending). If there was no
          // pending session at all, no DB cleanup is needed.
          await prisma.agent.update({
            where: { id: agent.id },
            data:  { challengeMode: false },
          });
          void notifications.sendChallengeStartFailed(
            { name: agent.name },
            result.reason,
            result.detail,
          );
          logger.info('Challenge start rejected by reconciler', {
            agentId: agent.id,
            reason:  result.reason,
            detail:  result.detail,
          });
        }
        continue;
      }

      // ── challengeMode=false but session is active → manual cancel ──
      if (!agent.challengeMode && activeSession) {
        await endChallenge(
          activeSession.id,
          'cancelled',
          'Manual toggle off',
          { forceClose: true },
        );
        continue;
      }

      // ── Active session present → check for terminal state ──
      if (activeSession) {
        const evalResult = await evaluateChallenge(activeSession.id);
        if (evalResult.terminal) {
          const forceClose = evalResult.status === 'failed' ? evalResult.forceClose : true;
          await endChallenge(
            activeSession.id,
            evalResult.status,
            evalResult.reason,
            { forceClose },
          );
        }
      }
    } catch (err: any) {
      logger.error('reconcileAgentChallengeToggles: error per-agent', {
        agentId: agent.id,
        error:   err?.message ?? err,
      });
    }
  }
}
