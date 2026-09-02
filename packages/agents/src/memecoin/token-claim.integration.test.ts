import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb, closeDb, activeTokenClaim, type Db } from '@tip/database';
import { claimToken, releaseToken, isTokenClaimed, filterUnclaimed } from './token-claim.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('token claim (integration)', () => {
  let db: Db;
  const mints: string[] = [];
  const mint = () => { const m = `MINT-${randomUUID().slice(0, 12)}`; mints.push(m); return m; };

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      if (mints.length) await db.delete(activeTokenClaim).where(inArray(activeTokenClaim.mint, mints));
      await closeDb(db);
    }
  });

  it('claims an unclaimed mint, refuses a second claim', async () => {
    const m = mint();
    expect((await claimToken(db, { mint: m, tradingAgentId: 'a1' })).claimed).toBe(true);
    const second = await claimToken(db, { mint: m, tradingAgentId: 'a2' });
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.heldBy).toBe('a1');
  });

  it('ATOMIC under concurrency — two simultaneous claims, exactly one wins', async () => {
    const m = mint();
    const [a, b] = await Promise.all([
      claimToken(db, { mint: m, tradingAgentId: 'a1' }),
      claimToken(db, { mint: m, tradingAgentId: 'a2' }),
    ]);
    const wins = [a, b].filter((r) => r.claimed);
    expect(wins).toHaveLength(1);
  });

  it('release frees the mint for re-claim', async () => {
    const m = mint();
    await claimToken(db, { mint: m, tradingAgentId: 'a1' });
    await releaseToken(db, m);
    expect(await isTokenClaimed(db, m)).toBe(false);
    expect((await claimToken(db, { mint: m, tradingAgentId: 'a2' })).claimed).toBe(true);
  });

  it('filterUnclaimed drops claimed mints from a candidate set', async () => {
    const held = mint(); const free = mint();
    await claimToken(db, { mint: held, tradingAgentId: 'a1' });
    const ok = await filterUnclaimed(db, [held, free]);
    expect(ok.has(free)).toBe(true);
    expect(ok.has(held)).toBe(false);
  });
});
