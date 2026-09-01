import { describe, it, expect, vi } from 'vitest';
import { FeatureAggregator, type Bucket } from './feature-aggregator.js';
import type { AgentOutput } from './agent-interface.js';

const bucket = (over: Partial<Bucket> = {}): Bucket => ({
  tradingAgentId: 'ta1', symbol: 'BTCUSDT', primaryTfCloseAt: new Date(1_700_000_000_000), ...over,
});
const out = (agent: string, agentVersion = 1, score = 0.5): AgentOutput => ({
  agent, agentVersion, direction: 'LONG', score, confidence: 0.8, features: {},
});

function fakeTimers() {
  const timers: { fn: () => void; cleared: boolean }[] = [];
  return {
    setTimer: (fn: () => void) => { const t = { fn, cleared: false }; timers.push(t); return t; },
    clearTimer: (t: unknown) => { (t as { cleared: boolean }).cleared = true; },
    fireAll: () => { for (const t of timers) if (!t.cleared) t.fn(); },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

describe('FeatureAggregator', () => {
  it('collects outputs into one bucket and closes after the debounce fires', async () => {
    const onClose = vi.fn(async () => {});
    const t = fakeTimers();
    const agg = new FeatureAggregator({ debounceMs: 100, onClose, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const b = bucket();
    agg.admit(b, out('a'));
    agg.admit(b, out('b'));
    expect(agg.openBuckets()).toBe(1);
    t.fireAll();
    await settle();
    expect(onClose).toHaveBeenCalledOnce();
    const outputs = onClose.mock.calls[0]![1] as AgentOutput[];
    expect(outputs.map((o) => o.agent).sort()).toEqual(['a', 'b']);
    expect(agg.openBuckets()).toBe(0);
  });

  it('same (agent, agentVersion) firing twice keeps the newer', async () => {
    const onClose = vi.fn(async () => {});
    const t = fakeTimers();
    const agg = new FeatureAggregator({ debounceMs: 100, onClose, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const b = bucket();
    agg.admit(b, out('a', 1, 0.1));
    agg.admit(b, out('a', 1, 0.9)); // corrects itself (EVENT + CADENCE roll-up)
    t.fireAll();
    await settle();
    const outputs = onClose.mock.calls[0]![1] as AgentOutput[];
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.score).toBe(0.9);
  });

  it('different agentVersion is a distinct entry (upgrade mid-flight)', async () => {
    const onClose = vi.fn(async () => {});
    const t = fakeTimers();
    const agg = new FeatureAggregator({ debounceMs: 100, onClose, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const b = bucket();
    agg.admit(b, out('a', 1));
    agg.admit(b, out('a', 2));
    t.fireAll();
    await settle();
    const outputs = onClose.mock.calls[0]![1] as AgentOutput[];
    expect(outputs).toHaveLength(2);
  });

  it('different buckets are independent', async () => {
    const onClose = vi.fn(async () => {});
    const t = fakeTimers();
    const agg = new FeatureAggregator({ debounceMs: 100, onClose, setTimer: t.setTimer, clearTimer: t.clearTimer });
    agg.admit(bucket({ symbol: 'BTCUSDT' }), out('a'));
    agg.admit(bucket({ symbol: 'ETHUSDT' }), out('b'));
    expect(agg.openBuckets()).toBe(2);
    t.fireAll();
    await settle();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('drainAll flushes pending buckets (shutdown)', async () => {
    const onClose = vi.fn(async () => {});
    const t = fakeTimers();
    const agg = new FeatureAggregator({ debounceMs: 100, onClose, setTimer: t.setTimer, clearTimer: t.clearTimer });
    agg.admit(bucket(), out('a'));
    await agg.drainAll();
    expect(onClose).toHaveBeenCalledOnce();
    expect(agg.openBuckets()).toBe(0);
  });
});
