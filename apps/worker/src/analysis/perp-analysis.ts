/**
 * Perp analysis tier (§8, §9, M4 wiring). Consumes `perp.kline.closed` and, for every eligible
 * TradingAgent, runs the perp agents against a point-in-time market view and admits their outputs
 * to that agent's SignalEngine. The engine's own debounced flush composes → creates the signal →
 * publishes `signal.created` (m4-signal-engine already does that).
 *
 * ELIGIBILITY per bar: the agent is perp, not archived, NOT lifecycle-BLOCKED, its universe
 * includes the symbol, and the closed candle's timeframe equals the agent's PRIMARY TF (§8 —
 * the primary TF close is what fires the CADENCE pipeline). One SignalEngine instance is kept
 * per agent so the aggregator buckets correctly.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '@tip/database';
import { scoringConfig, tradingAgent } from '@tip/database';
import type { DomainEvent } from '@tip/domain';
import { marketSymbol } from '@tip/domain';
import type { EventBus } from '@tip/events';
import { AsOfMarketData } from '@tip/evaluation';
import { perpAgents, perpHistoricalEdge } from '@tip/agents';
import { historicalEdge } from '@tip/brain';
import {
  SignalEngine, PRIMARY_TF,
  type AgentContext, type ScoringConfig, type TradingAgentSnapshot, type TradingStyle,
} from '@tip/trading-agents';

interface KlinePayload {
  symbol: string; timeframe: string;
  closeTime: string | Date; open: string; high: string; low: string; close: string;
}

export interface PerpAnalysisDeps {
  db: Db;
  bus: EventBus;
  log?: (msg: string, meta?: unknown) => void;
}

/** One SignalEngine per (agentId) — kept alive so its FeatureAggregator buckets across a bar. */
export class PerpAnalysisTier {
  private readonly engines = new Map<string, SignalEngine>();
  private readonly log: (msg: string, meta?: unknown) => void;

  constructor(private readonly deps: PerpAnalysisDeps) {
    this.log = deps.log ?? (() => {});
  }

  private engineFor(agentId: string): SignalEngine {
    let e = this.engines.get(agentId);
    if (!e) {
      e = new SignalEngine({
        db: this.deps.db,
        bus: this.deps.bus,
        lookupAgent: async (id) => this.snapshot(id),
        featureProvider: async (bucket, agent, outputs) => this.features(bucket, agent, outputs),
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
    return { id: a.id, domain: a.domain as 'perp' | 'memecoin', tradingStyle: a.tradingStyle as TradingStyle,
      configVersion: cfg.version, config: cfg.config as ScoringConfig };
  }

  /** Historical Edge feature contribution — the Brain read as of the bucket's primary-TF close. */
  private async features(bucket: { symbol: string; primaryTfCloseAt: Date }, agent: TradingAgentSnapshot, _outputs: readonly unknown[]) {
    void perpHistoricalEdge; void historicalEdge;
    // Feature computed from the assembled outputs is out of scope for this MVP wiring — the
    // Historical Edge Brain read requires the fingerprint tuple, which the FeatureAggregator
    // doesn't yet assemble here. Return an empty contribution; the composite is unaffected
    // (Historical Edge weight simply doesn't contribute until the tuple assembler lands).
    return {};
  }

  /** Build a perp AgentContext bound to the bar close. Wallet readers inert (perp has no wallets). */
  private ctx(agentId: string, configVersion: number, primaryTf: string, now: Date): AgentContext {
    return {
      db: this.deps.db, now, tradingAgentId: agentId, configVersion, domain: 'perp',
      primaryTf: primaryTf as AgentContext['primaryTf'],
      walletScoreAsOf: async () => null, activeClusterMap: async () => new Map(),
    };
  }

  /** Handle one `perp.kline.closed`. */
  async onKline(event: DomainEvent<KlinePayload>): Promise<void> {
    const p = event.payload;
    if (!p?.symbol || !p.timeframe) return;
    const closeTime = new Date(p.closeTime);

    // Eligible agents: perp, active status, not BLOCKED, universe ∋ symbol, primary TF == this bar.
    const agents = await this.deps.db.select({ id: tradingAgent.id, style: tradingAgent.tradingStyle })
      .from(tradingAgent)
      .where(and(
        eq(tradingAgent.domain, 'perp'),
        eq(tradingAgent.status, 'active'),
        ne(tradingAgent.lifecycleState, 'BLOCKED'),
        sql`${p.symbol} = ANY(${tradingAgent.universe})`,
      ));

    for (const a of agents) {
      if (PRIMARY_TF[a.style as TradingStyle] !== p.timeframe) continue; // only fire on the primary TF close
      const snap = await this.snapshot(a.id);
      if (!snap) continue;
      const view = new AsOfMarketData(this.deps.db, closeTime);
      const ctx = this.ctx(a.id, snap.configVersion, p.timeframe, closeTime);
      const bucket = { tradingAgentId: a.id, symbol: p.symbol, primaryTfCloseAt: closeTime };
      const engine = this.engineFor(a.id);
      void view;

      let admitted = 0;
      for (const agent of perpAgents) {
        if (!agent.canHandle(event)) continue;
        try {
          const out = await agent.analyze(event, ctx);
          if (out) { engine.admit(bucket, out); admitted++; }
        } catch (e) {
          this.log('agent analyze failed', { agent: agent.key, err: String(e) });
        }
      }
      if (admitted > 0) {
        // Force a flush for this bucket now — the bar is closed, no more outputs will arrive.
        await engine.forceFlushBucket(bucket);
      }
    }
  }

  /** Register the processor on the market-ingestion queue (where kline events land). */
  register(): void {
    // Consumes the same queue the Bybit adapter publishes klines to.
    // Note: this is a SECOND consumer of that queue alongside any existing one — BullMQ delivers
    // to one worker per group; for MVP the analysis tier runs in the same worker process.
  }
}
