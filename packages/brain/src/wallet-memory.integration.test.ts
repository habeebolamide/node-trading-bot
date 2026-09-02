import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb, closeDb, brainWalletMemory, walletCluster, walletTrade, type Db } from '@tip/database';
import {
  computeWalletBehavior, walletMemoryAsOf, persistWalletBehavior,
  WALLET_HALFLIFE_DAYS, WALLET_RATING_MIN_EFFECTIVE_N,
} from './wallet-memory.js';

const DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;
const T = new Date('2026-06-01T00:00:00Z');

describe.skipIf(!DATABASE_URL)('Wallet Memory (integration, Postgres)', () => {
  let db: Db;
  const wallets: string[] = [];
  const clusterIds: string[] = [];

  function newWallet(): string {
    const w = `WM${randomUUID().replace(/-/g, '').slice(0, 30)}`;
    wallets.push(w);
    return w;
  }

  async function addTrade(wallet: string, over: {
    closedAt?: Date | null; status?: string; solIn?: number; holdSec?: number | null; mint?: string; openedAt?: Date;
  } = {}) {
    const closedAt = over.closedAt === undefined ? T : over.closedAt;
    await db.insert(walletTrade).values({
      id: randomUUID(),
      wallet,
      mint: over.mint ?? 'MINT_A',
      status: over.status ?? 'CLOSED',
      openedAt: over.openedAt ?? new Date(T.getTime() - 10 * DAY_MS),
      closedAt,
      buyCount: 1, sellCount: 1,
      totalSolIn: String(over.solIn ?? 2), totalSolOut: '3',
      tokensBought: '1000', tokensSold: '1000',
      realizedReturnPct: '0.5', won: true,
      holdingPeriodSec: over.holdSec === undefined ? 3600 : over.holdSec,
      flags: [],
    });
  }

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      if (wallets.length) {
        await db.delete(walletTrade).where(inArray(walletTrade.wallet, wallets));
        await db.delete(brainWalletMemory).where(inArray(brainWalletMemory.walletId, wallets));
        await db.delete(walletCluster).where(inArray(walletCluster.walletId, wallets));
      }
      await closeDb(db);
    }
  });

  it('a wallet with no trades is unrated with null aggregates', async () => {
    const b = await computeWalletBehavior(db, newWallet(), T);
    expect(b.effectiveN).toBe(0);
    expect(b.rated).toBe(false);
    expect(b.medianHoldMinutes).toBeNull();
    expect(b.avgPositionSol).toBeNull();
    expect(b.specialization).toEqual({});
  });

  it('stays unrated below effective-n 10, flips to rated at the threshold (Task 6)', async () => {
    const w = newWallet();
    for (let i = 0; i < WALLET_RATING_MIN_EFFECTIVE_N - 1; i++) await addTrade(w);
    expect((await computeWalletBehavior(db, w, T)).rated).toBe(false);
    await addTrade(w);
    const b = await computeWalletBehavior(db, w, T);
    expect(b.effectiveN).toBeCloseTo(10, 6);
    expect(b.rated).toBe(true);
  });

  it('thin aggregates are still returned for inspection while unrated — reported as thin, not hidden', async () => {
    const w = newWallet();
    await addTrade(w, { solIn: 5, holdSec: 1800 });
    const b = await computeWalletBehavior(db, w, T);
    expect(b.rated).toBe(false);
    expect(b.avgPositionSol).toBeCloseTo(5, 6);   // present…
    expect(b.medianHoldMinutes).toBeCloseTo(30, 6); // …but flagged unrated
  });

  it('OPEN positions do not contribute — a wallet cannot look disciplined by never selling', async () => {
    const w = newWallet();
    for (let i = 0; i < 12; i++) await addTrade(w, { status: 'OPEN', closedAt: null, holdSec: null });
    const b = await computeWalletBehavior(db, w, T);
    expect(b.effectiveN).toBe(0);
    expect(b.rated).toBe(false);
  });

  it('applies the 60d wallet half-life (Task 6), distinct from the setup half-lives', async () => {
    const w = newWallet();
    const old = new Date(T.getTime() - WALLET_HALFLIFE_DAYS * DAY_MS);
    await addTrade(w, { closedAt: old });
    await addTrade(w, { closedAt: T });
    const b = await computeWalletBehavior(db, w, T);
    expect(b.effectiveN).toBeCloseTo(1.5, 6); // fresh 1 + one half-life 0.5
  });

  it('POINT-IN-TIME: trades closing after asOf are invisible (rules 21/22)', async () => {
    const w = newWallet();
    const asOf = new Date(T.getTime() - 5 * DAY_MS);
    for (let i = 0; i < 3; i++) await addTrade(w, { closedAt: new Date(asOf.getTime() - DAY_MS) });
    for (let i = 0; i < 20; i++) await addTrade(w, { closedAt: T }); // after asOf

    const at = await computeWalletBehavior(db, w, asOf);
    expect(at.rated).toBe(false); // only 3 visible
    const after = await computeWalletBehavior(db, w, T);
    expect(after.rated).toBe(true);
  });

  it('specialization fractions sum to 1 across observed categories', async () => {
    const w = newWallet();
    for (let i = 0; i < 6; i++) await addTrade(w, { mint: 'MINT_A' });
    for (let i = 0; i < 2; i++) await addTrade(w, { mint: 'MINT_B' });
    const b = await computeWalletBehavior(db, w, T);
    const total = Object.values(b.specialization).reduce((a, x) => a + x, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(b.specialization.MINT_A!).toBeCloseTo(0.75, 6);
  });

  it('median hold time is weighted, not a plain average', async () => {
    const w = newWallet();
    // Ten fresh 60-minute holds plus one heavily-decayed 10-hour outlier.
    for (let i = 0; i < 10; i++) await addTrade(w, { holdSec: 3600 });
    await addTrade(w, { holdSec: 36000, closedAt: new Date(T.getTime() - 365 * DAY_MS) });
    const b = await computeWalletBehavior(db, w, T);
    expect(b.medianHoldMinutes).toBeCloseTo(60, 6); // the decayed outlier cannot drag it
  });

  it('collects cluster affiliations visible as of asOf', async () => {
    const w = newWallet();
    const cid = `CL-${randomUUID().slice(0, 8)}`;
    clusterIds.push(cid);
    await db.insert(walletCluster).values({
      id: randomUUID(), clusterId: cid, walletId: w, clusterRunId: randomUUID(),
      clusteredAt: new Date(T.getTime() - DAY_MS),
    });
    const b = await computeWalletBehavior(db, w, T);
    expect(b.clusterAffiliations).toContain(cid);
    // Not yet clustered at an earlier asOf.
    const earlier = await computeWalletBehavior(db, w, new Date(T.getTime() - 5 * DAY_MS));
    expect(earlier.clusterAffiliations).toEqual([]);
  });

  it('walletMemoryAsOf wraps the profile with its asOf, and persist caches it', async () => {
    const w = newWallet();
    await addTrade(w);
    const mem = await walletMemoryAsOf(db, w, T);
    expect(mem.walletId).toBe(w);
    expect(mem.asOf).toBe(T);

    await persistWalletBehavior(db, w, T);
    const rows = await db.select().from(brainWalletMemory).where(inArray(brainWalletMemory.walletId, [w]));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.behavior as { effectiveN: number }).effectiveN).toBeCloseTo(1, 6);
  });
});
