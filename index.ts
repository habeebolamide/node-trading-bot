import 'dotenv/config';
import logger from './utils/logger';
import { getNewsContextForPrompt, hasRecentHighImpactNews, startNewsMonitor, stopNewsMonitor } from './markets/news';
import { agentManager } from './agents';
import { BybitWebSocket, candleBuffers, getCandleBuffer, onCandle, seedCandleBuffers } from "./markets/websocket";
import { Candle, CandleInterval } from './types/market.types';
import { detectRegime, isSignificantCandle } from './markets/regime';
import { buildMtfData } from './markets/mtf';

// ─────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received — shutting down`);
  stopNewsMonitor();
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
});

// ─────────────────────────────────────────────
// Boot sequence
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('══════════════════════════════════');
  console.log('  Trading bot starting');
  console.log('══════════════════════════════════');

  // 1. Resume open trades
  await agentManager.resumeOpenTrades();

  // 2. Load agents FIRST — before anything needs them
  await agentManager.loadActiveAgents();
  const agents = agentManager.getAllAgents();
  const uniquePairs = [...new Set(agents.map(a => a.pair))];

  await startNewsMonitor();

  await seedCandleBuffers(uniquePairs);

  // const keys = Object.keys(candleBuffers);
  // keys.forEach(pair => {
  //   const tfs = Object.keys(candleBuffers[pair]);
  //   tfs.forEach(tf => {
  //     console.log(`candleBuffers[${pair}][${tf}] = ${candleBuffers[pair][tf].length} candles`);
  //   });
  // });

  uniquePairs.forEach(pair => {
    onCandle(pair, '5', (candle) => handleCandle(candle));
    onCandle(pair, '60', (candle) => handleCandle(candle));
  });

  const socket = new BybitWebSocket();
  await socket.connectWebSocket();

  console.log('Bot is live — waiting for candles');
}

// ─────────────────────────────────────────────
// Candle handler — fires on every 1h close
// ─────────────────────────────────────────────

async function handleCandle(candle: Candle): Promise<void> {
  const pair = candle.pair;

  logger.info('Candle received', {
    pair,
    interval: candle.interval,  // what is this actually?
    tf: (candle as any).tf // maybe it's stored as 'tf' not 'interval'?
  });

  try {
    // 1. Significance check — free, no API call
    const pair = candle.pair;
    const buffer = getCandleBuffer(pair, candle.interval);
    // const newsAlert = hasRecentHighImpactNews(pair);
    const significant = isSignificantCandle(buffer);


    if (!significant) {
      logger.info('Candle not significant — skipping', { pair });
      return;
    }

    // 2. Build multi-timeframe snapshot
    const mtfData = buildMtfData(pair);
    
    if (!mtfData) {
      logger.warn('Not enough candle history yet', { pair });
      return;
    }

    // 3. Detect regime
    const regime = detectRegime(buffer);
    if (!regime) return;

    // 4. News context
    const newsContext = getNewsContextForPrompt(pair);

    // 5. Process all agents on this pair
    await agentManager.processSignificantCandle(
      candle,
      mtfData,
      regime,
      newsContext,
    );

  } catch (error: any) {
    logger.error('Error in candle handler', {
      pair,
      error: error.message,
    });
    // Never re-throw — one bad candle never kills the bot
  }
}


main().catch((error) => {
  logger.error('Fatal startup error', { error: error.message });
  process.exit(1);
});