import { getConfig, loadEnv, configureLogger, logFilePathFor } from '@tip/domain';
import { getDb, closeDb, tradingAgent } from '@tip/database';
import { eq } from 'drizzle-orm';
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
  DEFAULT_TIMEFRAMES,
  HELIUS_CANARY_WALLET,
} from '@tip/ingestion';
import { IngestionController } from './ingestion-controller.js';
import { HeliusSubscriptionManager, Watchlist, createBuyDetectorHandler, createConvergenceEmitter, type Batcher } from '@tip/watchlist';
import { startWorkers } from './runner.js';
import { PerpAnalysisTier } from './analysis/perp-analysis.js';
import { createJudgeTierHandlers } from './analysis/judge-tier.js';
import { createTickHandler } from './analysis/tick-monitor.js';
import { createWalletExitHandler } from './analysis/wallet-exit-monitor.js';
import { createEntryOrchestrator, expireStaleSignals } from './analysis/entry-orchestrator.js';
import { MemecoinAnalysisTier } from './analysis/memecoin-analysis.js';
import { createMemecoinEntryOrchestrator } from './analysis/memecoin-entry.js';
import { createMemecoinTickHandler } from './analysis/memecoin-tick.js';
import { createShadowInserter } from './analysis/shadow-inserter.js';
import { createRiskAgent, loadPerpRiskInputs } from '@tip/agents';
import { blockAgentsForStaleFeed, unblockAgentsForRecoveredFeed } from '@tip/trading-agents';
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
  // Unified log folder at <repo>/logs/. Worker's own file: logs/worker.log.
  configureLogger({ level: 'debug', file: logFilePathFor('worker', import.meta.url) });
  const db = getDb();
  const bus = new EventBus(createRedis(config.REDIS_URL));

  const workers = startWorkers(bus, db);
  console.log(`[worker] started ${workers.length} queue worker(s)`);

  // ── Bybit market-data ingestion (M1) ──────────────────────────
  // Symbols are derived DYNAMICALLY from the trading_agent table by the IngestionController
  // below — zero perp agents = no WS subscription, first agent creation = live start via
  // trading_agent.upserted event. `symbols` starts empty; the adapter's own start() no-ops
  // WS subscription until setSymbols() lands the first non-empty set.
  const symbols: import('@tip/domain').MarketSymbol[] = [];
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
      // §37 BLOCK the affected agents — "the specific bug that killed the previous bot"
      // (audit-2 #7: the bridge existed, main.ts wired onStale to console.warn only).
      void blockAgentsForStaleFeed(db, id).then((ids: readonly string[]) => {
        if (ids.length > 0) console.warn(`[staleness] BLOCKED ${ids.length} agent(s) for stale feed ${id}`);
      }).catch((e: unknown) => console.warn('[staleness] block failed:', e instanceof Error ? e.message : e));
    },
    onRecover: (id, down) => {
      console.log(`[staleness] ${id} recovered (was down ~${Math.round(down / 1000)}s)`);
      void unblockAgentsForRecoveredFeed(db, id).then((ids: readonly string[]) => {
        if (ids.length > 0) console.log(`[staleness] cleared BLOCKED on ${ids.length} agent(s) for recovered feed ${id}`);
      }).catch((e: unknown) => console.warn('[staleness] unblock failed:', e instanceof Error ? e.message : e));
    },
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

  const monitorTimer = setInterval(() => monitor.check(), 5_000);
  // Dynamic-watchlist controller: derives the live perp symbol set from active trading agents,
  // starts the adapter only when >= 1 exists, resubscribes on every trading_agent.upserted.
  const ingestionController = new IngestionController({
    db, bus, adapter, poller,
    log: (m, meta) => console.log(`[watchlist-ctl] ${m}`, meta ?? ''),
  });
  const initialWl = await ingestionController.start();
  if (initialWl.perp.length === 0) {
    console.log('[worker] bybit ingestion IDLE — zero perp agents (create one to start)');
  } else {
    console.log(`[worker] bybit ingestion live for ${initialWl.perp.join(', ')}`);
  }

  // ── Analysis tier (M4–M7): kline → agents → signals → risk → judge → prediction → paper ──
  const perpAnalysis = new PerpAnalysisTier({ db, bus, log: (m, meta) => console.log(`[analysis] ${m}`, meta ?? '') });
  // ONE worker per queue (audit #11 dispatcher fix): two BullMQ workers on the same queue split
  // the jobs between them — each kline would reach EITHER the tick monitor OR the analysis tier,
  // never both. A single worker fans out in-process. Tick monitor runs FIRST: exits on this bar
  // resolve (freeing capacity, moving lifecycle) before the bar's own analysis fires.
  const tickHandler = createTickHandler({ db, bus, log: (m, meta) => console.log(`[tick] ${m}`, meta ?? '') });
  bus.createWorker<{ symbol: string; timeframe: string; closeTime: string }>(QUEUE_NAMES.MARKET_INGESTION, async (event: DomainEvent<{ symbol: string; timeframe: string; closeTime: string }>) => {
    await tickHandler(event as never);
    // Feed liquidation / positioning raw events into the analysis-tier roll-up buffer BEFORE
    // the kline synthesis fires (audit-2 A1: EVENT-triggered agents never saw their events).
    perpAnalysis.onMarketEvent(event as never);
    if (event.type === EVENT_NAMES.PERP_KLINE_CLOSED) await perpAnalysis.onKline(event as never);
  });
  console.log('[worker] analysis tier + tick monitor live (shared market-queue dispatcher)');

  // ── Signal-processing dispatcher — Risk + Judge + gate + entry orchestrator + convergence
  //    + Telegram share ONE worker (same competing-workers rule as the market queue above).
  const signalProcessingHandlers: Array<(e: DomainEvent) => Promise<void>> = [];

  // Risk Agent (§40.12, audit-2 A3): FIRST on the queue — an INVALIDATED verdict transitions
  // the signal, and downstream handlers all short-circuit on non-ACTIVE state.
  const riskAgent = createRiskAgent({
    bus,
    loadPerpInputs: async (p: { tradingAgentId: string; signalId: string; symbol: string; domain: 'perp' | 'memecoin'; direction: string }) => {
      const a = (await db.select({ style: tradingAgent.tradingStyle }).from(tradingAgent).where(eq(tradingAgent.id, p.tradingAgentId)).limit(1))[0];
      if (!a) return null;
      return loadPerpRiskInputs(db, a.style as never, p);
    },
    log: (m: string, meta?: unknown) => console.log(`[risk] ${m}`, meta ?? ''),
  });
  signalProcessingHandlers.push(async (event: DomainEvent) => {
    if (event.type !== EVENT_NAMES.SIGNAL_CREATED) return;
    const p = event.payload as { tradingAgentId: string; configVersion: number };
    const ctx = {
      db, now: new Date(), tradingAgentId: p.tradingAgentId, configVersion: p.configVersion,
      domain: 'perp' as const, primaryTf: '1h' as const,
      walletScoreAsOf: async () => null, activeClusterMap: async () => new Map(),
    };
    await riskAgent.analyze(event, ctx);
  });
  console.log('[worker] risk agent live');

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

  // Memecoin entry orchestrator (audit-2 Batch D) — same seat, memecoin path.
  // Domain-refuses non-memecoin; runs §9a token claim → planMemecoin → memecoinBuyFill.
  // Without a live reserves resolver every entry NO_FILLs (rule 25 — the plan's own answer).
  signalProcessingHandlers.push(createMemecoinEntryOrchestrator({
    db, bus,
    log: (m, meta) => console.log(`[memecoin-entry] ${m}`, meta ?? ''),
  }));
  console.log('[worker] memecoin entry orchestrator live (NO_FILL until reserves resolver lands — rule 25)');

  // Shadow inserter (§18, audit-2 #12) — subscribes to signal.flipped / signal.stood_aside
  // and materializes the counterfactual shadow prediction + paper position so §23's
  // "is the LLM worth it" question finally has data.
  signalProcessingHandlers.push(createShadowInserter({
    db, bus, log: (m, meta) => console.log(`[shadow] ${m}`, meta ?? ''),
  }));

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

  // ── Batch D schedulers (§4 wallet re-scoring + §5 cluster recompute — audit-2). Both are
  //    cheap idempotent bulk passes; running them on wall-clock intervals is the MVP trigger
  //    the plan describes as "every 25 new trades or a daily job". ──
  const walletRescoreTimer = setInterval(() => {
    void import('@tip/wallets').then(({ scoreAllWallets }) =>
      scoreAllWallets(db, { log: (msg) => console.log(`[wallet-rescore] ${msg}`) }))
      .catch((e) => console.warn('[wallet-rescore] failed:', e instanceof Error ? e.message : e));
  }, 6 * 3600_000); // every 6h — bounded, safe to re-run
  let clusterRecomputeTimer: NodeJS.Timeout | undefined;
  if (config.HELIUS_API_KEY) {
    clusterRecomputeTimer = setInterval(() => {
      void (async () => {
        const [{ recomputeClusters }, { HeliusRestClient }] = await Promise.all([
          import('@tip/watchlist'), import('@tip/ingestion'),
        ]);
        await recomputeClusters(db, {
          rest: new HeliusRestClient({ apiKey: config.HELIUS_API_KEY! }),
          log: (m, meta) => console.log(`[cluster-recompute] ${m}`, meta ?? ''),
        });
      })().catch((e) => console.warn('[cluster-recompute] failed:', e instanceof Error ? e.message : e));
    }, 24 * 3600_000); // once a day
  }

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
    // Batch D: every SELL/BUY swap on a held memecoin mint is a tick — drives evalTick
    // for OPEN memecoin positions (SL/TP/ladder/horizon + token-claim release on close).
    createMemecoinTickHandler({ db, bus, log: (m, meta) => console.log(`[memecoin-tick] ${m}`, meta ?? '') }) as (e: DomainEvent) => Promise<void>,
  ];

  // Batch D: memecoin analysis tier consumes convergence events → runs memecoin agents →
  // Token Risk HARD VETO → SignalEngine composes → publishes signal.created. Registered on
  // the signal-processing dispatcher next to the perp signal path.
  const memecoinAnalysis = new MemecoinAnalysisTier({ db, bus, log: (m, meta) => console.log(`[memecoin-analysis] ${m}`, meta ?? '') });
  signalProcessingHandlers.push(async (event: DomainEvent) => {
    if (event.type === EVENT_NAMES.MEMECOIN_WALLET_CONVERGENCE_DETECTED) {
      await memecoinAnalysis.onConvergence(event as never);
    }
  });
  console.log('[worker] memecoin analysis tier live');
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
    clearInterval(walletRescoreTimer);
    if (clusterRecomputeTimer) clearInterval(clusterRecomputeTimer);
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
