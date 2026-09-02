/**
 * Signal engine orchestration. Wires the pieces:
 *
 *   AgentOutputs → FeatureAggregator (per-bucket collection)
 *      → on close: composeSignal (weighted composite + direction)
 *      → computeConfidence
 *      → signalFingerprint
 *      → createSignal (atomic, unique-fingerprint deduped)
 *      → publish `memecoin.signal.created` or `perp.signal.created` (evented downstream)
 *
 * The engine is a stateful service (owns the aggregator). Construct once per worker; call
 * `admit(bucket, output)` from your agent-analysis processor.
 */
import type { Db } from '@tip/database';
import { EVENT_NAMES, QUEUE_NAMES, type EventBus } from '@tip/events';
import type { AgentOutput } from './agent-interface.js';
import type { ScoringConfig } from './config.js';
import type { Domain, TradingStyle } from './identity.js';
import { SIGNAL_TTL_MS } from './identity.js';
import { FeatureAggregator, type Bucket } from './feature-aggregator.js';
import { composeSignal } from './scoring.js';
import { computeConfidence } from './confidence.js';
import { signalFingerprint } from './fingerprint.js';
import { createSignal } from './signal-store.js';

export interface TradingAgentSnapshot {
  id: string;
  domain: Domain;
  tradingStyle: TradingStyle;
  configVersion: number;
  config: ScoringConfig;
}

/** Read a TradingAgent's (id → domain / style / active config) at admit time. Injectable. */
export type TradingAgentLookup = (id: string) => Promise<TradingAgentSnapshot | null>;

/**
 * What a Feature contributes at flush time (§40 "Features (not Agents)"). Features have no
 * trigger, so they cannot be `admit`ted like an agent output — they are computed FROM the
 * assembled bucket at flush. The provider returns synthetic `AgentOutput`s (appended to the
 * composite at their configured weight) plus the Brain's `historicalEvidence` sub-metric.
 */
export interface FeatureContribution {
  outputs?: AgentOutput[];
  /** Task-6 confidence sub-metric from the Historical Edge Brain read. */
  historicalEvidence?: number;
}

/**
 * Injectable so the engine stays DB-free and testable: the worker wiring supplies a provider
 * that assembles the domain's feature tuple from the bucket's agent outputs and reads the Brain
 * (`@tip/brain` historicalEdge) as of the bucket's primary-TF close — never wall clock
 * (rules 11/21/22).
 */
export type FeatureProvider = (
  bucket: Bucket,
  agent: TradingAgentSnapshot,
  outputs: readonly AgentOutput[],
) => Promise<FeatureContribution>;

export interface SignalEngineDeps {
  db: Db;
  bus: EventBus;
  /** Look up a TradingAgent's active ScoringConfig snapshot. */
  lookupAgent: TradingAgentLookup;
  /** Optional — supplies Feature contributions (Historical Edge, Volume) at flush time. */
  featureProvider?: FeatureProvider;
  debounceMs?: number;
  log?: (msg: string, meta?: unknown) => void;
  /** Injectable timers for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class SignalEngine {
  private readonly aggregator: FeatureAggregator;
  private readonly deps: SignalEngineDeps;
  private readonly log: (msg: string, meta?: unknown) => void;

  constructor(deps: SignalEngineDeps) {
    this.deps = deps;
    this.log = deps.log ?? (() => {});
    this.aggregator = new FeatureAggregator({
      // Return the promise so the aggregator's close awaits the DB write chain — makes
      // shutdown drains and forceFlushBucket() reliable end-to-end.
      onClose: (bucket, outputs) => this.performFlush(bucket, outputs).catch((e) => this.log('flush failed', { err: String(e) })),
      ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
      ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    });
  }

  admit(bucket: Bucket, output: AgentOutput): void {
    this.aggregator.admit(bucket, output);
  }

  /** Explicit flush for one bucket right now — bypasses the debounce timer. Awaits the DB write. */
  async forceFlushBucket(bucket: Bucket): Promise<void> {
    await this.aggregator.close(bucket);
  }

  async drainAll(): Promise<void> {
    await this.aggregator.drainAll();
  }

  openBuckets(): number {
    return this.aggregator.openBuckets();
  }

  /**
   * Compose the batch → create the signal (deduped by fingerprint) → publish. Test-visible.
   */
  async performFlush(bucket: Bucket, outputs: AgentOutput[]): Promise<void> {
    const agent = await this.deps.lookupAgent(bucket.tradingAgentId);
    if (!agent) return; // Agent gone / archived mid-flight

    // Features (§40) are computed FROM the assembled bucket, not admitted like agent outputs.
    // A provider failure must not lose the signal — the composite is still valid without the
    // 5% feature, so it degrades to "no Brain evidence" rather than dropping the batch.
    let features: FeatureContribution = {};
    if (this.deps.featureProvider) {
      try {
        features = await this.deps.featureProvider(bucket, agent, outputs);
      } catch (e) {
        this.log('feature provider failed; composing without features', { err: String(e) });
      }
    }
    const withFeatures = features.outputs?.length ? [...outputs, ...features.outputs] : outputs;

    const composite = composeSignal(withFeatures, agent.config.agentWeights, agent.config.signalThresholds, agent.domain);
    if (!composite) return; // no eligible agents contributed

    const confidence = computeConfidence(
      {
        compositeScore: composite.compositeScore,
        agentAgreement: composite.agentAgreement,
        ...(features.historicalEvidence !== undefined ? { historicalEvidence: features.historicalEvidence } : {}),
      },
      agent.config.confidenceWeights,
    );

    const fingerprint = signalFingerprint({
      tradingAgentId: bucket.tradingAgentId,
      symbol: bucket.symbol,
      direction: composite.direction,
      primaryTfCloseAt: bucket.primaryTfCloseAt,
    });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SIGNAL_TTL_MS[agent.tradingStyle][agent.domain]);

    const result = await createSignal(this.deps.db, {
      tradingAgentId: bucket.tradingAgentId,
      symbol: bucket.symbol,
      domain: agent.domain,
      direction: composite.direction,
      compositeScore: composite.compositeScore,
      confidence,
      createdAt: now,
      expiresAt,
      configVersion: agent.configVersion,
      fingerprint,
      evidence: {
        agentAgreement: composite.agentAgreement,
        contributingCount: composite.contributingCount,
        contributions: composite.contributions,
      },
      contributions: withFeatures,
    });
    if (!result.created) {
      this.log('signal dedup (same fingerprint already active this candle)', {
        tradingAgentId: bucket.tradingAgentId, symbol: bucket.symbol, direction: composite.direction,
      });
      return;
    }

    // Publish the generic + domain-specific events for downstream consumers (Risk Agent M4c5,
    // Trade Planner M6, Judge M7).
    const domainEventType =
      agent.domain === 'perp' ? EVENT_NAMES.PERP_SIGNAL_CREATED : EVENT_NAMES.MEMECOIN_SIGNAL_CREATED;
    for (const type of [EVENT_NAMES.SIGNAL_CREATED, domainEventType]) {
      await this.deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
        type,
        eventTime: now.toISOString(),
        source: 'signal-engine',
        payload: {
          signalId: result.signalId,
          tradingAgentId: bucket.tradingAgentId,
          symbol: bucket.symbol,
          domain: agent.domain,
          direction: composite.direction,
          compositeScore: composite.compositeScore,
          confidence,
          configVersion: agent.configVersion,
          expiresAt: expiresAt.toISOString(),
        },
      });
    }
    this.log('signal.created', {
      signalId: result.signalId, tradingAgentId: bucket.tradingAgentId, symbol: bucket.symbol,
      direction: composite.direction, score: composite.compositeScore, confidence,
    });
  }
}
