import { describe, it, expect, vi } from 'vitest';
import { Batcher } from './batching.js';
import type { Buy } from './aggregator.js';

const buy = (wallet: string, sig: string): Buy => ({
  wallet, walletScore: 80, amountSol: '1', tokenAmount: '1000',
  blockTime: new Date().toISOString(), signature: sig,
});

/** Injectable timer harness — we control when timers fire. */
function fakeTimers(): { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (t: unknown) => void; fireAll: () => void } {
  const timers: { fn: () => void; cleared: boolean }[] = [];
  return {
    setTimer: (fn: () => void, _ms: number): unknown => {
      const t = { fn, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t: unknown): void => { (t as { cleared: boolean }).cleared = true; },
    fireAll: (): void => { for (const t of timers) if (!t.cleared) t.fn(); },
  };
}

describe('Batcher', () => {
  it('opens a pen on first buy per mint and closes with all admitted buys when the timer fires', async () => {
    const onClose = vi.fn(async () => {});
    const timers = fakeTimers();
    const b = new Batcher({ batchingWindowMs: 100, onClose, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    b.admit('M1', buy('A', 's1'));
    b.admit('M1', buy('B', 's2'));
    expect(b.openMints()).toEqual(['M1']);
    timers.fireAll();
    await Promise.resolve(); // let the close await settle
    expect(onClose).toHaveBeenCalledOnce();
    const [mint, buys] = onClose.mock.calls[0]!;
    expect(mint).toBe('M1');
    expect(buys).toHaveLength(2);
    expect(b.openMints()).toEqual([]);
  });

  it('keeps per-mint pens independent (different mints, one timer each)', async () => {
    const onClose = vi.fn(async () => {});
    const timers = fakeTimers();
    const b = new Batcher({ batchingWindowMs: 100, onClose, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    b.admit('M1', buy('A', 's1'));
    b.admit('M2', buy('B', 's2'));
    expect(b.openMints().sort()).toEqual(['M1', 'M2']);
    timers.fireAll();
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledTimes(2);
    const mints = onClose.mock.calls.map((c) => c[0]).sort();
    expect(mints).toEqual(['M1', 'M2']);
  });

  it('drainAll emits pending batches (used on shutdown)', async () => {
    const onClose = vi.fn(async () => {});
    const timers = fakeTimers();
    const b = new Batcher({ batchingWindowMs: 100, onClose, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    b.admit('M1', buy('A', 's1'));
    await b.drainAll();
    expect(onClose).toHaveBeenCalledOnce();
    expect(b.openMints()).toEqual([]);
  });
});
