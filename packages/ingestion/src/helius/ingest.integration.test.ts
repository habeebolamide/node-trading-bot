import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DomainEvent } from '@tip/domain';
import { createDb, closeDb, walletTransaction, token, processedEvent, type Db } from '@tip/database';
import { EVENT_NAMES, type EventBus } from '@tip/events';
import { FeedMonitor } from '../staleness/monitor.js';
import { createHeliusHandler } from './ingest.js';

// Integration: real Postgres (tx_hash + event-id idempotency, §29). Skips without DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('Helius ingest (integration, Postgres)', () => {
  let db: Db;
  const wallet = `Wlt${randomUUID().slice(0, 8)}`;
  const mint = `Mnt${randomUUID().slice(0, 8)}`;
  const sig = `Sig${randomUUID().slice(0, 10)}`;

  beforeAll(() => {
    db = createDb(DATABASE_URL!);
  });
  afterAll(async () => {
    if (db) {
      await db.delete(walletTransaction).where(eq(walletTransaction.txHash, sig));
      await db.delete(token).where(eq(token.mint, mint));
      await closeDb(db);
    }
  });

  const swapEvent = (id: string): DomainEvent => ({
    id,
    type: EVENT_NAMES.HELIUS_WEBHOOK_RECEIVED,
    version: 1,
    eventTime: '2026-09-01T00:00:00.000Z',
    processingTime: '2026-09-01T00:00:00.000Z',
    source: 'test',
    payload: [
      {
        type: 'SWAP', feePayer: wallet, signature: sig, slot: 5, timestamp: 1_700_000_000,
        tokenTransfers: [{ toUserAccount: wallet, mint, tokenAmount: 1000 }],
        nativeTransfers: [{ fromUserAccount: wallet, amount: 2_000_000_000 }],
      },
    ],
  });

  it('persists a parsed swap once and publishes for the new row; re-delivery adds nothing', async () => {
    const publish = vi.fn(async () => ({ id: 'e' }));
    const bus = { publish } as unknown as EventBus;
    const handler = createHeliusHandler({ db, bus, monitor: new FeedMonitor() });

    // first delivery
    await handler(swapEvent(`evt-${randomUUID()}`));
    let rows = await db.select().from(walletTransaction).where(eq(walletTransaction.txHash, sig));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('BUY');
    expect(rows[0]!.amountSol).toBe('2');
    expect(rows[0]!.amountUsd).toBeNull(); // M2 enrichment
    const typesAfterFirst = publish.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(typesAfterFirst).toContain(EVENT_NAMES.WALLET_TRANSACTION_DETECTED);
    expect(typesAfterFirst).toContain(EVENT_NAMES.TOKEN_ACTIVITY_DETECTED);

    const publishCountAfterFirst = publish.mock.calls.length;

    // SAME signature, DIFFERENT event id → tx_hash dedup: no new row, no new publish
    await handler(swapEvent(`evt-${randomUUID()}`));
    rows = await db.select().from(walletTransaction).where(eq(walletTransaction.txHash, sig));
    expect(rows).toHaveLength(1);
    expect(publish.mock.calls.length).toBe(publishCountAfterFirst);
  });
});
