import { describe, it, expect, vi } from 'vitest';
import { EVENT_NAMES, QUEUE_NAMES, type EventBus } from '@tip/events';
import type { DomainEvent } from '@tip/domain';
import type { Db } from '@tip/database';
import { createBuyDetectorHandler, type BuyDetectorDeps } from './buy-detector.js';
import type { Watchlist } from './store.js';

// The handler reads walletScoreAsOf directly from @tip/wallets. Mock it at the module boundary
// so the test controls score presence without touching the DB.
vi.mock('@tip/wallets', () => ({
  walletScoreAsOf: vi.fn(),
}));
const { walletScoreAsOf } = await import('@tip/wallets');

const buyEvent = (over: Record<string, unknown> = {}): DomainEvent => ({
  id: 'evt-1',
  type: EVENT_NAMES.WALLET_TRANSACTION_DETECTED,
  version: 1,
  eventTime: '2026-06-01T00:00:00.000Z',
  processingTime: '2026-06-01T00:00:00.100Z',
  source: 'helius-adapter',
  payload: {
    wallet: 'Wallet1', action: 'BUY', mint: 'Mint1',
    amountSol: '1', tokenAmount: '1000',
    blockTime: '2026-06-01T00:00:00.000Z', signature: 'sig1', slot: 42, ...over,
  },
});

function harness(watched: boolean, score: { score: number } | null): { publish: ReturnType<typeof vi.fn>; handler: (e: DomainEvent) => Promise<void> } {
  const publish = vi.fn(async () => ({ id: 'e' }));
  const bus = { publish } as unknown as EventBus;
  const watchlist = { isWatched: vi.fn(async () => watched) } as unknown as Watchlist;
  const deps: BuyDetectorDeps = { db: {} as Db, bus, watchlist };
  (walletScoreAsOf as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(score);
  return { publish, handler: createBuyDetectorHandler(deps) };
}

describe('BuyDetector', () => {
  it('drops unwatched wallets', async () => {
    const { publish, handler } = harness(false, { score: 80 });
    await handler(buyEvent());
    expect(publish).not.toHaveBeenCalled();
  });

  it('drops SELL actions', async () => {
    const { publish, handler } = harness(true, { score: 80 });
    await handler(buyEvent({ action: 'SELL' }));
    expect(publish).not.toHaveBeenCalled();
  });

  it('drops UNRATED wallets at block time (rule 21)', async () => {
    const { publish, handler } = harness(true, null); // walletScoreAsOf returns null
    await handler(buyEvent());
    expect(publish).not.toHaveBeenCalled();
  });

  it('emits memecoin.wallet.buy.detected with score for a watched, rated BUY', async () => {
    const { publish, handler } = harness(true, { score: 82.5 });
    await handler(buyEvent());
    expect(publish).toHaveBeenCalledOnce();
    const [queue, event] = publish.mock.calls[0]!;
    expect(queue).toBe(QUEUE_NAMES.SIGNAL_PROCESSING);
    expect(event.type).toBe(EVENT_NAMES.MEMECOIN_WALLET_BUY_DETECTED);
    expect(event.payload).toMatchObject({
      wallet: 'Wallet1', mint: 'Mint1', walletScore: 82.5, amountSol: '1', signature: 'sig1',
    });
  });

  it('ignores unrelated event types', async () => {
    const { publish, handler } = harness(true, { score: 80 });
    const other: DomainEvent = { ...buyEvent(), type: EVENT_NAMES.TOKEN_ACTIVITY_DETECTED };
    await handler(other);
    expect(publish).not.toHaveBeenCalled();
  });
});
