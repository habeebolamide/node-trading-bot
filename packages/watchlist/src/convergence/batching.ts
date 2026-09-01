/**
 * Per-mint batching pen (Part II §9a). Each mint gets its own timer: the first buy opens the pen
 * and starts a `batchingWindowMs` clock; every subsequent buy on the same mint joins the pen;
 * when the clock fires, the batch is handed to `onClose(mint, buys)` and the pen is cleared.
 *
 * In-memory per worker instance (§9a; the window is small and the memecoin fast lane rules out
 * queueing this). A worker restart drops in-flight batches — acceptable because the same buys
 * will re-arrive on reconnect via BullMQ redelivery.
 */
import type { Buy } from './aggregator.js';

export interface BatcherOptions {
  batchingWindowMs: number;
  onClose: (mint: string, buys: Buy[]) => void | Promise<void>;
  /** Injectable timers for tests (defaults to setTimeout/clearTimeout). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface PenState {
  buys: Buy[];
  timer: unknown;
}

export class Batcher {
  private readonly pens = new Map<string, PenState>();
  private readonly windowMs: number;
  private readonly onClose: (mint: string, buys: Buy[]) => void | Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(opts: BatcherOptions) {
    this.windowMs = opts.batchingWindowMs;
    this.onClose = opts.onClose;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Add a buy to its mint's pen; open the pen if it's the first buy on that mint. */
  admit(mint: string, buy: Buy): void {
    let pen = this.pens.get(mint);
    if (!pen) {
      pen = { buys: [], timer: null };
      this.pens.set(mint, pen);
      pen.timer = this.setTimer(() => void this.close(mint), this.windowMs);
    }
    pen.buys.push(buy);
  }

  /** Force-close a mint's pen right now (used by the runner on shutdown). */
  async close(mint: string): Promise<void> {
    const pen = this.pens.get(mint);
    if (!pen) return;
    if (pen.timer !== null) this.clearTimer(pen.timer);
    this.pens.delete(mint);
    if (pen.buys.length > 0) await this.onClose(mint, pen.buys);
  }

  /** Drain everything (worker shutdown). */
  async drainAll(): Promise<void> {
    const mints = [...this.pens.keys()];
    for (const m of mints) await this.close(m);
  }

  /** Test/observability: mints with an open pen right now. */
  openMints(): string[] {
    return [...this.pens.keys()];
  }
}
