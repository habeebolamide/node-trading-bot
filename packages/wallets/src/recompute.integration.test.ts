import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  createDb, closeDb, walletTrade, wallet as walletTable, walletScoreEvent, brainWalletMemory, tradeOutcome, type Db,
} from '@tip/database';
import { scoreAllWallets } from './recompute.js';
import { walletScoreAsOf } from './score-log.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('wallet scoring pass (integration, Postgres)', () => {
  let db: Db;
  const A = `Wlt${randomUUID().slice(0, 8)}`; // 12 closed → rated
  const B = `Wlt${randomUUID().slice(0, 8)}`; // 3 closed → unrated
  const mint = `Mnt${randomUUID().slice(0, 8)}`;
  const now = new Date('2026-03-01T00:00:00Z');
  const wallets = [A, B];

  const trade = (w: string, i: number, ret: number) => ({
    id: randomUUID(), wallet: w, mint, status: 'CLOSED' as const,
    openedAt: new Date(1_700_000_000_000 + i * 1000), closedAt: new Date(1_700_000_000_000 + i * 1000 + 60_000),
    buyCount: 1, sellCount: 1, totalSolIn: '1', totalSolOut: String(1 + ret),
    tokensBought: '1000', tokensSold: '1000', realizedReturnPct: String(ret), won: ret > 0, holdingPeriodSec: 60, flags: [],
  });

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const rowsA = Array.from({ length: 12 }, (_, i) => trade(A, i, i % 2 === 0 ? 0.3 : -0.1));
    const rowsB = Array.from({ length: 3 }, (_, i) => trade(B, i, 0.2));
    await db.insert(walletTrade).values([...rowsA, ...rowsB]);
  });
  afterAll(async () => {
    if (db) {
      await db.delete(walletTrade).where(inArray(walletTrade.wallet, wallets));
      await db.delete(walletScoreEvent).where(inArray(walletScoreEvent.walletId, wallets));
      await db.delete(brainWalletMemory).where(inArray(brainWalletMemory.walletId, wallets));
      await db.delete(tradeOutcome).where(inArray(tradeOutcome.walletId, wallets));
      await db.delete(walletTable).where(inArray(walletTable.address, wallets));
      await closeDb(db);
    }
  });

  it('scores the ≥10-trade wallet, leaves the thin one UNRATED, and logs point-in-time', async () => {
    const result = await scoreAllWallets(db, { now });
    // (other test wallets may exist in a shared DB; assert on OUR two specifically)
    expect(result.scored.some((s) => s.walletId === A)).toBe(true);
    expect(result.scored.some((s) => s.walletId === B)).toBe(false);

    // rated wallet has a score as of now, and NONE before it (rule 21: never returns the future)
    const asOfNow = await walletScoreAsOf(db, A, now);
    expect(asOfNow).not.toBeNull();
    expect(asOfNow!.score).toBeGreaterThanOrEqual(0);
    const asOfBefore = await walletScoreAsOf(db, A, new Date(now.getTime() - 1000));
    expect(asOfBefore).toBeNull();

    // unrated wallet is never scored
    expect(await walletScoreAsOf(db, B, now)).toBeNull();

    // profiles reflect rating status
    const profiles = await db.select().from(walletTable).where(inArray(walletTable.address, wallets));
    expect(profiles.find((p) => p.address === A)!.status).toBe('rated');
    expect(profiles.find((p) => p.address === B)!.status).toBe('unrated');
  });
});
