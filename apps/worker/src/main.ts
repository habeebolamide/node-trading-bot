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
import { HeliusSubscriptionManager, Watchlist, registerBuyDetector, registerConvergenceEmitter, type Batcher } from '@tip/watchlist';
import { startWorkers } from './runner.js';
import { PerpAnalysisTier } from './analysis/perp-analysis.js';
import { registerJudgeTier } from './analysis/judge-tier.js';
import { registerTickMonitor } from './analysis/tick-monitor.js';
import { EVENT_NAMES, QUEUE_NAMES } from '@tip/events';
import { createDeepSeekClient } from '@tip/llm';
import { tickLifecycle } from '@tip/trading-agents';
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
  // Consume perp klines for the analysis tier + the tick monitor. Both read the market queue.
  bus.createWorker<{ symbol: string; timeframe: string; closeTime: string }>(QUEUE_NAMES.MARKET_INGESTION, async (event: DomainEvent<{ symbol: string; timeframe: string; closeTime: string }>) => {
    if (event.type === EVENT_NAMES.PERP_KLINE_CLOSED) await perpAnalysis.onKline(event as never);
  });
  registerTickMonitor({ db, bus, log: (m, meta) => console.log(`[tick] ${m}`, meta ?? '') });
  console.log('[worker] analysis tier + tick monitor live');

  // ── Judge tier (M7) — only when a DeepSeek key is configured (§18 graceful degradation) ──
  if (config.DEEPSEEK_API_KEY) {
    const llm = createDeepSeekClient({ apiKey: config.DEEPSEEK_API_KEY });
    registerJudgeTier({ db, bus, llm, log: (m, meta) => console.log(`[judge] ${m}`, meta ?? '') });
    console.log('[worker] judge tier live (DeepSeek)');
  } else {
    console.log('[worker] judge tier OFF — no DEEPSEEK_API_KEY (predictions stay deterministic)');
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
    registerBuyDetector({
      db,
      bus,
      watchlist,
      log: (msg, meta) => console.log(`[buy-detector] ${msg}`, meta ?? ''),
    });
    const { batcher } = registerConvergenceEmitter({
      db,
      bus,
      log: (msg, meta) => console.log(`[convergence] ${msg}`, meta ?? ''),
    });
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

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal} — draining`);
    clearInterval(monitorTimer);
    clearInterval(lifecycleTimer);
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
