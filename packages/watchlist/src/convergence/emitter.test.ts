import { describe, it, expect, vi } from 'vitest';
import type { Db } from '@tip/database';
import { EVENT_NAMES, QUEUE_NAMES, type EventBus } from '@tip/events';
import type { DomainEvent } from '@tip/domain';
import { createConvergenceEmitter } from './emitter.js';

const BUY = (wallet: string, mint: string, sig: string, ms = 0): DomainEvent => ({
  id: `evt-${sig}`,
  type: EVENT_NAMES.MEMECOIN_WALLET_BUY_DETECTED,
  version: 1,
  eventTime: new Date(1_700_000_000_000 + ms).toISOString(),
  processingTime: new Date().toISOString(),
  source: 'buy-detector',
  payload: {
    wallet, walletScore: 80, mint, amountSol: '1', tokenAmount: '1000',
    blockTime: new Date(1_700_000_000_000 + ms).toISOString(), signature: sig, slot: null,
  },
});

/** Injectable timer harness — we fire the window synchronously. */
function fakeTimers(): { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (t: unknown) => void; fireAll: () => void } {
  const timers: { fn: () => void; cleared: boolean }[] = [];
  return {
    setTimer: (fn: () => void): unknown => { const t = { fn, cleared: false }; timers.push(t); return t; },
    clearTimer: (t: unknown): void => { (t as { cleared: boolean }).cleared = true; },
    fireAll: (): void => { for (const t of timers) if (!t.cleared) t.fn(); },
  };
}

function harness(clusters: Map<string, string>) {
  const publish = vi.fn(async () => ({ id: 'e' }));
  const bus = { publish } as unknown as EventBus;
  const timers = fakeTimers();
  const { handler } = createConvergenceEmitter({
    db: {} as Db,
    bus,
    batchingWindowMs: 5000,
    loadClusterMap: async () => clusters,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { publish, handler, fire: timers.fireAll };
}

async function settle(): Promise<void> {
  // Let queued microtasks drain (the onClose callback awaits publish).
  await new Promise((r) => setImmediate(r));
}

describe('convergence emitter', () => {
  it('3 wallets in 3 distinct clusters → one event with independentClusterCount=3', async () => {
    const clusters = new Map([['A', 'c1'], ['B', 'c2'], ['C', 'c3']]);
    const { publish, handler, fire } = harness(clusters);
    await handler(BUY('A', 'M1', 'sA', 0));
    await handler(BUY('B', 'M1', 'sB', 100));
    await handler(BUY('C', 'M1', 'sC', 200));
    fire();
    await settle();
    expect(publish).toHaveBeenCalledOnce();
    const [queue, event] = publish.mock.calls[0]!;
    expect(queue).toBe(QUEUE_NAMES.SIGNAL_PROCESSING);
    expect(event.type).toBe(EVENT_NAMES.MEMECOIN_WALLET_CONVERGENCE_DETECTED);
    expect(event.payload.mint).toBe('M1');
    expect(event.payload.independentClusterCount).toBe(3);
  });

  it('5 wallets sharing one funder → independentClusterCount=1', async () => {
    const clusters = new Map(['A', 'B', 'C', 'D', 'E'].map((w) => [w, 'cSHARED']));
    const { publish, handler, fire } = harness(clusters);
    for (const w of ['A', 'B', 'C', 'D', 'E']) await handler(BUY(w, 'M1', `s${w}`));
    fire();
    await settle();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![1].payload.independentClusterCount).toBe(1);
  });

  it('per-mint pens fire independently', async () => {
    const clusters = new Map<string, string>();
    const { publish, handler, fire } = harness(clusters);
    await handler(BUY('A', 'M1', 'sA'));
    await handler(BUY('B', 'M2', 'sB'));
    fire();
    await settle();
    expect(publish).toHaveBeenCalledTimes(2);
    const mints = publish.mock.calls.map((c) => c[1].payload.mint).sort();
    expect(mints).toEqual(['M1', 'M2']);
  });

  it('ignores unrelated event types', async () => {
    const { publish, handler, fire } = harness(new Map());
    const other: DomainEvent = { ...BUY('A', 'M1', 's'), type: EVENT_NAMES.TOKEN_ACTIVITY_DETECTED };
    await handler(other);
    fire();
    await settle();
    expect(publish).not.toHaveBeenCalled();
  });
});
