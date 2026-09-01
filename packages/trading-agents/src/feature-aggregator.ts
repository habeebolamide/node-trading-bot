/**
 * Feature Aggregator (§9). Collects per-agent AgentOutputs into per-signal buckets, keyed by
 * `(tradingAgentId, symbol, primaryTfCloseTime)`. Same (agentKey, agentVersion) firing twice
 * inside one bucket → keep the newer (agents ARE allowed to correct themselves within a
 * bucket, e.g. EVENT + CADENCE roll-up on Liquidation §40.4).
 *
 * Aggregation window closes on the earlier of:
 *   - a debounce period after the last admitted output (default 500ms), OR
 *   - an explicit close (e.g. next primary-TF tick).
 *
 * On close, hands the batch to `onClose(bucket, outputs)`. In-memory per worker instance —
 * matches m3-convergence's Batcher pattern; a restart drops in-flight buckets (acceptable
 * because the same outputs re-arrive on BullMQ redelivery and reopen a new bucket).
 */
import type { AgentOutput } from './agent-interface.js';

export interface Bucket {
  tradingAgentId: string;
  symbol: string;
  primaryTfCloseAt: Date;
}

export interface AggregatorOptions {
  debounceMs?: number; // default 500ms
  onClose: (bucket: Bucket, outputs: AgentOutput[]) => void | Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface PenState {
  bucket: Bucket;
  outputs: Map<string, AgentOutput>; // key = `${agentKey}|${agentVersion}` — newer overrides older
  timer: unknown;
}

function bucketKey(b: Bucket): string {
  return `${b.tradingAgentId}|${b.symbol}|${b.primaryTfCloseAt.getTime()}`;
}

export class FeatureAggregator {
  private readonly pens = new Map<string, PenState>();
  private readonly debounceMs: number;
  private readonly onClose: AggregatorOptions['onClose'];
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(opts: AggregatorOptions) {
    this.debounceMs = opts.debounceMs ?? 500;
    this.onClose = opts.onClose;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Admit an agent output into the bucket for `(tradingAgentId, symbol, primaryTfCloseAt)`. */
  admit(bucket: Bucket, output: AgentOutput): void {
    const key = bucketKey(bucket);
    let pen = this.pens.get(key);
    if (!pen) {
      pen = { bucket, outputs: new Map(), timer: null };
      this.pens.set(key, pen);
    } else if (pen.timer !== null) {
      this.clearTimer(pen.timer);
    }
    const outputKey = `${output.agent}|${output.agentVersion}`;
    pen.outputs.set(outputKey, output);
    pen.timer = this.setTimer(() => void this.close(bucket), this.debounceMs);
  }

  /** Force-close a bucket right now (e.g. explicit tick). */
  async close(bucket: Bucket): Promise<void> {
    const key = bucketKey(bucket);
    const pen = this.pens.get(key);
    if (!pen) return;
    if (pen.timer !== null) this.clearTimer(pen.timer);
    this.pens.delete(key);
    if (pen.outputs.size > 0) await this.onClose(pen.bucket, [...pen.outputs.values()]);
  }

  /** Drain every bucket (worker shutdown). */
  async drainAll(): Promise<void> {
    const buckets = [...this.pens.values()].map((p) => p.bucket);
    for (const b of buckets) await this.close(b);
  }

  /** Test / observability: number of open buckets. */
  openBuckets(): number {
    return this.pens.size;
  }
}
