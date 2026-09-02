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
import { EVENT_NAMES, QUEUE_NAMES } from '@tip/events';
import { AsOfMarketData } from '@tip/evaluation';
import { timeframeMs } from '@tip/ingestion';
import { perpAgents, perpHistoricalEdge, PERP_HISTORICAL_EDGE_KEY, recentCandlesAsOf, volumeSignedDirection } from '@tip/agents';
import type { FeatureTuple } from '@tip/brain';
import {
  SignalEngine, PRIMARY_TF,
  type AgentContext, type AgentOutput, type FeatureContribution,
  type ScoringConfig, type TradingAgentSnapshot, type TradingStyle,
} from '@tip/trading-agents';

const marketQueueName = (): typeof QUEUE_NAMES.MARKET_INGESTION => QUEUE_NAMES.MARKET_INGESTION;

interface KlinePayload {
  symbol: string; timeframe: string;
  closeTime: string | Date; open: string; high: string; low: string; close: string;
}

export interface PerpAnalysisDeps {
  db: Db;
  bus: EventBus;
  log?: (msg: string, meta?: unknown) => void;
}

interface RawLiq { side: 'BUY' | 'SELL'; size: number; price: string; timeMs: number }
interface PositioningSnapshot { symbol: string; buyRatio: string; sellRatio: string; longShortRatio: string; time: string }

const LIQ_RETENTION_MS = 6 * 24 * 3600_000; // covers 30 bars of the largest primary TF (4h)

/** One SignalEngine per (agentId) — kept alive so its FeatureAggregator buckets across a bar. */
export class PerpAnalysisTier {
  private readonly engines = new Map<string, SignalEngine>();
  private readonly log: (msg: string, meta?: unknown) => void;
  /**
   * §40.4 CADENCE roll-up state (audit-2 A1: EVENT-triggered agents never fired live — the
   * tier only ever handed agents kline events). Raw liquidation events accumulate here per
   * symbol; each primary-TF close synthesizes the 3-bar-window roll-up the Liquidation agent
   * scores, with intensity vs the trailing 30-bar average. Positioning keeps the latest §40.6
   * poll snapshot per symbol, re-emitted at each close so the agent joins the same bucket.
   */
  private readonly liqEvents = new Map<string, RawLiq[]>();
  private readonly positioningLatest = new Map<string, PositioningSnapshot>();

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
    agent: TradingAgentSnapshot,
    outputs: readonly AgentOutput[],
  ): Promise<FeatureContribution> {
    const byKey = new Map(outputs.map((o) => [o.agent, o]));
    const score = (k: string): number | undefined => byKey.get(k)?.score;

    const regime = byKey.get('perp.market_regime');

    // Derived volatility from regime's ATR ratio: (ratio − 1)/0.5 clamped to [-1,1].
    const atrRatio = regime?.features && typeof (regime.features as Record<string, unknown>).atrRatio === 'number'
      ? (regime.features as { atrRatio: number }).atrRatio : undefined;
    const volatility = atrRatio === undefined ? undefined : Math.max(-1, Math.min(1, (atrRatio - 1) / 0.5));

    // §40.15 Volume feature — THE REAL FORMULA (audit-2 C1: `volumeSignedDirection` existed
    // unused while the composite got nothing and the fingerprint used a momentum-derived
    // proxy): 10-candle volume-signed direction at this bar close.
    const primaryTf = PRIMARY_TF[agent.tradingStyle];
    const volCandles = await recentCandlesAsOf(this.deps.db, bucket.symbol, primaryTf, bucket.primaryTfCloseAt, 10);
    const volume = volCandles.length >= 10
      ? volumeSignedDirection(volCandles.map((c) => ({ open: Number(c.open), close: Number(c.close), volume: Number(c.volume) })))
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
    // Volume contributes independently of the Brain read — it must not vanish when the
    // fingerprint tuple is incomplete.
    const volumeOutput: AgentOutput | null = volume !== undefined ? {
      agent: 'volume', agentVersion: 0,
      direction: volume > 0 ? 'LONG' : volume < 0 ? 'SHORT' : 'NEUTRAL',
      score: volume, confidence: 0.5 + Math.abs(volume) / 2,
      features: { volumeSignedDirection: volume, window: 10 },
    } : null;

    // Rule 24 — a partial tuple must not be fingerprinted. Bail cleanly if any dimension is absent.
    if (Object.values(tuple).some((v) => v === undefined || !Number.isFinite(v))) {
      return volumeOutput ? { outputs: [volumeOutput] } : {};
    }

    let edge;
    try {
      edge = await perpHistoricalEdge(this.deps.db, tuple as FeatureTuple, bucket.primaryTfCloseAt);
    } catch (e) {
      this.log('historical edge read failed; composing without it', { err: String(e) });
      return volumeOutput ? { outputs: [volumeOutput] } : {};
    }

    // Contribute both Features as synthetic outputs — each weighted iff the config lists its
    // key ('historical_edge' 5%, 'volume' 5% per Part III §3) — plus the Task-6
    // historicalEvidence confidence sub-metric.
    const featureOutputs: AgentOutput[] = [{
      agent: PERP_HISTORICAL_EDGE_KEY, agentVersion: 0,
      direction: edge.score > 0 ? 'LONG' : edge.score < 0 ? 'SHORT' : 'NEUTRAL',
      score: edge.score, confidence: edge.historicalEvidence,
      features: { evidence: edge.evidence, effectiveN: edge.effectiveN, backoffDepth: edge.backoffDepth },
    }];
    if (volumeOutput) featureOutputs.push(volumeOutput);
    return { outputs: featureOutputs, historicalEvidence: edge.historicalEvidence };
  }

  /** Build a perp AgentContext bound to the bar close. Wallet readers inert (perp has no wallets). */
  private ctx(agentId: string, configVersion: number, primaryTf: string, now: Date): AgentContext {
    return {
      db: this.deps.db, now, tradingAgentId: agentId, configVersion, domain: 'perp',
      primaryTf: primaryTf as AgentContext['primaryTf'],
      walletScoreAsOf: async () => null, activeClusterMap: async () => new Map(),
    };
  }

  /** Feed the roll-up state from raw market events (liquidations, positioning polls). */
  onMarketEvent(event: DomainEvent): void {
    if (event.type === EVENT_NAMES.PERP_LIQUIDATION_DETECTED) {
      const p = event.payload as { symbol?: string; side?: 'BUY' | 'SELL'; size?: string; price?: string; time?: string };
      if (!p?.symbol || !p.side) return;
      const list = this.liqEvents.get(p.symbol) ?? [];
      list.push({ side: p.side, size: Number(p.size ?? 0), price: p.price ?? '0', timeMs: p.time ? new Date(p.time).getTime() : Date.now() });
      const cutoff = Date.now() - LIQ_RETENTION_MS;
      this.liqEvents.set(p.symbol, list.filter((e) => e.timeMs >= cutoff));
      return;
    }
    if (event.type === EVENT_NAMES.PERP_POSITIONING_POLLED) {
      const p = event.payload as PositioningSnapshot;
      if (p?.symbol) this.positioningLatest.set(p.symbol, p);
    }
  }

  /**
   * Synthesize the §40.4 roll-up + §40.6 snapshot events for one (symbol, primary-TF) bar close.
   * Pure time-window computation over the raw list — no mutation, so agents with DIFFERENT
   * primary TFs each get a window sized to their own bar (3 bars signal, 30 bars baseline).
   */
  private barEvents(symbol: string, tfMs: number, closeTime: Date): DomainEvent[] {
    const out: DomainEvent[] = [];
    const envelope = (type: string, payload: unknown): DomainEvent => ({
      id: `bar-${type}-${closeTime.getTime()}`, type, version: 1,
      eventTime: closeTime.toISOString(), processingTime: new Date().toISOString(),
      source: 'perp-analysis-rollup', payload,
    } as DomainEvent);

    const list = this.liqEvents.get(symbol);
    if (list && list.length > 0) {
      const closeMs = closeTime.getTime();
      const inWindow = list.filter((e) => e.timeMs > closeMs - 3 * tfMs && e.timeMs <= closeMs);
      const in30 = list.filter((e) => e.timeMs > closeMs - 30 * tfMs && e.timeMs <= closeMs);
      const wl = inWindow.filter((e) => e.side === 'SELL').reduce((s, e) => s + e.size, 0); // liquidated longs
      const ws = inWindow.filter((e) => e.side === 'BUY').reduce((s, e) => s + e.size, 0);  // liquidated shorts
      const total = wl + ws;
      const avgPerBar = in30.reduce((s, e) => s + e.size, 0) / 30;
      out.push(envelope(EVENT_NAMES.PERP_LIQUIDATION_DETECTED, {
        symbol, side: wl >= ws ? 'SELL' : 'BUY', size: String(total),
        price: inWindow[inWindow.length - 1]?.price ?? list[list.length - 1]!.price,
        time: closeTime.toISOString(),
        imbalance: total > 0 ? (wl - ws) / total : 0,
        intensityRatio: avgPerBar > 0 ? total / 3 / avgPerBar : 0,
      }));
    }
    const pos = this.positioningLatest.get(symbol);
    if (pos) out.push(envelope(EVENT_NAMES.PERP_POSITIONING_POLLED, pos));
    return out;
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

    // §40.4/§40.6 roll-up: EVENT-triggered agents join the SAME bucket as the kline agents
    // (audit-2 A1: liquidation + positioning never fired live, silently renormalizing 25% of
    // the composite away and starving the 8-dim fingerprint on every single bar).
    const rollups = this.barEvents(p.symbol, timeframeMs(p.timeframe as never), closeTime);

    for (const a of agents) {
      if (PRIMARY_TF[a.style as TradingStyle] !== p.timeframe) continue; // only fire on the primary TF close
      const snap = await this.snapshot(a.id);
      if (!snap) continue;
      const ctx = this.ctx(a.id, snap.configVersion, p.timeframe, closeTime);
      const bucket = { tradingAgentId: a.id, symbol: p.symbol, primaryTfCloseAt: closeTime };
      const engine = this.engineFor(a.id);

      const eventsForBar: DomainEvent[] = [event as DomainEvent, ...rollups];
      let admitted = 0;
      for (const agent of perpAgents) {
        const trigger = eventsForBar.find((e) => agent.canHandle(e));
        if (!trigger) continue;
        try {
          const out = await agent.analyze(trigger, ctx);
          if (out) {
            engine.admit(bucket, out);
            admitted++;
            // §40.3 "Events produced": broadcast the regime so regime-conditioned consumers
            // can subscribe (audit-2: PERP_REGIME_CLASSIFIED had no publisher).
            if (agent.key === 'perp.market_regime' && !out.skipped) {
              await this.deps.bus.publish(marketQueueName(), {
                type: EVENT_NAMES.PERP_REGIME_CLASSIFIED,
                eventTime: closeTime.toISOString(), source: 'perp-analysis',
                payload: { symbol: p.symbol, ...out.features },
              });
            }
          }
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
