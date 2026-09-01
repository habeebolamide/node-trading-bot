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

export interface SignalEngineDeps {
  db: Db;
  bus: EventBus;
  /** Look up a TradingAgent's active ScoringConfig snapshot. */
  lookupAgent: TradingAgentLookup;
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

    const composite = composeSignal(outputs, agent.config.agentWeights, agent.config.signalThresholds, agent.domain);
    if (!composite) return; // no eligible agents contributed

    const confidence = computeConfidence(
      { compositeScore: composite.compositeScore, agentAgreement: composite.agentAgreement },
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
      contributions: outputs,
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
