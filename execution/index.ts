import ccxt from 'ccxt';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import type {
  AgentRuntime,
} from '../agents';
import { EntrySignal, ManagementDecision } from '../types/claude.types';
import { ClosedTrade, OpenTrade, OrderRequest, OrderResult, TradeDirection } from '../types/trade.types';
import { send } from 'node:process';
import { notifications } from '../utils/notifications';


// ─────────────────────────────────────────────
// Bybit exchange instance (ccxt)
// Used only when mode = 'live'
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
        public: 'https://api-testnet.bybit.com',
        private: 'https://api-testnet.bybit.com',
      },
    },
  }),
});

// ─────────────────────────────────────────────
// Entry Sitgnal 
// ─────────────────────────────────────────────
export async function triggerPendingSignal(
  agent: AgentRuntime,
  signal: EntrySignal,
  positionSize: number,
): Promise<any> {

  const expiresAt = signal.entry_expiry
    ? new Date(signal.entry_expiry)
    : new Date(Date.now() + 60 * 60 * 1000); 
    

  const pending = await prisma.pendingSignal.create({
    data: {
      agentId: agent.id,
      pair: agent.pair,
      direction: signal.action as TradeDirection ,
      entryPrice: signal.entry ?? 0,
      tp: signal.tp ?? 0,
      sl: signal.sl ?? 0,
      positionSize,
      status: 'PENDING',
      confidence: signal.confidence,
      reasoning: signal.reasoning,
      expiresAt,
      createdAt: new Date(),
      rawSignal: JSON.stringify(signal),
    }
  });

  agent.setState('PENDING_ENTRY');

  await notifications.sendSignalAlert(agent, signal);

  return pending;
}
// ─────────────────────────────────────────────
// Execute entry — routes to paper or live
// ─────────────────────────────────────────────

export async function executeEntry(
  agent: AgentRuntime,
  signal: EntrySignal,
  positionSize: number,
  currentPrice: number,
): Promise<OrderResult> {
  const request: OrderRequest = {
    agentId: agent.id,
    pair: agent.pair,
    direction: signal.action as 'LONG' | 'SHORT',
    orderType: 'limit',
    price: signal.entry ?? currentPrice,
    positionSize,
    tp: signal.tp!,
    sl: signal.sl!,
    mode: agent.mode as 'paper' | 'live',
  };

  const result = agent.mode === 'live'
    ? await executeLiveEntry(request)
    : await executePaperEntry(request);

  if (result.success) {
    // Persist trade to DB
    const trade = await prisma.trade.create({
      data: {
        id: result.orderId!,
        agentId: agent.id,
        pair: agent.pair,
        direction: request.direction,
        entryPrice: signal.entry ?? currentPrice,
        stopLoss: request.sl,
        takeProfit: request.tp,
        size: positionSize,
        status: 'open',
      },
    });

    if (agent.mode === 'paper') {
      const alertPayload: OpenTrade = {
        id: trade.id,
        agentId: trade.agentId,
        pair: trade.pair,
        direction: trade.direction as TradeDirection,
        entryPrice: trade.entryPrice,
        currentTp: trade.takeProfit ?? 0,
        currentSl: trade.stopLoss ?? 0,
        positionSize: trade.size,
        positionValue: trade.size * trade.entryPrice, 
        unrealisedPnl: 0,
        unrealisedPct: 0,
        openedAt: trade.openedAt ?? new Date(),
        entryReasoning: "Trade opened via automated signal",
        mode: 'paper',
      };

      notifications.sendTradeAlert(agent, 'PAPER_OPEN', alertPayload);
    }

    logger.info('Trade opened', {
      agentId: agent.id,
      pair: agent.pair,
      direction: request.direction,
      entry: result.fillPrice,
      tp: request.tp,
      sl: request.sl,
      size: positionSize,
      mode: agent.mode,
    });
  }

  return result;
}

// ─────────────────────────────────────────────
// Execute management decision
// ─────────────────────────────────────────────

export async function executeManagement(
  agent: AgentRuntime,
  decision: ManagementDecision,
  trade: OpenTrade,
): Promise<void> {
  switch (decision.action) {
    case 'ADJUST': {
      // Update TP/SL in DB
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          ...(decision.newTp ? { takeProfit: decision.newTp } : {}),
          ...(decision.newSl ? { stopLoss: decision.newSl } : {}),
        },
      });

      // Update on exchange if live
      if (agent.mode === 'live') {
        await updateLiveTpSl(trade, decision.newTp, decision.newSl);
      }

      // Update agent runtime
      if (decision.newTp) trade.currentTp = decision.newTp;
      if (decision.newSl) trade.currentSl = decision.newSl;

      // Notify
      await notifications.sendTradeAlert(agent, 'ADJUST', trade);

      logger.info('Trade adjusted', {
        tradeId: trade.id,
        newTp: decision.newTp,
        newSl: decision.newSl,
        reason: decision.reasoning,
      });
      break;
    }

    case 'CLOSE': {
      const closedTrade = await closeTrade(agent, trade, 'CLAUDE_CLOSE');
      // Notify (assuming closeTrade returns the ClosedTrade object)
      await notifications.sendTradeAlert(agent, 'CLOSE', closedTrade);
      break;
    }

    case 'PARTIAL_CLOSE': {
      const percent = decision.closePercent ?? 50;
      await partialCloseTrade(agent, trade, percent);
      // Notify
      await notifications.sendTradeAlert(agent, 'PARTIAL_CLOSE', trade);
      break;
    }

    case 'HOLD':
    default:
      // Optional: Notify if reasoning is important, otherwise leave empty
      break;
  }
}

// ─────────────────────────────────────────────
// Close trade fully
// ─────────────────────────────────────────────

export async function closeTrade(
  agent: AgentRuntime,
  trade: OpenTrade,
  closeReason: string,
): Promise<ClosedTrade> {
  let exitPrice = 0;

  if (agent.mode === 'live') {
    exitPrice = await closeLivePosition(trade);
  } else {
    // Paper — use latest candle close as exit
    exitPrice = await getLatestPrice(agent.pair);
  }

  const realisedPnl = calculatePnl(
    trade.direction,
    trade.entryPrice,
    exitPrice,
    trade.positionSize,
  );

  const duration = Math.round(
    (Date.now() - trade.openedAt.getTime()) / 1000
  );

  const closedTrade = await prisma.trade.update({
    where: { id: trade.id },
    data: {
      status: 'closed',
      exitPrice,
      realizedPnL: realisedPnl,
      closeReason,
      closedAt: new Date(),
      duration,
    },
  });

  agent.clearTrade();

  logger.info('Trade closed', {
    tradeId: trade.id,
    pair: trade.pair,
    direction: trade.direction,
    entry: trade.entryPrice,
    exit: exitPrice,
    pnl: realisedPnl,
    closeReason,
  });

  return closedTrade as unknown as ClosedTrade;
}

// ─────────────────────────────────────────────
// Monitor open trades — check if TP/SL hit
// Call this on every new candle for IN_TRADE agents
// ─────────────────────────────────────────────

export async function monitorOpenTrade(
  agent: AgentRuntime,
  currentHigh: number,
  currentLow: number,
): Promise<void> {
  const trade = agent.currentTrade;
  if (!trade) return;

  let hit: 'TP_HIT' | 'SL_HIT' | null = null;

  if (trade.direction === 'LONG') {
    if (currentHigh >= trade.currentTp) hit = 'TP_HIT';
    if (currentLow <= trade.currentSl) hit = 'SL_HIT';
  }

  if (trade.direction === 'SHORT') {
    if (currentLow <= trade.currentTp) hit = 'TP_HIT';
    if (currentHigh >= trade.currentSl) hit = 'SL_HIT';
  }

  if (hit) {
    await closeTrade(agent, trade, hit);
  }
}

// ─────────────────────────────────────────────
// Paper entry — simulates fill with slippage
// ─────────────────────────────────────────────

async function executePaperEntry(request: OrderRequest): Promise<OrderResult> {
  // Simulate realistic slippage — 0.02%
  const slippage = request.price * 0.0002;
  const fillPrice = request.direction === 'LONG'
    ? request.price + slippage
    : request.price - slippage;

  const orderId = `paper_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  return {
    success: true,
    orderId,
    fillPrice: Math.round(fillPrice * 100) / 100,
    error: null,
  };
}

// ─────────────────────────────────────────────
// Live entry — places real order on Bybit
// ─────────────────────────────────────────────

async function executeLiveEntry(request: OrderRequest): Promise<OrderResult> {
  try {
    const side = request.direction === 'LONG' ? 'buy' : 'sell';

    const order = await exchange.createOrder(
      request.pair,
      'market',
      side,
      request.positionSize,
      undefined,
      {
        takeProfit: request.tp,
        stopLoss: request.sl,
        timeInForce: 'GoodTillCancel',
      },
    );

    return {
      success: true,
      orderId: order.id,
      fillPrice: order.average ?? order.price ?? request.price,
      error: null,
    };

  } catch (error: any) {
    logger.error('Live order failed', { error: error.message, request });
    return {
      success: false,
      orderId: null,
      fillPrice: null,
      error: error.message,
    };
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
      trade.id,
      trade.pair,
      'market',
      trade.direction === 'LONG' ? 'buy' : 'sell',
      trade.positionSize,
      undefined,
      {
        ...(newTp ? { takeProfit: newTp } : {}),
        ...(newSl ? { stopLoss: newSl } : {}),
      },
    );
  } catch (error: any) {
    logger.error('Failed to update TP/SL on exchange', {
      tradeId: trade.id,
      error: error.message,
    });
  }
}

// ─────────────────────────────────────────────
// Close live position on exchange
// ─────────────────────────────────────────────

async function closeLivePosition(trade: OpenTrade): Promise<number> {
  try {
    const side = trade.direction === 'LONG' ? 'sell' : 'buy';

    const order = await exchange.createOrder(
      trade.pair,
      'market',
      side,
      trade.positionSize,
      undefined,
      { reduceOnly: true },
    );

    return order.average ?? order.price ?? trade.entryPrice;

  } catch (error: any) {
    logger.error('Failed to close live position', {
      tradeId: trade.id,
      error: error.message,
    });
    return trade.entryPrice; // fallback
  }
}

// ─────────────────────────────────────────────
// Partial close — closes X% of position
// ─────────────────────────────────────────────

async function partialCloseTrade(
  agent: AgentRuntime,
  trade: OpenTrade,
  percent: number,
): Promise<void> {
  const closeSize = trade.positionSize * (percent / 100);
  const remainSize = trade.positionSize - closeSize;
  let exitPrice = 0;

  if (agent.mode === 'live') {
    try {
      const side = trade.direction === 'LONG' ? 'sell' : 'buy';
      const order = await exchange.createOrder(
        trade.pair,
        'market',
        side,
        closeSize,
        undefined,
        { reduceOnly: true },
      );
      exitPrice = order.average ?? order.price ?? trade.entryPrice;
    } catch (error: any) {
      logger.error('Partial close failed', { error: error.message });
      return;
    }
  } else {
    exitPrice = await getLatestPrice(agent.pair);
  }

  const partialPnl = calculatePnl(
    trade.direction,
    trade.entryPrice,
    exitPrice,
    closeSize,
  );

  // Update remaining size on trade
  await prisma.trade.update({
    where: { id: trade.id },
    data: { size: remainSize },
  });

  // Update runtime
  trade.positionSize = remainSize;

  logger.info('Partial close executed', {
    tradeId: trade.id,
    closeSize,
    remainSize,
    exitPrice,
    partialPnl,
    percent,
  });
}

// ─────────────────────────────────────────────
// Get latest price — used for paper close
// ─────────────────────────────────────────────

async function getLatestPrice(pair: string): Promise<number> {
  try {
    const ticker = await exchange.fetchTicker(pair);
    return ticker.last ?? ticker.close ?? 0;
  } catch {
    // Fallback to last candle in DB
    const candle = await prisma.candle.findFirst({
      where: { pair, timeframe: '1' },
      orderBy: { timestamp: 'desc' },
    });
    return candle?.close ?? 0;
  }
}

// ─────────────────────────────────────────────
// P&L calculation
// ─────────────────────────────────────────────

function calculatePnl(
  direction: 'LONG' | 'SHORT',
  entry: number,
  exit: number,
  positionSize: number,
): number {
  const priceDiff = direction === 'LONG'
    ? exit - entry
    : entry - exit;

  return Math.round(priceDiff * positionSize * 100) / 100;
}

// ─────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────

export const executionEngine = {
  executeEntry,
  executeManagement,
  closeTrade,
  monitorOpenTrade,
  triggerPendingSignal
};