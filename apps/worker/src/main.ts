import { getConfig, loadEnv } from '@tip/domain';
import { getDb, closeDb } from '@tip/database';
import { createRedis, EventBus } from '@tip/events';
import {
  BybitAdapter,
  BybitRestClient,
  AccountRatioPoller,
  FeedMonitor,
  registerHeliusIngestion,
  HeliusRestClient,
  HeliusLivenessProbe,
  HeliusWebhookAdmin,
  HELIUS_WEBHOOK_FEED,
  HELIUS_REST_FEED,
  DEFAULT_PERP_SYMBOLS,
  DEFAULT_TIMEFRAMES,
  HELIUS_CANARY_WALLET,
} from '@tip/ingestion';
import { HeliusSubscriptionManager, Watchlist, createBuyDetectorHandler, createConvergenceEmitter, type Batcher } from '@tip/watchlist';
import { startWorkers } from './runner.js';
import { PerpAnalysisTier } from './analysis/perp-analysis.js';
import { createJudgeTierHandlers } from './analysis/judge-tier.js';
import { createTickHandler } from './analysis/tick-monitor.js';
import { createWalletExitHandler } from './analysis/wallet-exit-monitor.js';
import { createEntryOrchestrator, expireStaleSignals } from './analysis/entry-orchestrator.js';
import { withEventDedup } from './dedup.js';
import { createTelegramAlertHandler } from './alerts/telegram.js';
import { EVENT_NAMES, QUEUE_NAMES, PRIORITY } from '@tip/events';
import { createDeepSeekClient } from '@tip/llm';
import { tickLifecycle } from '@tip/trading-agents';
import { outcomeSweep } from '@tip/evaluation';
import { refreshAgentMemories } from './analysis/agent-memory-refresh.js';
import type { DomainEvent } from '@tip/domain';
// Side-effect imports that register queue processors go here as milestones add them.

/* eslint-disable no-console */
async function main(): Promise<void> {
  loadEnv(); // hydrate process.env from repo-root .env (no-op in production)
  const config = getConfig(); // validates env; throws FatalError if bad
  const db = getDb();
  const bus = new EventBus(createRedis(config.REDIS_URL));

  const workers = startWorkers(bus, db);
  console.log(`[worker] started ${workers.length} queue worker(s)`);

  // ── Bybit market-data ingestion (M1) ──────────────────────────
  const symbols = [...DEFAULT_PERP_SYMBOLS];
  const timeframes = [...DEFAULT_TIMEFRAMES];
  // Forward-declared so the onStale callback can cross-check the Helius REST feed (§10).
  let monitor: FeedMonitor;
  monitor = new FeedMonitor({
    onStale: (id, age) => {
      // Helius webhook stale while REST is fresh ⇒ webhook path broken, not just quiet (§10).
      if (id === HELIUS_WEBHOOK_FEED && !monitor.isStale(HELIUS_REST_FEED)) {
        console.warn('[staleness] helius WEBHOOK path likely BROKEN — REST reachable but no webhooks arriving');
      } else {
        console.warn(`[staleness] ${id} STALE (${Math.round(age / 1000)}s since last msg)`);
      }
    },
    onRecover: (id, down) => console.log(`[staleness] ${id} recovered (was down ~${Math.round(down / 1000)}s)`),
  });
  const adapter = new BybitAdapter({
    bus,
    db,
    monitor,
    symbols,
    timeframes,
    testnet: config.BYBIT_TESTNET,
    log: (level, msg) => (level === 'warn' ? console.warn : console.log)(`[bybit] ${msg}`),
  });
  const poller = new AccountRatioPoller({
    rest: new BybitRestClient({ testnet: config.BYBIT_TESTNET }),
    bus,
    monitor,
    symbols,
    log: (level, msg) => (level === 'warn' ? console.warn : console.log)(`[bybit-poll] ${msg}`),
  });

  adapter.start();
  poller.start();
  const monitorTimer = setInterval(() => monitor.check(), 5_000);
  console.log(`[worker] bybit ingestion live for ${symbols.join(', ')}`);

  // ── Analysis tier (M4–M7): kline → agents → signals → risk → judge → prediction → paper ──
  const perpAnalysis = new PerpAnalysisTier({ db, bus, log: (m, meta) => console.log(`[analysis] ${m}`, meta ?? '') });
  // ONE worker per queue (audit #11 dispatcher fix): two BullMQ workers on the same queue split
  // the jobs between them — each kline would reach EITHER the tick monitor OR the analysis tier,
  // never both. A single worker fans out in-process. Tick monitor runs FIRST: exits on this bar
  // resolve (freeing capacity, moving lifecycle) before the bar's own analysis fires.
  const tickHandler = createTickHandler({ db, bus, log: (m, meta) => console.log(`[tick] ${m}`, meta ?? '') });
  bus.createWorker<{ symbol: string; timeframe: string; closeTime: string }>(QUEUE_NAMES.MARKET_INGESTION, async (event: DomainEvent<{ symbol: string; timeframe: string; closeTime: string }>) => {
    await tickHandler(event as never);
    if (event.type === EVENT_NAMES.PERP_KLINE_CLOSED) await perpAnalysis.onKline(event as never);
  });
  console.log('[worker] analysis tier + tick monitor live (shared market-queue dispatcher)');

  // ── Signal-processing dispatcher — Judge tier + convergence + Telegram share ONE worker
  //    (same competing-workers rule as the market queue above; registry.ts prescribes this).
  const signalProcessingHandlers: Array<(e: DomainEvent) => Promise<void>> = [];

  // Judge tier (M7) — only when a DeepSeek key is configured (§18 graceful degradation).
  if (config.DEEPSEEK_API_KEY) {
    const llm = createDeepSeekClient({ apiKey: config.DEEPSEEK_API_KEY });
    const { judgeHandler, gateHandler } = createJudgeTierHandlers({ db, bus, llm, log: (m, meta) => console.log(`[judge] ${m}`, meta ?? '') });
    signalProcessingHandlers.push(judgeHandler as (e: DomainEvent) => Promise<void>, gateHandler);
    console.log('[worker] judge tier live (DeepSeek)');
  } else {
    console.log('[worker] judge tier OFF — no DEEPSEEK_API_KEY (predictions stay deterministic)');
  }

  // Entry orchestrator (audit-2 #1) — turns consumable signals into Predictions + paper
  // positions under the §35/§37 gates. Registered AFTER the gate so judge_decision exists when
  // judge.evaluation.completed reaches it.
  signalProcessingHandlers.push(createEntryOrchestrator({
    db, bus, judgeEnabled: Boolean(config.DEEPSEEK_API_KEY),
    log: (m, meta) => console.log(`[entry] ${m}`, meta ?? ''),
  }));
  console.log('[worker] entry orchestrator live (signal → prediction → paper open)');

  // Telegram fast-lane alerts (§11, audit #12) — receipts of committed fills/closes only.
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    signalProcessingHandlers.push(createTelegramAlertHandler({
      botToken: config.TELEGRAM_BOT_TOKEN,
      chatId: config.TELEGRAM_CHAT_ID,
      log: (m, meta) => console.warn(`[telegram] ${m}`, meta ?? ''),
    }));
    console.log('[worker] telegram alerts live');
  } else {
    console.log('[worker] telegram alerts OFF — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set');
  }

  // ── Lifecycle sweep — clears expired COOLDOWN / daily-loss BLOCKED every 30s (§37) ──
  const lifecycleTimer = setInterval(() => { void tickLifecycle(db).catch(() => undefined); }, 30_000);

  // ── Helius memecoin ingestion (M1) ────────────────────────────
  // Always consume webhooks (drains the blockchain-ingestion queue + parses); the REST liveness
  // probe only runs when a key is present.
  const heliusLog = (level: 'info' | 'warn', msg: string): void =>
    (level === 'warn' ? console.warn : console.log)(`[helius] ${msg}`);
  registerHeliusIngestion({ bus, db, monitor, log: heliusLog });
  let heliusProbe: HeliusLivenessProbe | undefined;
  if (config.HELIUS_API_KEY) {
    heliusProbe = new HeliusLivenessProbe({
      rest: new HeliusRestClient({ apiKey: config.HELIUS_API_KEY }),
      monitor,
      canaryWallet: HELIUS_CANARY_WALLET,
      log: heliusLog,
    });
    heliusProbe.start();
    console.log('[worker] helius ingestion + liveness probe active');
  } else {
    console.log('[worker] helius ingestion active (no HELIUS_API_KEY — liveness probe off)');
  }

  // ── Watchlist BuyDetector + Convergence emitter + Helius subscription (M3) ──────
  // BuyDetector: wallet.transaction.detected → watched+rated-at-T → memecoin.wallet.buy.detected
  // Convergence: batches the above per mint → memecoin.wallet.convergence.detected
  // Wallet-exit monitor (audit #11): wallet.transaction.detected SELL → held-fraction decrement
  // → accumulator → WALLET_EXIT close. Shares ONE wallet-analysis worker with the BuyDetector
  // (same dispatcher rule as the market queue above — competing workers would split the events).
  const walletAnalysisHandlers: Array<(e: DomainEvent) => Promise<void>> = [
    createWalletExitHandler({ db, bus, log: (m, meta) => console.log(`[wallet-exit] ${m}`, meta ?? '') }) as (e: DomainEvent) => Promise<void>,
  ];
  let convergenceBatcher: Batcher | undefined;
  if (config.HELIUS_API_KEY && config.HELIUS_WEBHOOK_SECRET && config.HELIUS_WEBHOOK_URL) {
    const rest = new HeliusRestClient({ apiKey: config.HELIUS_API_KEY });
    const admin = new HeliusWebhookAdmin({ apiKey: config.HELIUS_API_KEY });
    const subscription = new HeliusSubscriptionManager({
      db,
      admin,
      config: { webhookURL: config.HELIUS_WEBHOOK_URL, authHeader: config.HELIUS_WEBHOOK_SECRET },
      log: (msg, meta) => console.log(`[helius-sub] ${msg}`, meta ?? ''),
    });
    const watchlist = new Watchlist({
      db,
      rest,
      subscription,
      log: (msg, meta) => console.log(`[watchlist] ${msg}`, meta ?? ''),
    });
    walletAnalysisHandlers.push(createBuyDetectorHandler({
      db,
      bus,
      watchlist,
      log: (msg, meta) => console.log(`[buy-detector] ${msg}`, meta ?? ''),
    }));
    const { batcher, handler: convergenceHandler } = createConvergenceEmitter({
      db,
      bus,
      log: (msg, meta) => console.log(`[convergence] ${msg}`, meta ?? ''),
    });
    signalProcessingHandlers.push(convergenceHandler);
    convergenceBatcher = batcher;
    try {
      await subscription.reconcileAll();
      console.log('[worker] watchlist BuyDetector + Convergence + subscription reconcile active');
    } catch (err) {
      console.warn('[worker] subscription reconcile failed on boot:', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('[worker] watchlist BuyDetector inactive — Helius trio not configured');
  }

  // Single wallet-analysis worker fanning out to wallet-exit (always) + BuyDetector (when the
  // Helius trio is configured). Registered after the conditional so the handler list is final.
  // Both dispatchers ride the §29 event-dedup claim (audit-2: raw workers re-ran effects on
  // BullMQ redelivery).
  bus.createWorker(QUEUE_NAMES.WALLET_ANALYSIS, withEventDedup(db, async (event: DomainEvent) => {
    for (const h of walletAnalysisHandlers) await h(event);
  }));

  // Single signal-processing worker — Judge, gate, entry orchestrator, convergence, Telegram.
  bus.createWorker(QUEUE_NAMES.SIGNAL_PROCESSING, withEventDedup(db, async (event: DomainEvent) => {
    for (const h of signalProcessingHandlers) await h(event);
  }));

  // ── Outcome sweep (§21, audit-2 #2: never scheduled) — resolves elapsed horizons on 1m
  //    candles, feeds the Brain (§41), publishes prediction.resolved (§10's missing producer),
  //    and refreshes the cached brain_agent_memory aggregates (audit-2: never persisted). ──
  const outcomeTimer = setInterval(() => {
    void (async () => {
      const stats = await outcomeSweep(db, {
        mode: 'CANDLE_1M_CONSERVATIVE',
        onResolved: async (predictionId, outcomesWritten) => {
          await bus.publish(QUEUE_NAMES.PREDICTION_EVALUATION, {
            type: EVENT_NAMES.PREDICTION_RESOLVED,
            eventTime: new Date().toISOString(), source: 'outcome-sweep',
            payload: { predictionId, outcomesWritten },
          });
        },
      });
      if (stats.brainWrites > 0) {
        await refreshAgentMemories(db);
        console.log(`[outcome] sweep: ${stats.outcomesWritten} outcomes, ${stats.brainWrites} brain writes`);
      }
      if (stats.errors > 0) console.warn(`[outcome] sweep errors: ${stats.errors}`);
    })().catch((e) => console.warn('[outcome] sweep failed:', e instanceof Error ? e.message : e));
  }, 60_000);

  // ── Signal TTL sweep (§36, audit-2: ACTIVE→EXPIRED never happened) ──
  const signalTtlTimer = setInterval(() => {
    void expireStaleSignals(db).then((n) => { if (n > 0) console.log(`[signals] expired ${n} stale signal(s)`); }).catch(() => undefined);
  }, 60_000);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal} — draining`);
    clearInterval(monitorTimer);
    clearInterval(lifecycleTimer);
    clearInterval(outcomeTimer);
    clearInterval(signalTtlTimer);
    poller.stop();
    adapter.stop();
    heliusProbe?.stop();
    if (convergenceBatcher) await convergenceBatcher.drainAll(); // emit any pending batches
    await bus.close(); // stops accepting, finishes in-flight
    await closeDb(db);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[worker] fatal on startup:', err);
  process.exit(1);
});
