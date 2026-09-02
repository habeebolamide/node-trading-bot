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
import { perpAgents, perpHistoricalEdge, PERP_HISTORICAL_EDGE_KEY } from '@tip/agents';
import type { FeatureTuple } from '@tip/brain';
import {
  SignalEngine, PRIMARY_TF,
  type AgentContext, type AgentOutput, type FeatureContribution,
  type ScoringConfig, type TradingAgentSnapshot, type TradingStyle,
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

  /**
   * Historical Edge feature contribution (§40.16) — reads the perp Brain as of the bucket's
   * primary-TF close (never wall clock; rules 11/21/22). Assembles the FULL 8-dimension perp
   * fingerprint tuple (rule 24) from the agents' outputs, then does the Brain read.
   *
   * Six of the eight dimensions are direct agent scores. The remaining two are derived from the
   * fields those agents already emit:
   *   • volatility ← Market Regime's `atrRatio`, mapped so 1.0→MED, 1.5→HIGH, 0.5→LOW.
   *   • volume     ← Momentum's `currentVol/avgVol` expansion, signed by the momentum direction —
   *                  a documented proxy for the §40.15 Volume feature (which needs a candle
   *                  buffer). Confirming volume in the trade direction reads positive.
   * If any dimension is missing (an agent skipped or was disabled), the fingerprint would be a
   * partial tuple — rule 24 forbids that — so we return no contribution and the composite simply
   * omits the 5% Historical Edge term rather than aliasing into a wrong cell.
   */
  private async features(
    bucket: { symbol: string; primaryTfCloseAt: Date },
    _agent: TradingAgentSnapshot,
    outputs: readonly AgentOutput[],
  ): Promise<FeatureContribution> {
    const byKey = new Map(outputs.map((o) => [o.agent, o]));
    const score = (k: string): number | undefined => byKey.get(k)?.score;

    const momentum = byKey.get('perp.momentum');
    const regime = byKey.get('perp.market_regime');

    // Derived volatility from regime's ATR ratio: (ratio − 1)/0.5 clamped to [-1,1].
    const atrRatio = regime?.features && typeof (regime.features as Record<string, unknown>).atrRatio === 'number'
      ? (regime.features as { atrRatio: number }).atrRatio : undefined;
    const volatility = atrRatio === undefined ? undefined : Math.max(-1, Math.min(1, (atrRatio - 1) / 0.5));

    // Derived volume: expansion magnitude signed by momentum direction.
    const mf = momentum?.features as { currentVol?: number; avgVol?: number } | undefined;
    const volume = mf?.currentVol !== undefined && mf.avgVol !== undefined && mf.avgVol > 0
      ? Math.max(-1, Math.min(1, (mf.currentVol / mf.avgVol - 1))) * Math.sign(momentum?.score ?? 0)
      : undefined;

    const tuple: Record<string, number | undefined> = {
      momentum: score('perp.momentum'),
      open_interest: score('perp.open_interest'),
      market_regime: score('perp.market_regime'),
      liquidation: score('perp.liquidation'),
      funding: score('perp.funding'),
      positioning: score('perp.positioning'),
      volume,
      volatility,
    };
    // Rule 24 — a partial tuple must not be fingerprinted. Bail cleanly if any dimension is absent.
    if (Object.values(tuple).some((v) => v === undefined || !Number.isFinite(v))) return {};

    let edge;
    try {
      edge = await perpHistoricalEdge(this.deps.db, tuple as FeatureTuple, bucket.primaryTfCloseAt);
    } catch (e) {
      this.log('historical edge read failed; composing without it', { err: String(e) });
      return {};
    }

    // Contribute as a synthetic agent output (weighted 5% iff the config lists 'historical_edge')
    // plus the Task-6 historicalEvidence confidence sub-metric.
    const syntheticOutput: AgentOutput = {
      agent: PERP_HISTORICAL_EDGE_KEY, agentVersion: 0,
      direction: edge.score > 0 ? 'LONG' : edge.score < 0 ? 'SHORT' : 'NEUTRAL',
      score: edge.score, confidence: edge.historicalEvidence,
      features: { evidence: edge.evidence, effectiveN: edge.effectiveN, backoffDepth: edge.backoffDepth },
    };
    return { outputs: [syntheticOutput], historicalEvidence: edge.historicalEvidence };
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
