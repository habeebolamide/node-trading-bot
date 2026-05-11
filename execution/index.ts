import ccxt            from 'ccxt';
import WebSocket        from 'ws';
import { prisma }       from '../lib/prisma';
import logger           from '../utils/logger';
import { agentManager } from '../agents';
import { notifications } from '../utils/notifications';
import type { AgentRuntime } from '../agents';
import type { EntrySignal, ManagementDecision } from '../types/claude.types';
import type {
  ClosedTrade,
  OpenTrade,
  OrderRequest,
  OrderResult,
  TradeDirection,
} from '../types/trade.types';

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
  const request: OrderRequest = {
    agentId:      agent.id,
    pair:         agent.pair,
    direction:    signal.action as 'LONG' | 'SHORT',
    orderType:    'limit',
    price:        signal.entry ?? currentPrice,
    positionSize,
    tp:           signal.tp!,
    sl:           signal.sl!,
    mode:         agent.mode as 'paper' | 'live',
    leverage:     agent.leverage ?? 10,
  };

  const result = agent.mode === 'live'
    ? await executeLiveEntry(request)
    : await executePaperEntry(request);

  if (result.success) {
    const trade = await prisma.trade.create({
      data: {
        id:         result.orderId!,
        agentId:    agent.id,
        pair:       agent.pair,
        direction:  request.direction,
        entryPrice: signal.entry ?? currentPrice,
        stopLoss:   request.sl,
        takeProfit: request.tp,
        size:       positionSize,
        status:     'open',
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
      mode:           agent.mode as 'paper' | 'live',
    };

    agent.attachTrade(openTrade);

    if (agent.mode == 'live') {
      notifications.sendTradeAlert(agent, 'LIVE_OPEN', openTrade);
    }else if(agent.mode == 'paper'){
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
      mode:      agent.mode,
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
      ? Math.round((pnl / positionValue) * 10_000) / 100
      : 0;
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
    if (agent.mode  !== 'paper')   continue;
    if (agent.state !== 'IN_TRADE') continue;
    if (!agent.currentTrade)       continue;

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

      if (agent.mode === 'live') {
        await updateLiveTpSl(trade, decision.newTp, decision.newSl);
      }

      if (decision.newTp) trade.currentTp = decision.newTp;
      if (decision.newSl) trade.currentSl = decision.newSl;

      await notifications.sendTradeAlert(agent, 'ADJUST', trade);
      logger.info('Trade adjusted', { tradeId: trade.id, newTp: decision.newTp, newSl: decision.newSl });
      break;
    }

    case 'CLOSE': {
      const closed = await closeTrade(agent, trade, 'CLAUDE_CLOSE');
      await notifications.sendTradeAlert(agent, 'CLOSE', closed);
      break;
    }

    case 'PARTIAL_CLOSE': {
      await partialCloseTrade(agent, trade, decision.closePercent ?? 50);
      await notifications.sendTradeAlert(agent, 'PARTIAL_CLOSE', trade);
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

export async function closeTrade(
  agent:              AgentRuntime,
  trade:              OpenTrade,
  closeReason:        string,
  exitPriceOverride?: number,
): Promise<ClosedTrade> {

  let exitPrice = exitPriceOverride ?? 0;

  if (!exitPriceOverride) {
    exitPrice = agent.mode === 'live'
      ? await closeLivePosition(trade)
      : await getLatestPrice(agent.pair);
  }

  const realisedPnl = calculatePnl(
    trade.direction,
    trade.entryPrice,
    exitPrice,
    trade.positionSize,
  );

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

  // Notification with outcome
  const outcome = realisedPnl >= 0 ? 'WIN' : 'LOSS';
  notifications.sendTradeAlert(agent, closeReason as any, {
    ...trade,
    exitPrice,
    realisedPnl,
    outcome,
  } as any);

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

  return closed as unknown as ClosedTrade;
}

// ─────────────────────────────────────────────
// Monitor open trades on candle close
// Fallback only — checkPaperTpSl is primary
// ─────────────────────────────────────────────

export async function monitorOpenTrade(
  agent:       AgentRuntime,
  currentHigh: number,
  currentLow:  number,
): Promise<void> {
  const trade = agent.currentTrade;
  if (!trade || agent.mode !== 'paper') return;

  let hit: 'TP_HIT' | 'SL_HIT' | null = null;

  if (trade.direction === 'LONG') {
    if (currentHigh >= trade.currentTp) hit = 'TP_HIT';
    if (currentLow  <= trade.currentSl) hit = 'SL_HIT';
  }

  if (trade.direction === 'SHORT') {
    if (currentLow  <= trade.currentTp) hit = 'TP_HIT';
    if (currentHigh >= trade.currentSl) hit = 'SL_HIT';
  }

  if (hit) {
    const exitPrice = hit === 'TP_HIT' ? trade.currentTp : trade.currentSl;
    await closeTrade(agent, trade, hit, exitPrice);
  }
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
      if (agent.mode  !== 'live')    continue;
      if (agent.state !== 'IN_TRADE') continue;
      if (!agent.currentTrade)       continue;

      const exitPrice = parseFloat(exec.execPrice);

      let closeReason = 'LIVE_CLOSE';
      if (exec.stopOrderType === 'TakeProfit') closeReason = 'TP_HIT';
      if (exec.stopOrderType === 'StopLoss')   closeReason = 'SL_HIT';

      logger.info('Live trade closed via private WS', {
        agentId:     agent.id,
        pair,
        exitPrice,
        closeReason,
      });

      await closeTrade(agent, agent.currentTrade, closeReason, exitPrice);
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
      if (agent.mode  !== 'live')    continue;
      if (agent.state !== 'IN_TRADE') continue;
      if (!agent.currentTrade)       continue;

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
  try {
    await exchange.editOrder(
      trade.id, trade.pair, 'limit',
      trade.direction === 'LONG' ? 'buy' : 'sell',
      trade.positionSize, undefined,
      {
        ...(newTp ? { takeProfit: newTp } : {}),
        ...(newSl ? { stopLoss:   newSl } : {}),
      },
    );
  } catch (error: any) {
    logger.error('Failed to update TP/SL', { tradeId: trade.id, error: error.message });
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
  const closeSize  = trade.positionSize * (percent / 100);
  const remainSize = trade.positionSize - closeSize;
  let   exitPrice  = 0;

  if (agent.mode === 'live') {
    try {
      const side  = trade.direction === 'LONG' ? 'sell' : 'buy';
      const order = await exchange.createOrder(
        trade.pair, 'market', side, closeSize, undefined, { reduceOnly: true }
      );
      exitPrice = order.average ?? order.price ?? trade.entryPrice;
    } catch (error: any) {
      logger.error('Partial close failed', { error: error.message });
      return;
    }
  } else {
    exitPrice = await getLatestPrice(agent.pair);
  }

  const partialPnl = calculatePnl(trade.direction, trade.entryPrice, exitPrice, closeSize);

  await prisma.trade.update({ where: { id: trade.id }, data: { size: remainSize } });
  trade.positionSize = remainSize;

  logger.info('Partial close', { tradeId: trade.id, closeSize, remainSize, exitPrice, partialPnl });
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
  const crypto = require('crypto');
  return crypto
    .createHmac('sha256', process.env.BYBIT_SECRET ?? '')
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
  monitorOpenTrade,
  triggerPendingSignal,
  updateLivePnl,
  checkPaperTpSl,
  startPrivateWebSocket,
};