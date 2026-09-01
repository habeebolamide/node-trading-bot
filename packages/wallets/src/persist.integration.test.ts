import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, closeDb, walletTransaction, walletTrade, type Db } from '@tip/database';
import { reconstructWallet } from './persist.js';

// Integration: real Postgres (migration 0002 applied). Skips without DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('trade reconstruction persist (integration, Postgres)', () => {
  let db: Db;
  const wallet = `Wlt${randomUUID().slice(0, 8)}`;
  const mint = `Mnt${randomUUID().slice(0, 8)}`;

  const swap = (action: 'BUY' | 'SELL', sol: string, tokens: string, tSec: number) => ({
    id: randomUUID(), wallet, action, mint, amountSol: sol, tokenAmount: tokens,
    amountUsd: null, blockTime: new Date(1_700_000_000_000 + tSec * 1000), txHash: randomUUID(), slot: null,
  });

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    // trade 1 (win): buy 1000@2 → sell 1000@3.  trade 2 (loss): buy 500@1 → sell 500@0.5
    await db.insert(walletTransaction).values([
      swap('BUY', '2', '1000', 0),
      swap('SELL', '3', '1000', 60),
      swap('BUY', '1', '500', 120),
      swap('SELL', '0.5', '500', 180),
    ]);
  });
  afterAll(async () => {
    if (db) {
      await db.delete(walletTrade).where(eq(walletTrade.wallet, wallet));
      await db.delete(walletTransaction).where(eq(walletTransaction.wallet, wallet));
      await closeDb(db);
    }
  });

  it('reconstructs two closed trades with correct realized outcomes', async () => {
    const summary = await reconstructWallet(db, wallet);
    expect(summary).toEqual({ mints: 1, trades: 2 });

    const rows = await db.select().from(walletTrade).where(eq(walletTrade.wallet, wallet));
    expect(rows).toHaveLength(2);
    const wins = rows.filter((r) => r.won === true);
    const losses = rows.filter((r) => r.won === false);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(rows.every((r) => r.status === 'CLOSED')).toBe(true);
    expect(Number(wins[0]!.realizedReturnPct)).toBeCloseTo(0.5, 6);
    expect(Number(losses[0]!.realizedReturnPct)).toBeCloseTo(-0.5, 6);
  });

  it('is idempotent — re-running replaces, not duplicates', async () => {
    await reconstructWallet(db, wallet);
    await reconstructWallet(db, wallet);
    const rows = await db.select().from(walletTrade).where(eq(walletTrade.wallet, wallet));
    expect(rows).toHaveLength(2);
  });
});
