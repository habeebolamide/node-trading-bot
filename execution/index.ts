import ccxt            from 'ccxt';
import WebSocket        from 'ws';
import { createHmac }   from 'node:crypto';
import { prisma }       from '../lib/prisma.js';
import logger           from '../utils/logger.js';
import { agentManager } from '../agents/index.js';
import { notifications } from '../utils/notifications.js';
import { getCandleBuffer } from '../markets/websocket.js';
import { detectRegime } from '../markets/regime.js';
import { calculateIndicators } from '../markets/indicators.js';
import { getNewsContextForPrompt } from '../markets/news.js';
import { runPostMortem } from '../learning/index.js';
import { quantizePosition, getLotSpec } from '../risk/index.js';
import {
  endChallenge,
  evaluateChallenge,
  getActiveChallengeForAgent,
} from '../challenge/index.js';
import type { AgentRuntime } from '../agents/index.js';
import type { EntrySignal, ManagementDecision } from '../types/claude.types.js';
import type {
  ClosedTrade,
  OpenTrade,
  OrderRequest,
  OrderResult,
  TradeDirection,
} from '../types/trade.types.js';

// ─────────────────────────────────────────────
// Entry snapshot — captured at executeEntry, read at close for post-mortem
// ─────────────────────────────────────────────
interface EntrySnapshot {
  regime:      string;
  rsi:         number | null;
  volumeRatio: number | null;
  news:        string;
}

function buildEntrySnapshot(pair: string): EntrySnapshot {
  const buffer1h   = getCandleBuffer(pair, '60');
  const regime     = buffer1h.length > 0 ? detectRegime(buffer1h) : null;
  const indicators = buffer1h.length > 0 ? calculateIndicators(buffer1h) : null;

  return {
    regime:      regime?.regime ?? 'UNKNOWN',
    rsi:         indicators?.rsi ?? null,
    volumeRatio: indicators?.volume?.ratio ?? null,
    news:        getNewsContextForPrompt(pair),
  };
}

// ─────────────────────────────────────────────
// Bybit exchange instance
// ─────────────────────────────────────────────

const exchange = new ccxt.bybit({
  apiKey:  process.env.BYBIT_API_KEY ?? '',
  secret:  process.env.BYBIT_SECRET  ?? '',
  options: { defaultType: 'linear' },
  ...(process.env.BYBIT_TESTNET === 'true' && {
    urls: {
      api: {
        public:  'https://api.bybit.com',
        private: 'https://api.bybit.com',
      },
    },
  }),
});

// ─────────────────────────────────────────────
// Execute entry — routes to paper or live
// ─────────────────────────────────────────────

export async function executeEntry(
  agent:        AgentRuntime,
  signal:       EntrySignal,
  positionSize: number,
  currentPrice: number,
): Promise<OrderResult> {
  // ─── Challenge mode awareness ───
  // If the agent has an active session, the trade is tagged with challengeId
  // and the session's executionMode overrides agent.mode. Leverage from the
  // session also overrides agent.leverage (typically higher for small buckets).
  const session = await getActiveChallengeForAgent(agent.id);

  const execMode    = session
    ? session.executionMode
    : (agent.mode === 'backtest' ? 'paper' : agent.mode);
  // Leverage is sourced only from the agent now — challenge sessions no
  // longer carry a leverage column (single source of truth).
  const leverage    = agent.leverage ?? 10;

  // Pre-compute baseline for the live drawdown-floor check in updateLivePnl.
  let challengeBaseline: number | undefined;
  let challengeFloor:    number | undefined;
  if (session) {
    const realisedResult = await prisma.trade.aggregate({
      where:  { challengeId: session.id, status: 'closed' },
      _sum:   { realizedPnL: true },
    });
    const realisedPnL = realisedResult._sum.realizedPnL ?? 0;
    challengeBaseline = session.startingCapital + realisedPnL;
    challengeFloor    = session.startingCapital * (1 - session.maxDrawdownPct);
  }

  const request: OrderRequest = {
    agentId:      agent.id,
    pair:         agent.pair,
    direction:    signal.action as 'LONG' | 'SHORT',
    orderType:    'limit',
    price:        signal.entry ?? currentPrice,
    positionSize,
    tp:           signal.tp!,
    sl:           signal.sl!,
    mode:         execMode,
    leverage,
  };

  const result = execMode === 'live'
    ? await executeLiveEntry(request)
    : await executePaperEntry(request);

  if (result.success) {
    const entrySnapshot = buildEntrySnapshot(agent.pair);

    const trade = await prisma.trade.create({
      data: {
        id:            result.orderId!,
        agentId:       agent.id,
        pair:          agent.pair,
        direction:     request.direction,
        entryPrice:    signal.entry ?? currentPrice,
        stopLoss:      request.sl,
        takeProfit:    request.tp,
        size:          positionSize,
        status:        'open',
        entrySnapshot: entrySnapshot as any,
        leverage,
        mode:          execMode,
        challengeId:   session?.id ?? null,
      },
    });

    const openTrade: OpenTrade = {
      id:             trade.id,
      agentId:        trade.agentId,
      pair:           trade.pair,
      direction:      trade.direction as TradeDirection,
      entryPrice:     trade.entryPrice,
      currentTp:      trade.takeProfit ?? 0,
      currentSl:      trade.stopLoss   ?? 0,
      positionSize:   trade.size,
      positionValue:  trade.size * trade.entryPrice,
      unrealisedPnl:  0,
      unrealisedPct:  0,
      openedAt:       trade.openedAt ?? new Date(),
      entryReasoning: (signal as any).reasoning ?? '',
      mode:           execMode,
      leverage:       trade.leverage,
      ...(session ? {
        challengeId:        session.id,
        challengeBaseline:  challengeBaseline!,
        challengeFloor:     challengeFloor!,
      } : {}),
    };

    agent.attachTrade(openTrade);

    if (execMode === 'live') {
      notifications.sendTradeAlert(agent, 'LIVE_OPEN', openTrade);
    } else {
      notifications.sendTradeAlert(agent, 'PAPER_OPEN', openTrade);
    }

    logger.info('Trade opened', {
      agentId:   agent.id,
      pair:      agent.pair,
      direction: request.direction,
      entry:     result.fillPrice,
      tp:        request.tp,
      sl:        request.sl,
      size:      positionSize,
      mode:      execMode,
    });
  }

  return result;
}

// ─────────────────────────────────────────────
// Trigger pending signal
// Stores positionSize on Signal record so
// realtime execution can access it at entry hit
// ─────────────────────────────────────────────

export async function triggerPendingSignal(
  agent:        AgentRuntime,
  signal:       EntrySignal,
  positionSize: number,
): Promise<void> {
  await prisma.signal.updateMany({
    where: { agentId: agent.id, status: 'active' },
    data:  { positionSize },
  });

  logger.info('Pending signal stored', {
    agentId:      agent.id,
    action:       signal.action,
    entry:        signal.entry,
    positionSize,
  });
}

// ─────────────────────────────────────────────
// Live PnL update
// Called from handleTicker in websocket.ts
// on every price tick for IN_TRADE agents
// ─────────────────────────────────────────────

// Throttle DB writes for unrealised PnL — every ticker tick (~10 Hz × pair) would
// otherwise pound Postgres with redundant updates. In-memory state stays live;
// only the DB row gets a coarse snapshot.
const PNL_WRITE_THROTTLE_MS = 10_000;
const lastPnlWriteAt = new Map<string, number>();

// Once a challenge breaches its drawdown floor we fire endChallenge and don't
// want subsequent ticker ticks to re-fire it before the close lands. Track
// session IDs we've already triggered; cleared when the session terminates.
const challengeFloorFired = new Set<string>();

// Trade IDs currently undergoing a PARTIAL close (reduceOnly order in flight).
// Bybit's execution WS fires for both partial and full close fills with
// side='Sell'/closedSize>0 — indistinguishable from the data alone. Without
// this set, handleExecutionUpdate would treat the partial fill as a full close
// (closing the trade in DB while half the position is still open on Bybit).
// Added by partialCloseTrade before order submission, removed after the local
// state update completes. Backstop timeout in case the WS never fires.
const partialCloseInFlight = new Set<string>();

export function updateLivePnl(pair: string, currentPrice: number): void {
  const agents = agentManager.getAgentsForPair(pair);

  for (const agent of agents) {
    if (agent.state !== 'IN_TRADE' || !agent.currentTrade) continue;

    const trade         = agent.currentTrade;
    const positionValue = trade.entryPrice * trade.positionSize;

    const pnl = trade.direction === 'LONG'
      ? (currentPrice - trade.entryPrice) * trade.positionSize
      : (trade.entryPrice - currentPrice) * trade.positionSize;

    trade.unrealisedPnl = Math.round(pnl * 100) / 100;
    trade.unrealisedPct = positionValue > 0
      ? Math.round((pnl / positionValue) * trade.leverage * 10_000) / 100
      : 0;

    // ─── Challenge drawdown-floor live check ───
    // For challenge trades only: if live bucket equity falls at/below the
    // drawdown floor, end the challenge immediately (force-closing this trade).
    // baseline + unrealisedPnl gives an accurate live equity without any
    // additional DB query — both are already in scope. Fire-and-forget.
    // challengeFloorFired guards against re-firing on subsequent ticks before
    // the close lands.
    if (
      trade.challengeId &&
      trade.challengeBaseline != null &&
      trade.challengeFloor != null &&
      !challengeFloorFired.has(trade.challengeId)
    ) {
      const liveEquity = trade.challengeBaseline + trade.unrealisedPnl;
      if (liveEquity <= trade.challengeFloor) {
        const sessionId = trade.challengeId;
        challengeFloorFired.add(sessionId);
        logger.warn('Challenge drawdown floor breached — force-closing', {
          agentId:     agent.id,
          sessionId,
          liveEquity,
          floor:       trade.challengeFloor,
        });
        endChallenge(
          sessionId,
          'failed',
          `Drawdown floor breached: live equity $${liveEquity.toFixed(2)} <= floor $${trade.challengeFloor.toFixed(2)}`,
          { forceClose: true },
        ).catch(err =>
          logger.error('endChallenge from updateLivePnl failed', {
            sessionId,
            error: err?.message ?? err,
          }),
        );
      }
    }

    // Throttled DB flush — makes the row inspectable from Prisma Studio / SQL
    // without writing on every tick. Fire-and-forget; PnL stays accurate in memory
    // even if a write transiently fails.
    //
    // IMPORTANT — only flush UNREALIZED fields. Earlier this also wrote
    // realizedPnL = unrealisedPnl as a "Bybit-app-style live number," but that
    // raced with closeTrade(): an in-flight throttled write could land AFTER
    // closeTrade's final realizedPnL set, overwriting the true close value with
    // the stale live one. Downstream (updateAgentDbStats, dashboards) then read
    // the wrong realizedPnL.
    //
    // The conditional `where status:'open'` is the belt-and-braces guard: if a
    // close lands while this update is queued, the updateMany matches zero
    // rows and the write becomes a no-op rather than clobbering the closed row.
    const now = Date.now();
    const lastWrite = lastPnlWriteAt.get(trade.id) ?? 0;
    if (now - lastWrite >= PNL_WRITE_THROTTLE_MS) {
      lastPnlWriteAt.set(trade.id, now);
      prisma.trade.updateMany({
        where: { id: trade.id, status: 'open' },
        data:  {
          unrealisedPnl: trade.unrealisedPnl,
          unrealisedPct: trade.unrealisedPct,
        },
      }).catch(err =>
        logger.error('Failed to persist unrealised PnL', {
          tradeId: trade.id,
          error:   err?.message ?? err,
        }),
      );
    }
  }
}

// ─────────────────────────────────────────────
// Paper TP/SL monitor
// Called from handleTicker in websocket.ts
// Checks price crossing on every tick — not candle close
// prevPrice needed to detect crossing not just proximity
// ─────────────────────────────────────────────

export async function checkPaperTpSl(
  pair:         string,
  currentPrice: number,
  prevPrice:    number,
): Promise<void> {
  const agents = agentManager.getAgentsForPair(pair);

  for (const agent of agents) {
    if (agent.state !== 'IN_TRADE') continue;
    if (!agent.currentTrade)       continue;
    // Trade-level mode — falls back to agent.mode for legacy trades without trade.mode.
    if ((agent.currentTrade.mode ?? agent.mode) !== 'paper') continue;

    const trade = agent.currentTrade;
    let   hit:   'TP_HIT' | 'SL_HIT' | null = null;

    if (trade.direction === 'LONG') {
      if (prevPrice < trade.currentTp && currentPrice >= trade.currentTp) hit = 'TP_HIT';
      if (prevPrice > trade.currentSl && currentPrice <= trade.currentSl) hit = 'SL_HIT';
    }

    if (trade.direction === 'SHORT') {
      if (prevPrice > trade.currentTp && currentPrice <= trade.currentTp) hit = 'TP_HIT';
      if (prevPrice < trade.currentSl && currentPrice >= trade.currentSl) hit = 'SL_HIT';
    }

    if (!hit) continue;

    const exitPrice = hit === 'TP_HIT' ? trade.currentTp : trade.currentSl;

    logger.info(`Paper ${hit}`, {
      agentId:   agent.id,
      pair,
      direction: trade.direction,
      entry:     trade.entryPrice,
      exit:      exitPrice,
    });

    await closeTrade(agent, trade, hit, exitPrice);
  }
}

// ─────────────────────────────────────────────
// Execute management decision
// ─────────────────────────────────────────────

export async function executeManagement(
  agent:    AgentRuntime,
  decision: ManagementDecision,
  trade:    OpenTrade,
): Promise<void> {
  switch (decision.action) {

    case 'ADJUST': {
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          ...(decision.newTp ? { takeProfit: decision.newTp } : {}),
          ...(decision.newSl ? { stopLoss:   decision.newSl } : {}),
        },
      });

      if ((trade.mode ?? agent.mode) === 'live') {
        await updateLiveTpSl(trade, decision.newTp, decision.newSl);
      }

      if (decision.newTp) trade.currentTp = decision.newTp;
      if (decision.newSl) trade.currentSl = decision.newSl;

      await notifications.sendTradeAlert(agent, 'ADJUST', trade);
      logger.info('Trade adjusted', { tradeId: trade.id, newTp: decision.newTp, newSl: decision.newSl });
      break;
    }

    case 'CLOSE': {
      // closeTrade fires the close notification internally with the proper
      // ClosedTrade shape. Earlier this dispatched a second notification
      // passing the Prisma row (American field names: realizedPnL) into
      // sendTradeAlert's CLOSE branch which reads British names — the
      // .toFixed call on undefined was the crash you saw in the logs.
      await closeTrade(agent, trade, 'CLAUDE_CLOSE');
      break;
    }

    case 'PARTIAL_CLOSE': {
      // Notification is fired from inside partialCloseTrade — it has the
      // close %, sizes, and partial PnL that aren't accessible from here.
      await partialCloseTrade(agent, trade, decision.closePercent ?? 50);
      break;
    }

    case 'HOLD':
    default:
      break;
  }
}

// ─────────────────────────────────────────────
// Close trade
// exitPriceOverride — used by paper TP/SL
// and private WebSocket — exact level hit
// ─────────────────────────────────────────────

async function updateAgentDbStats(agentId: string): Promise<void> {
  try {
    const allClosedTrades = await prisma.trade.findMany({
      where: { agentId, status: 'closed' },
      select: { realizedPnL: true, closedAt: true },
    });

    const totalTrades = allClosedTrades.length;
    const winCount = allClosedTrades.filter(t => (t.realizedPnL ?? 0) > 0).length;
    // Stored as a percentage (0-100), not a 0-1 fraction.
    const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;

    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const monthlyTrades = allClosedTrades.filter(t => t.closedAt && t.closedAt >= monthStart);
    const monthlyPnlAmount = monthlyTrades.reduce((sum, t) => sum + (t.realizedPnL ?? 0), 0);

    // Pick the correct denominator for the monthly PnL %.
    // For a challenge agent with an active session, the meaningful denominator
    // is the bucket's startingCapital — the agent's allocationPercent is
    // irrelevant inside a challenge. Without this branch, a $5 bucket showing
    // +$2 PnL would be reported as (2 / 100) = 2% instead of (2 / 5) = 40%.
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { allocationPercent: true },
    });
    const activeSession = await prisma.challengeSession.findFirst({
      where:  { agentId, status: 'active' },
      select: { startingCapital: true },
    });

    let denominator: number;
    if (activeSession && activeSession.startingCapital > 0) {
      denominator = activeSession.startingCapital;
    } else {
      const initialCapital = parseFloat(process.env.INITIAL_CAPITAL ?? '1000');
      denominator = initialCapital * ((agent?.allocationPercent ?? 10) / 100);
    }
    const monthlyPnL = denominator > 0 ? (monthlyPnlAmount / denominator) * 100 : 0;

    await prisma.agent.update({
      where: { id: agentId },
      data: {
        totalTrades,
        winRate: Math.round(winRate * 100) / 100,
        monthlyPnL: Math.round(monthlyPnL * 100) / 100,
      },
    });

    logger.info('Updated agent database statistics', {
      agentId,
      totalTrades,
      winRate,
      monthlyPnL,
    });
  } catch (error: any) {
    logger.error('Failed to update agent database statistics', {
      agentId,
      error: error.message,
    });
  }
}

export async function closeTrade(
  agent:              AgentRuntime,
  trade:              OpenTrade,
  closeReason:        string,
  exitPriceOverride?: number,
): Promise<ClosedTrade> {

  let exitPrice = exitPriceOverride ?? 0;

  if (!exitPriceOverride) {
    exitPrice = (trade.mode ?? agent.mode) === 'live'
      ? await closeLivePosition(trade)
      : await getLatestPrice(agent.pair);
  }

  // PnL on the REMAINING position only — partial closes that ran earlier
  // already booked their PnL onto this row's realizedPnL via partialCloseTrade.
  // We add the final-exit PnL on top so totals reflect entry + every partial.
  const finalExitPnl = calculatePnl(
    trade.direction,
    trade.entryPrice,
    exitPrice,
    trade.positionSize,
  );

  // Read whatever partial PnL has already been accumulated, then sum.
  // Using a separate read (vs prisma.increment) so realisedPnl is available
  // for downstream logic in this function (notifications, post-mortem, etc.)
  // without an extra round-trip.
  const priorPartial = (await prisma.trade.findUnique({
    where:  { id: trade.id },
    select: { realizedPnL: true },
  }))?.realizedPnL ?? 0;
  const realisedPnl = Math.round((priorPartial + finalExitPnl) * 100) / 100;

  const duration = Math.round((Date.now() - trade.openedAt.getTime()) / 1000);

  const closed = await prisma.trade.update({
    where: { id: trade.id },
    data: {
      status:      'closed',
      exitPrice,
      realizedPnL: realisedPnl,
      closeReason,
      closedAt:    new Date(),
      duration,
    },
  });

  agent.clearTrade();
  lastPnlWriteAt.delete(trade.id);

  // Clear any lingering active signals for this agent. Without this, the
  // management-cycle triggers set on the originating signal (price_up /
  // price_down) survive in DB after the trade closes and can re-fire on
  // the next ticker tick — cancelling the agent's next legitimate signal
  // and burning an LLM re-analysis. Seen in production logs at 18:26:03
  // (stale price_down=83.7 firing 6 minutes after the close).
  await prisma.signal.updateMany({
    where: { agentId: agent.id, status: 'active' },
    data: {
      status:      'cancelled',
      triggeredBy: 'TRADE_CLOSED',
      triggeredAt: new Date(),
    },
  }).catch(err =>
    logger.error('Failed to clear active signals after trade close', {
      agentId: agent.id,
      error:   err?.message ?? err,
    }),
  );

  // Update Agent's DB stats (win rate, monthly PnL, total trades)
  void updateAgentDbStats(agent.id);

  // ─── Challenge: post-close evaluation ───
  // Fast pass/fail/floor detection right after the trade lands, so we don't
  // wait for the hourly tick. evaluateChallenge is cheap (one session lookup
  // + one portfolio query); fire-and-forget if it returns terminal.
  const closedChallengeId = (closed as any).challengeId ?? trade.challengeId;
  if (closedChallengeId) {
    evaluateChallenge(closedChallengeId)
      .then((evalResult) => {
        if (!evalResult.terminal) return;
        const forceClose =
          evalResult.status === 'failed' ? evalResult.forceClose : true;
        return endChallenge(closedChallengeId, evalResult.status, evalResult.reason, {
          forceClose,
        });
      })
      .catch(err =>
        logger.error('Post-close challenge evaluation failed', {
          challengeId: closedChallengeId,
          error:       err?.message ?? err,
        }),
      );
  }

  // Notification with outcome. Use 'CLOSE' as the sendTradeAlert type
  // (the branch keyword) and surface closeReason via the message body.
  // Previously this passed closeReason ('CLAUDE_CLOSE', 'TP_HIT' etc.) as
  // the type, none of which matched any branch in sendTradeAlert — so the
  // notification silently sent an empty message.
  const positionValue = trade.entryPrice * trade.positionSize;
  const realisedPct = positionValue > 0
    ? (realisedPnl / positionValue) * trade.leverage * 100
    : 0;
  const outcome: 'win' | 'loss' | 'breakeven' =
    realisedPnl > 0 ? 'win' :
    realisedPnl < 0 ? 'loss' :
    'breakeven';
  notifications.sendTradeAlert(agent, 'CLOSE', {
    ...trade,
    exitPrice,
    realisedPnl,
    realisedPct,
    closeReason,
    outcome,
    closedAt: new Date(),
    durationHours: duration / 3600,
    postMortemId: null,
  } as unknown as ClosedTrade);

  logger.info('Trade closed', {
    tradeId:     trade.id,
    pair:        trade.pair,
    direction:   trade.direction,
    entry:       trade.entryPrice,
    exit:        exitPrice,
    pnl:         realisedPnl,
    outcome,
    closeReason,
  });

  // Post-mortem: only on losses. Uses snapshot stored at executeEntry.
  // positionValue / realisedPct already computed above for the notification —
  // reuse them here instead of recomputing.
  if (realisedPnl < 0) {
    const snapshot = (closed as any).entrySnapshot as EntrySnapshot | null;
    if (snapshot) {
      const closedTradeForPm = {
        ...trade,
        exitPrice,
        realisedPnl,
        realisedPct,
        closeReason,
        outcome,
        closedAt:      new Date(),
        durationHours: duration / 3600,
        postMortemId:  null,
      } as unknown as ClosedTrade;

      runPostMortem(
        closedTradeForPm,
        snapshot.regime,
        snapshot.news,
        snapshot.rsi ?? 50,
        snapshot.volumeRatio ?? 1,
      ).catch(err =>
        logger.error('Post-mortem failed', { tradeId: trade.id, error: err?.message ?? err }),
      );
    } else {
      logger.warn('Losing trade has no entrySnapshot — skipping post-mortem', { tradeId: trade.id });
    }
  }

  return closed as unknown as ClosedTrade;
}

// ─────────────────────────────────────────────
// Private WebSocket — live trade monitoring
// Bybit pushes when TP/SL hits or position closes
// ─────────────────────────────────────────────

let privateWs:          WebSocket | null = null;
let privateWsPingTimer: NodeJS.Timeout | null = null;

export function startPrivateWebSocket(): void {
  if (privateWs?.readyState === WebSocket.OPEN) return;

  const url = 'wss://stream.bybit.com/v5/private';

  privateWs = new WebSocket(url);

  privateWs.on('open', () => {
    logger.info('Private WebSocket connected');

    const expires   = Date.now() + 10_000;
    const signature = generateSignature(expires);

    privateWs!.send(JSON.stringify({
      op:   'auth',
      args: [process.env.BYBIT_API_KEY, expires, signature],
    }));

    // Ping every 20s
    privateWsPingTimer = setInterval(() => {
      if (privateWs?.readyState === WebSocket.OPEN) {
        privateWs.send(JSON.stringify({ op: 'ping' }));
      }
    }, 20_000);
  });

  privateWs.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.op === 'auth' && msg.success) {
        logger.info('Private WebSocket authenticated');
        privateWs!.send(JSON.stringify({
          op:   'subscribe',
          args: ['execution', 'position'],
        }));
        return;
      }

      if (msg.topic === 'execution') {
        await handleExecutionUpdate(msg.data ?? []);
        return;
      }

      if (msg.topic === 'position') {
        await handlePositionUpdate(msg.data ?? []);
        return;
      }

    } catch (e) {
      logger.error('Private WS parse error', { error: e });
    }
  });

  privateWs.on('close', () => {
    logger.warn('Private WebSocket closed — reconnecting in 5s');
    if (privateWsPingTimer) clearInterval(privateWsPingTimer);
    privateWs = null;
    setTimeout(startPrivateWebSocket, 5_000);
  });

  privateWs.on('error', (err) => {
    logger.error('Private WebSocket error', { error: err.message });
  });
}

// ─────────────────────────────────────────────
// Handle execution update
// Fires when TP hits, SL hits, or manual close
// ─────────────────────────────────────────────

async function handleExecutionUpdate(executions: any[]): Promise<void> {
  for (const exec of executions) {
    if (exec.execType !== 'Trade') continue;

    const pair   = exec.symbol;
    const agents = agentManager.getAgentsForPair(pair);

    for (const agent of agents) {
      if (agent.state !== 'IN_TRADE') continue;
      if (!agent.currentTrade)       continue;
      if ((agent.currentTrade.mode ?? agent.mode) !== 'live') continue;

      // ─── Distinguish entry fills from exit fills ───
      // Bybit fires execType='Trade' for BOTH the limit order fill that OPENS
      // the position and the order that CLOSES it. Without this guard the
      // entry fill (~10-30s after placement for a limit order) was being
      // treated as a close — triggering a bogus close notification while
      // the position was still open on Bybit.
      //
      // Two signals identify a closing fill (use either; we check both for
      // robustness across Bybit's slightly-inconsistent payload shapes):
      //   1. exec.side opposes the trade direction (LONG closes via Sell,
      //      SHORT closes via Buy).
      //   2. exec.closedSize > 0 — Bybit sets this only on reducing fills.
      const trade = agent.currentTrade;
      const closingSide = trade.direction === 'LONG' ? 'Sell' : 'Buy';
      const execSide   = (exec.side ?? '').toString();
      const closedSize = parseFloat(exec.closedSize ?? '0');
      const isClosingFill =
        execSide === closingSide || closedSize > 0;

      if (!isClosingFill) {
        logger.info('Private WS: entry fill (not a close) — ignoring', {
          agentId: agent.id,
          pair,
          execSide,
          tradeDirection: trade.direction,
          closedSize,
          execPrice: exec.execPrice,
        });
        continue;
      }

      // PARTIAL close in flight — this WS event is the fill of the partial
      // reduceOnly order, NOT a full close. partialCloseTrade handles the
      // book-keeping itself. Skip so we don't blow away the trade row.
      if (partialCloseInFlight.has(trade.id)) {
        logger.info('Private WS: partial close fill — handled by partialCloseTrade', {
          agentId:  agent.id,
          tradeId:  trade.id,
          closedSize,
          execPrice: exec.execPrice,
        });
        continue;
      }

      const exitPrice = parseFloat(exec.execPrice);

      let closeReason = 'LIVE_CLOSE';
      if (exec.stopOrderType === 'TakeProfit') closeReason = 'TP_HIT';
      if (exec.stopOrderType === 'StopLoss')   closeReason = 'SL_HIT';

      logger.info('Live trade closed via private WS', {
        agentId:     agent.id,
        pair,
        exitPrice,
        closeReason,
        execSide,
        closedSize,
      });

      await closeTrade(agent, trade, closeReason, exitPrice);
    }
  }
}

// ─────────────────────────────────────────────
// Handle position update
// Position size went to 0 — trade fully closed
// ─────────────────────────────────────────────

async function handlePositionUpdate(positions: any[]): Promise<void> {
  for (const pos of positions) {
    const size   = parseFloat(pos.size);
    if (size !== 0) continue; // only care about full closes

    const pair   = pos.symbol;
    const agents = agentManager.getAgentsForPair(pair);

    for (const agent of agents) {
      if (agent.state !== 'IN_TRADE') continue;
      if (!agent.currentTrade)       continue;
      if ((agent.currentTrade.mode ?? agent.mode) !== 'live') continue;

      const exitPrice = parseFloat(pos.markPrice ?? pos.avgPrice ?? agent.currentTrade.entryPrice);
      await closeTrade(agent, agent.currentTrade, 'BYBIT_CLOSE', exitPrice);
    }
  }
}

// ─────────────────────────────────────────────
// Paper entry
// ─────────────────────────────────────────────

async function executePaperEntry(request: OrderRequest): Promise<OrderResult> {
  const slippage  = request.price * 0.0002;
  const fillPrice = request.direction === 'LONG'
    ? request.price + slippage
    : request.price - slippage;

  return {
    success:   true,
    orderId:   `paper_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    fillPrice: Math.round(fillPrice * 100_000) / 100_000,
    error:     null,
  };
}

// ─────────────────────────────────────────────
// Live entry
// ─────────────────────────────────────────────

async function executeLiveEntry(request: OrderRequest): Promise<OrderResult> {
  try {
    try {
      await exchange.setLeverage(request.leverage ?? 10, request.pair);
    } catch (e: any) {
      logger.warn('setLeverage warning — continuing', { error: e.message });
    }

    const side  = request.direction === 'LONG' ? 'buy' : 'sell';
    const order = await exchange.createOrder(
      request.pair,
      'limit',
      side,
      request.positionSize,
      request.price,
      {
        takeProfit:  request.tp,
        stopLoss:    request.sl,
        timeInForce: 'GoodTillCancel',
      },
    );

    startPrivateWebSocket();

    return {
      success:   true,
      orderId:   order.id,
      fillPrice: order.average ?? order.price ?? request.price,
      error:     null,
    };

  } catch (error: any) {
    logger.error('Live order failed', { error: error.message });
    return { success: false, orderId: null, fillPrice: null, error: error.message };
  }
}

// ─────────────────────────────────────────────
// Update TP/SL on live exchange
// ─────────────────────────────────────────────

async function updateLiveTpSl(
  trade: OpenTrade,
  newTp: number | null,
  newSl: number | null,
): Promise<void> {
  // Bybit V5 holds TP/SL on the POSITION, not on the entry order. editOrder
  // (which the previous version called with trade.id, the entry order id) does
  // not work for this — the entry order is already filled and can't be edited.
  // The correct call is POST /v5/position/trading-stop, which ccxt exposes via
  // the private endpoint passthrough below.
  if (!newTp && !newSl) return;

  try {
    const params: Record<string, any> = {
      category:    'linear',
      symbol:      trade.pair,
      positionIdx: 0,             // one-way mode; 1 / 2 for hedge mode long/short
      tpslMode:    'Full',
      tpTriggerBy: 'LastPrice',
      slTriggerBy: 'LastPrice',
    };
    if (newTp) params.takeProfit = String(newTp);
    if (newSl) params.stopLoss   = String(newSl);

    await (exchange as any).privatePostV5PositionTradingStop(params);

    logger.info('Live TP/SL updated via trading-stop', {
      tradeId: trade.id,
      pair:    trade.pair,
      newTp,
      newSl,
    });
  } catch (error: any) {
    logger.error('Failed to update live TP/SL', { tradeId: trade.id, error: error.message });
  }
}

// ─────────────────────────────────────────────
// Close live position
// ─────────────────────────────────────────────

async function closeLivePosition(trade: OpenTrade): Promise<number> {
  try {
    const side  = trade.direction === 'LONG' ? 'sell' : 'buy';
    const order = await exchange.createOrder(
      trade.pair, 'market', side, trade.positionSize,
      undefined, { reduceOnly: true }
    );
    return order.average ?? order.price ?? trade.entryPrice;
  } catch (error: any) {
    logger.error('Failed to close live position', { tradeId: trade.id, error: error.message });

    // Bybit retCode 110017: "current position is zero, cannot fix
    // reduce-only order qty" — the position was already closed at the
    // exchange (TP/SL hit before our close order landed). Recover the real
    // exit price from recent fills so we don't record PnL = 0 on a trade
    // that actually completed at TP or SL.
    const msg = (error?.message ?? '') as string;
    if (msg.includes('110017') || msg.toLowerCase().includes('position is zero')) {
      try {
        const fills = await exchange.fetchMyTrades(trade.pair, undefined, 20);
        // Pick the most recent fill after this trade opened, on the closing side.
        const closingSide = trade.direction === 'LONG' ? 'sell' : 'buy';
        const openedAtMs  = trade.openedAt.getTime();
        const candidate = (fills as any[])
          .filter(f =>
            (f.side?.toLowerCase?.() ?? '') === closingSide &&
            f.timestamp > openedAtMs &&
            typeof f.price === 'number',
          )
          .sort((a, b) => b.timestamp - a.timestamp)[0];

        if (candidate?.price) {
          logger.info('Recovered exit price from Bybit fill history', {
            tradeId:   trade.id,
            exitPrice: candidate.price,
            fillId:    candidate.id ?? null,
          });
          return candidate.price;
        }

        logger.warn('Position-zero recovery: no matching fill found', {
          tradeId: trade.id, fillCount: (fills as any[]).length,
        });
      } catch (recoverErr: any) {
        logger.error('Position-zero recovery failed', {
          tradeId: trade.id,
          error:   recoverErr?.message ?? recoverErr,
        });
      }
    }

    // Last resort — still wrong (records 0 PnL) but better than crashing.
    // Telegram alert will show closeReason; you can reconcile from Bybit
    // directly if this fires.
    return trade.entryPrice;
  }
}

// ─────────────────────────────────────────────
// Partial close
// ─────────────────────────────────────────────

async function partialCloseTrade(
  agent:   AgentRuntime,
  trade:   OpenTrade,
  percent: number,
): Promise<void> {
  // ─── Lot-size aware partial sizing ───
  // Bybit rejects orders below the pair's lot step (e.g. ETH=0.01). Raw
  // percent math (0.025 × 30% = 0.0075) sits below that → 400 reject. Also
  // guard against leaving a sub-min "stranded" remainder that can't ever
  // be closed later. If either side of the split is infeasible, fall back
  // to a FULL close — the LLM's intent ("bank some profit") is preserved
  // and we don't strand capital in a dead position.
  const lot = getLotSpec(trade.pair);
  const rawClose = trade.positionSize * (percent / 100);
  let   closeSize  = quantizePosition(trade.pair, rawClose);
  let   remainSize = quantizePosition(trade.pair, trade.positionSize - closeSize);

  if (closeSize <= 0 || remainSize < lot.minQty) {
    logger.warn('Partial close infeasible at this position size — converting to full close', {
      tradeId:        trade.id,
      positionSize:   trade.positionSize,
      percent,
      rawClose,
      quantizedClose: closeSize,
      remainSize,
      minQty:         lot.minQty,
    });
    await closeTrade(agent, trade, 'PARTIAL_CONVERTED_TO_FULL');
    return;
  }

  let   exitPrice  = 0;

  if ((trade.mode ?? agent.mode) === 'live') {
    // Tag the trade as "partial close in flight" BEFORE submitting so the
    // private WS handler can skip the fill event when it arrives. Removed in
    // finally; backstop setTimeout clears it after 30s in case the WS never
    // delivers (so the tag doesn't suppress legitimate future closes).
    partialCloseInFlight.add(trade.id);
    const tagTimeout = setTimeout(() => partialCloseInFlight.delete(trade.id), 30_000);
    try {
      const side  = trade.direction === 'LONG' ? 'sell' : 'buy';
      const order = await exchange.createOrder(
        trade.pair, 'market', side, closeSize, undefined, { reduceOnly: true }
      );
      exitPrice = order.average ?? order.price ?? trade.entryPrice;
    } catch (error: any) {
      logger.error('Partial close failed', { error: error.message });
      clearTimeout(tagTimeout);
      partialCloseInFlight.delete(trade.id);
      return;
    } finally {
      // Keep the tag for ~3s so the WS event (typically arrives within 1s)
      // is suppressed even if it lands AFTER createOrder resolves but BEFORE
      // we finish the local book-keeping below.
      setTimeout(() => {
        clearTimeout(tagTimeout);
        partialCloseInFlight.delete(trade.id);
      }, 3_000);
    }
  } else {
    exitPrice = await getLatestPrice(agent.pair);
  }

  const partialPnl = calculatePnl(trade.direction, trade.entryPrice, exitPrice, closeSize);

  // Accumulate realised PnL on the OPEN row so it isn't lost when the
  // remainder finally closes. closeTrade() reads realizedPnL back and ADDS
  // the final-exit PnL on top — partial + final stays consistent across
  // any number of partials. Prisma `increment` is atomic; safe even if two
  // partials raced (they don't today, but defensive).
  await prisma.trade.update({
    where: { id: trade.id },
    data: {
      size:        remainSize,
      realizedPnL: { increment: Math.round(partialPnl * 100) / 100 },
    },
  });
  trade.positionSize = remainSize;

  logger.info('Partial close', { tradeId: trade.id, closeSize, remainSize, exitPrice, partialPnl });

  await notifications.sendPartialCloseAlert(agent, trade, {
    percent,
    closedSize: closeSize,
    remainSize,
    exitPrice,
    partialPnl,
  });
}

// ─────────────────────────────────────────────
// Get latest price — paper fallback
// ─────────────────────────────────────────────

async function getLatestPrice(pair: string): Promise<number> {
  try {
    const ticker = await exchange.fetchTicker(pair);
    return ticker.last ?? ticker.close ?? 0;
  } catch {
    const candle = await prisma.candle.findFirst({
      where: { pair, timeframe: '1' }, orderBy: { timestamp: 'desc' },
    });
    return candle?.close ?? 0;
  }
}

// ─────────────────────────────────────────────
// P&L
// ─────────────────────────────────────────────

function calculatePnl(
  direction: 'LONG' | 'SHORT',
  entry:     number,
  exit:      number,
  size:      number,
): number {
  const diff = direction === 'LONG' ? exit - entry : entry - exit;
  return Math.round(diff * size * 100) / 100;
}

// ─────────────────────────────────────────────
// HMAC signature for private WS auth
// ─────────────────────────────────────────────

function generateSignature(expires: number): string {
  // Use the ESM-imported `createHmac` — `require()` is undefined under
  // `"type": "module"` and was crashing the private WS auth at runtime.
  return createHmac('sha256', process.env.BYBIT_SECRET ?? '')
    .update(`GET/realtime${expires}`)
    .digest('hex');
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export const executionEngine = {
  executeEntry,
  executeManagement,
  closeTrade,
  triggerPendingSignal,
  updateLivePnl,
  checkPaperTpSl,
  startPrivateWebSocket,
};