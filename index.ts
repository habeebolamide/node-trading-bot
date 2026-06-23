import 'dotenv/config';
import { getNewsContextForPrompt, hasRecentHighImpactNews, startNewsMonitor, stopNewsMonitor } from './markets/news.js';
import { agentManager } from './agents/index.js';
import { BybitWebSocket, candleBuffers, getCandleBuffer, onCandle, seedCandleBuffers } from "./markets/websocket.js";
import { startDerivativesMonitor } from "./markets/derivatives.js";
import type { Candle, CandleInterval } from './types/market.types.js';
import { detectRegime, isSignificantCandle } from './markets/regime.js';
import { buildMtfData } from './markets/mtf.js';
import { clearTriggers, getTriggerState, hasTriggers, startTimeoutChecker } from './agents/triggers.js';
import { synthesiseLessons } from './learning/index.js';
import { reconcileAgentChallengeToggles, tickActiveChallenges } from './challenge/index.js';
import { executionEngine } from './execution/index.js';
import { prisma } from './lib/prisma.js';
import logger from './utils/logger.js';

declare global {
  var lastAiCall: Record<string, number>;
}

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

  // 1. Load agents FIRST
  await agentManager.loadActiveAgents();

  const agents = agentManager.getAllAgents();

  // 2. Restore full state (VERY IMPORTANT)
  for (const agent of agents) {
    await agentManager.restoreAgentState(agent);
  }
  
  // 3. NOW start timeout system (after triggers exist)
  startTimeoutChecker();

  // 3b. Weekly lesson synthesis — compresses TradeLessons into top-5 LearnedRules.
  // Cadence is anchored to Agent.lastSynthesisAt (DB-persisted), so restarts
  // don't reset the clock. Hourly tick re-evaluates each agent's due-ness.
  startSynthesisRunner();

  // 3c. Challenge mode driver — watches challengeMode toggle flips, evaluates
  // active sessions for terminal states, expires/passes/fails as needed. The
  // reconciler runs frequently (every minute) so toggle UX feels responsive;
  // the hourly tick is a backstop for expiry / unwinnable-equity detection.
  startChallengeChecker();

  // 3d. Live trade reconciler — polls Bybit every 30s and detects positions
  // that the bot still thinks are open but are actually closed on the
  // exchange. Catches missed Private WS close events (silent disconnects,
  // brief reconnect windows where TP/SL fired). Fires an immediate tick on
  // startup so any boot-time stuck trade is resolved within seconds.
  executionEngine.startLiveReconciler();

  // 3c. Wire up immediate reanalysis handlers — fires the moment needsReanalysis
  // or needsManagementReanalysis flips to true (e.g. realtime ticker hit).
  // Lives here because buildMtfData / detectRegime are already imported here,
  // avoiding a circular dep if we tried to import them inside websocket.ts.
  for (const agent of agents) {
    agent.onNeedsReanalysis = async () => {
      const mtfData     = buildMtfData(agent.pair);
      const buffer      = getCandleBuffer(agent.pair, '60');
      const regime      = detectRegime(buffer);
      const newsContext = getNewsContextForPrompt(agent.pair);
      if (!mtfData || !regime) return;
      await agentManager.handleTriggerHit(agent, 'PRICE_UP', null as any, mtfData, regime, newsContext);
    };

    agent.onNeedsManagementReanalysis = async () => {
      const mtfData     = buildMtfData(agent.pair);
      const buffer      = getCandleBuffer(agent.pair, '60');
      const regime      = detectRegime(buffer);
      const newsContext = getNewsContextForPrompt(agent.pair);
      if (!mtfData || !regime) return;
      await agentManager.handleTriggerHit(agent, 'PRICE_UP', null as any, mtfData, regime, newsContext);
    };
  }

  // 4. Setup market data
  const uniquePairs = [...new Set(agents.map(a => a.pair))];

  await seedCandleBuffers(uniquePairs);

  // 4a. Funding rate + open interest — polled in the background and served from
  // cache into the entry prompt (day/swing). Independent of the candle feed, so
  // a slow REST call here never blocks candle seeding or trading.
  await startDerivativesMonitor(uniquePairs);

  // 4a-ii. News + economic-calendar monitor. The LLM has NO web access of its
  // own (DeepSeek / OpenRouter), so it can only weigh news this populates into
  // the prompt — it cannot fetch or verify anything itself. Free, keyless
  // sources, polled every 5 min, try/catch-wrapped: a dead endpoint degrades to
  // an empty NEWS block rather than crashing startup. Previously imported but
  // never called, which left the NEWS block permanently empty.
  await startNewsMonitor();

  // 4b. Replay any entry hits that happened while the bot was offline.
  // Uses the 5m buffer just seeded above; must run AFTER seedCandleBuffers.
  // If this is skipped, agents stay in PENDING_ENTRY on startup even when
  // price clearly crossed the entry level mid-downtime (the user-visible
  // symptom: "Restored → PENDING_ENTRY" log on restart when the trade
  // should have already been open).
  await agentManager.catchUpMissedEntries();

  // 4c. Replay any TP/SL hits on OPEN trades that happened while the bot
  // was offline. Must run AFTER catchUpMissedEntries in case a trade was
  // opened AND closed during the same downtime window. Goes through the
  // standard closeTrade() path, so winRate/monthlyPnL recompute, signal
  // cleanup, challenge evaluation, Telegram alert, and post-mortem all
  // fire as if the close had happened in real time.
  await agentManager.catchUpMissedExits();

  uniquePairs.forEach(pair => {
    onCandle(pair, '5', (candle) => handleCandle(candle));
    onCandle(pair, '60', (candle) => handleCandle(candle));
  });

  // 5. Start websocket (real-time triggers)
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
    const newsAlert = hasRecentHighImpactNews(pair);

    const regime = detectRegime(buffer);

    if (!regime) return;

    // 🔥 pass regime into significance — judged on the CLOSING candle's own
    // timeframe (a 5m close should gauge significance from 5m structure).
    const significant = isSignificantCandle(buffer, regime.regime);

    // Regime SHOWN TO THE LLM is always computed on the 1h buffer, never on the
    // timeframe of whichever candle happened to close. handleCandle is wired to
    // both the 5m and 1h closes (see onCandle calls in main); deriving the
    // headline regime from `candle.interval` meant a 5m close fed the model a
    // 5m-derived regime — which flips NEUTRAL↔TRENDING_BEAR on a sub-0.5% move —
    // while a 1h close fed a 1h regime. Same market, different "regime", decided
    // only by which candle closed. That is what let a 68.07→67.80 dip flip the
    // bias from LONG to SHORT on a manual rerun. Anchor it to the 1h so the
    // model's directional read is stable; this also matches the
    // onNeedsReanalysis path, which already derives regime from the '60' buffer.
    const macroRegime = candle.interval === '60'
      ? regime
      : (detectRegime(getCandleBuffer(pair, '60')) ?? regime);

    // ─────────────────────────────────────────
    // FORCE CHECK SYSTEM
    // ─────────────────────────────────────────

    const now = Date.now();

    // simple in-memory tracker (define above or globally)
    if (!global.lastAiCall) global.lastAiCall = {};
    const lastCall = global.lastAiCall[pair] || 0;

    // 1. TIME FALLBACK (guarantee coverage)
    const forceByTime = now - lastCall > 5 * 60 * 1000; // 5 mins

    // 2. BREAKOUT
    const current = buffer.at(-1)!;
    const recentHigh = Math.max(...buffer.slice(-20, -1).map(c => c.high));
    const recentLow = Math.min(...buffer.slice(-20, -1).map(c => c.low));

    const breakout =
      current.close > recentHigh ||
      current.close < recentLow;

    // 3. (Optional for now) — add later
    const nearLevel = false;
    const regimeChanged = false;

    // Bypass significance gate if any agent already has a pending reanalysis flag
    // set by the realtime ticker — otherwise the flag silently waits until the
    // next "significant" candle, which can be many minutes away in quiet markets.
    const anyAgentNeedsReanalysis = agentManager
      .getAgentsForPair(pair)
      .some(a => a.needsReanalysis || a.needsManagementReanalysis);

    // FINAL DECISION
    const shouldCallAI =
      anyAgentNeedsReanalysis ||
      significant ||
      forceByTime ||
      breakout;

    if (!shouldCallAI) {
      logger.info('Skipped AI call', {
        pair,
        significant,
        forceByTime,
        breakout,
      });
      return;
    }

    // ✅ update last call
    global.lastAiCall[pair] = now;

    // 2. Build multi-timeframe snapshot
    const mtfData = buildMtfData(pair);

    if (!mtfData) {
      logger.warn('Not enough candle history yet', { pair });
      return;
    }

    // 3. News context
    const newsContext = getNewsContextForPrompt(pair);

    // 4. Process all agents on this pair
    await agentManager.processSignificantCandle(
      candle,
      mtfData,
      macroRegime,
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

// ─────────────────────────────────────────────
// Weekly synthesis runner
// ─────────────────────────────────────────────

const SYNTHESIS_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const SYNTHESIS_CHECK_MS = 60 * 60 * 1000; // hourly due-ness check

async function tickSynthesis(): Promise<void> {
  // Re-fetch from DB so lastSynthesisAt reflects writes from prior ticks.
  const agents = await prisma.agent.findMany({
    where:  { status: 'active' },
    select: { id: true, lastSynthesisAt: true },
  });

  const now = Date.now();

  for (const agent of agents) {
    const last = agent.lastSynthesisAt?.getTime() ?? 0;
    if (now - last < SYNTHESIS_INTERVAL_MS) continue;

    try {
      await synthesiseLessons(agent.id);
      await prisma.agent.update({
        where: { id: agent.id },
        data:  { lastSynthesisAt: new Date() },
      });
      logger.info('Synthesis completed', { agentId: agent.id });
    } catch (err: any) {
      logger.error('Synthesis failed', { agentId: agent.id, error: err?.message ?? err });
    }
  }
}

function startSynthesisRunner(): void {
  void tickSynthesis();
  setInterval(() => { void tickSynthesis(); }, SYNTHESIS_CHECK_MS);
}

// ─────────────────────────────────────────────
// Challenge mode runner
// Two cadences:
//   - reconcileAgentChallengeToggles every 60s — picks up challengeMode flips
//     fast enough that the user doesn't feel a lag between toggling on/off
//     and the bot reacting. Also runs evaluateChallenge inline.
//   - tickActiveChallenges hourly — backstop for expiry / unwinnable equity
//     in case no trade closed recently to trigger a check.
// ─────────────────────────────────────────────

const CHALLENGE_RECONCILE_MS = 60_000;       // 60s
const CHALLENGE_HOURLY_MS    = 60 * 60_000;  // 1h

function startChallengeChecker(): void {
  // Initial run on boot — picks up sessions that should already be active
  // (e.g. a crash-restart) and immediately flips any state changes the user
  // made while the bot was down.
  void reconcileAgentChallengeToggles().catch(err =>
    logger.error('Initial challenge reconcile failed', { error: err?.message ?? err }),
  );

  setInterval(() => {
    reconcileAgentChallengeToggles().catch(err =>
      logger.error('Challenge reconcile tick failed', { error: err?.message ?? err }),
    );
  }, CHALLENGE_RECONCILE_MS);

  setInterval(() => {
    tickActiveChallenges().catch(err =>
      logger.error('Challenge hourly tick failed', { error: err?.message ?? err }),
    );
  }, CHALLENGE_HOURLY_MS);
}

main().catch((error) => {
  logger.error('Fatal startup error', { error: error.message });
  process.exit(1);
});