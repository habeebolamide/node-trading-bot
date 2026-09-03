/**
 * Memecoin analysis tier (Part II §9, §9a — audit-2 Batch D #14: the entire memecoin chain
 * after `memecoin.wallet.convergence.detected` was inert; convergence events were persisted
 * to `domain_event` and read only by the dashboard).
 *
 * Fires on convergence events (the primary trigger — a cluster-quality-scored batch of
 * buys on one mint). For every eligible memecoin TradingAgent:
 *   1. Universe filter (memecoin agents' universe is `['solana']` by convention).
 *   2. Runs the composite memecoin agents against the payload — Convergence (§40.8),
 *      Smart-Money (§40.7) for each buy in the batch, Market Regime (§40.11 — SOL kline),
 *      Momentum (§40.9 — token candle if any), Token Quality (§40.10 — BrainTokenMemory read).
 *   3. Applies the Token Risk HARD VETO (§40.13 / §9a): a rug flag kills the composite entry
 *      for THIS agent, no signal published, veto recorded on signal_no_trade after the fact.
 *   4. Admits surviving outputs to the agent's SignalEngine (already built), which composes
 *      the opportunity score, applies the signalThreshold, and publishes signal.created.
 *
 * The per-agent SignalEngine is kept alive so the FeatureAggregator's debounce (§9) can batch
 * multiple convergence events for the same mint in the same window. The bucket key is
 * `(agentId, mint)` with `primaryTfCloseAt = batchClosedAt` — replay-safe (§25) since the
 * convergence emitter records both event and processing clocks.
 *
 * NOTE ON MEMECOIN AGENTS' triggers: the individual agents' `canHandle` gates each on its own
 * event type. Rather than fanning out multiple events per convergence, the tier synthesizes
 * the trigger events each agent expects (a `memecoin.wallet.buy.detected` per buy for
 * smart-money, a `token.activity.detected` for token-risk) and lets `canHandle` dispatch.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { paperPosition, scoringConfig, tradingAgent, type Db } from '@tip/database';
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES, type EventBus } from '@tip/events';
import { memecoinAgents, isVetoed, memecoinTokenRiskAgent } from '@tip/agents';
import {
  SignalEngine,
  type AgentContext, type AgentOutput, type ScoringConfig, type TradingAgentSnapshot, type TradingStyle,
} from '@tip/trading-agents';

interface ConvergencePayload {
  mint: string;
  batchOpenedAt: string;
  batchClosedAt: string;
  buys: Array<{
    wallet: string; walletScore: number | null;
    amountSol: string; tokenAmount: string;
    blockTime: string; signature: string;
  }>;
  convergenceScore: number;
  independentClusterCount: number;
  timeCompression: number;
  perCluster?: Array<{ clusterId: string; wallets: string[] }>;
}

export interface MemecoinAnalysisDeps {
  db: Db;
  bus: EventBus;
  log?: (msg: string, meta?: unknown) => void;
}

export class MemecoinAnalysisTier {
  private readonly engines = new Map<string, SignalEngine>();
  private readonly log: (msg: string, meta?: unknown) => void;

  constructor(private readonly deps: MemecoinAnalysisDeps) {
    this.log = deps.log ?? (() => {});
  }

  private engineFor(agentId: string): SignalEngine {
    let e = this.engines.get(agentId);
    if (!e) {
      e = new SignalEngine({
        db: this.deps.db,
        bus: this.deps.bus,
        lookupAgent: async (id) => this.snapshot(id),
        log: this.log,
      });
      this.engines.set(agentId, e);
    }
    return e;
  }

  private async snapshot(agentId: string): Promise<TradingAgentSnapshot | null> {
    const a = (await this.deps.db.select().from(tradingAgent).where(eq(tradingAgent.id, agentId)).limit(1))[0];
    if (!a) return null;
    const cfg = (await this.deps.db.select().from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, agentId), eq(scoringConfig.active, true))).limit(1))[0];
    if (!cfg) return null;
    return {
      id: a.id, domain: a.domain as 'perp' | 'memecoin', tradingStyle: a.tradingStyle as TradingStyle,
      configVersion: cfg.version, config: cfg.config as ScoringConfig,
    };
  }

  private ctx(agentId: string, configVersion: number, now: Date): AgentContext {
    return {
      db: this.deps.db, now, tradingAgentId: agentId, configVersion, domain: 'memecoin',
      primaryTf: '5m', // memecoin momentum + regime read 5m; a per-agent override is future work
      walletScoreAsOf: async () => null,
      activeClusterMap: async () => new Map(),
    };
  }

  /** Handle one `memecoin.wallet.convergence.detected`. */
  async onConvergence(event: DomainEvent<ConvergencePayload>): Promise<void> {
    const p = event.payload;
    if (!p?.mint || !Array.isArray(p.buys)) return;
    const at = new Date(p.batchClosedAt);

    // Eligible memecoin agents: active, not BLOCKED, universe includes 'solana' (the chain).
    // Also honor the pre-filter: an agent already holding a memecoin position at capacity
    // still runs analysis (so the composite gets scored), but the entry orchestrator will
    // refuse. Keeping composition-vs-execution separate lets the dashboard show what WOULD
    // have fired even when capacity is exhausted.
    const agents = await this.deps.db.select({ id: tradingAgent.id, style: tradingAgent.tradingStyle })
      .from(tradingAgent)
      .where(and(
        eq(tradingAgent.domain, 'memecoin'),
        eq(tradingAgent.status, 'active'),
        ne(tradingAgent.lifecycleState, 'BLOCKED'),
        sql`'solana' = ANY(${tradingAgent.universe})`,
      ));

    if (agents.length === 0) return;

    // Token-risk verdict is agent-agnostic (the mint either fails checks or doesn't).
    // Compute ONCE and reuse across every agent's bucket.
    const tokenRiskCtx = this.ctx('__token_risk__', 0, at);
    const tokenRiskEvent: DomainEvent = {
      id: `synthetic-token-risk-${p.mint}-${at.getTime()}`,
      type: EVENT_NAMES.TOKEN_ACTIVITY_DETECTED, version: 1,
      eventTime: p.batchClosedAt, processingTime: new Date().toISOString(),
      source: 'memecoin-analysis',
      payload: { mint: p.mint }, // minimum shape — token-risk uses lookup for real profile
    };
    const tokenRiskOut = await memecoinTokenRiskAgent.analyze(tokenRiskEvent, tokenRiskCtx).catch(() => null);
    if (tokenRiskOut && isVetoed(tokenRiskOut)) {
      // §9a HARD VETO — the mint is dropped for every agent, no composite scored.
      this.log('token-risk HARD VETO — mint dropped for all agents', {
        mint: p.mint, reasons: (tokenRiskOut.features as { reasons?: string[] }).reasons ?? [],
      });
      return;
    }

    for (const a of agents) {
      const snap = await this.snapshot(a.id);
      if (!snap) continue;
      const ctx = this.ctx(a.id, snap.configVersion, at);
      const bucket = { tradingAgentId: a.id, symbol: p.mint, primaryTfCloseAt: at };
      const engine = this.engineFor(a.id);
      let admitted = 0;

      // 1. Convergence agent — takes the convergence event as-is.
      try {
        const out = await this.runAgent('memecoin.convergence', event, ctx);
        if (out) { engine.admit(bucket, out); admitted++; }
      } catch (e) { this.log('convergence agent failed', { agent: a.id, err: String(e) }); }

      // 2. Smart-money — one output per rated buy in the batch. The engine aggregator will
      //    take the LATEST by (agentKey, agentVersion), so we condense: pick the buy with the
      //    highest wallet score (the strongest smart-money signal in the cluster).
      const bestBuy = [...p.buys].filter((b) => typeof b.walletScore === 'number' && b.walletScore > 0)
        .sort((x, y) => (y.walletScore! - x.walletScore!))[0];
      if (bestBuy) {
        const buyEvent: DomainEvent = {
          id: `synthetic-buy-${bestBuy.signature}`, type: EVENT_NAMES.MEMECOIN_WALLET_BUY_DETECTED, version: 1,
          eventTime: bestBuy.blockTime, processingTime: new Date().toISOString(), source: 'memecoin-analysis',
          payload: { wallet: bestBuy.wallet, mint: p.mint, walletScore: bestBuy.walletScore,
                     amountSol: bestBuy.amountSol, tokenAmount: bestBuy.tokenAmount,
                     signature: bestBuy.signature, blockTime: bestBuy.blockTime },
        };
        try {
          const out = await this.runAgent('memecoin.smart_money', buyEvent, ctx);
          if (out) { engine.admit(bucket, out); admitted++; }
        } catch (e) { this.log('smart-money agent failed', { agent: a.id, err: String(e) }); }
      }

      // 3. Momentum + Market Regime — best-effort. Momentum reads token candles (which we may
      //    not have built yet from swaps) and Regime reads SOL klines (which the perp backfill
      //    populates iff SOLUSDT is loaded). Failures degrade the composite gracefully.
      const momentumTrigger: DomainEvent = {
        id: `synthetic-token-candle-${p.mint}-${at.getTime()}`, type: 'memecoin.token.candle.closed', version: 1,
        eventTime: p.batchClosedAt, processingTime: new Date().toISOString(), source: 'memecoin-analysis',
        payload: { mint: p.mint, closeTime: p.batchClosedAt },
      };
      const regimeTrigger: DomainEvent = {
        id: `synthetic-sol-regime-${at.getTime()}`, type: EVENT_NAMES.PERP_KLINE_CLOSED, version: 1,
        eventTime: p.batchClosedAt, processingTime: new Date().toISOString(), source: 'memecoin-analysis',
        payload: { symbol: 'SOLUSDT', timeframe: '5m', closeTime: p.batchClosedAt,
                   open: '0', high: '0', low: '0', close: '0', volume: '0' },
      };
      for (const [k, e] of [['memecoin.momentum', momentumTrigger], ['memecoin.market_regime', regimeTrigger]] as const) {
        try {
          const out = await this.runAgent(k, e, ctx);
          if (out) { engine.admit(bucket, out); admitted++; }
        } catch (err) { this.log(`${k} agent failed`, { agent: a.id, err: String(err) }); }
      }

      if (admitted > 0) {
        // Attach the token-risk output onto the signal_feature record via a synthetic output
        // (score 0, confidence 1, direction NEUTRAL — doesn't move the composite; §9a
        // "non-directional agent") so downstream can still inspect it.
        if (tokenRiskOut) engine.admit(bucket, tokenRiskOut);
        await engine.forceFlushBucket(bucket);
      }
    }
  }

  /** Look up an agent by key and call it. Returns null if the agent doesn't `canHandle` here. */
  private async runAgent(key: string, event: DomainEvent, ctx: AgentContext): Promise<AgentOutput | null> {
    const agent = memecoinAgents.find((a) => a.key === key);
    if (!agent || !agent.canHandle(event)) return null;
    return agent.analyze(event, ctx);
  }

  /** Total non-shadow memecoin positions currently held (for the entry-orchestrator's own use). */
  static async openMemecoinCount(db: Db, agentId: string): Promise<number> {
    const r = await db.select({ n: sql<number>`count(*)::int` })
      .from(paperPosition)
      .innerJoin(sql`(SELECT id FROM paper_portfolio WHERE trading_agent_id = ${agentId}) p`, sql`p.id = ${paperPosition.portfolioId}`)
      .where(and(
        eq(paperPosition.domain, 'memecoin'),
        eq(paperPosition.isShadow, false),
        sql`${paperPosition.state} IN ('OPEN', 'PENDING_ENTRY')`,
      ));
    return Number(r[0]!.n);
  }
}
