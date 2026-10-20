import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  connectDatabase,
  users,
  audits,
  accounts,
  tokens,
  strategies,
  strategyVersions,
} from '../packages/database/src/index.js';
import { configFromEnv } from '../packages/core/src/index.js';
import { eq } from 'drizzle-orm';
import { registerResearchStrategies } from '../packages/database/src/strategies.js';
const email = z
  .email()
  .parse(process.env.OWNER_EMAIL ?? 'owner@localhost.test');
const { db, pool } = connectDatabase(configFromEnv().DATABASE_URL);
try {
  await registerResearchStrategies(db);
  const raw = await db.transaction(async (tx) => {
    let [owner] = await tx.select().from(users).where(eq(users.email, email));
    if (!owner) [owner] = await tx.insert(users).values({ email }).returning();
    if (!owner) throw new Error('Owner creation failed');
    const [existing] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.ownerUserId, owner.id));
    if (!existing)
      await tx.insert(accounts).values({
        ownerUserId: owner.id,
        name: 'Paper portfolio',
        equityBaseline: '100',
      });
    for (const [slug, name] of [
      ['trend-following', 'Trend following'],
      ['mean-reversion', 'Mean reversion'],
    ]) {
      if (!slug || !name) continue;
      let [strategy] = await tx
        .select()
        .from(strategies)
        .where(eq(strategies.slug, slug));
      if (!strategy)
        [strategy] = await tx
          .insert(strategies)
          .values({ slug, name })
          .returning();
      if (strategy)
        await tx
          .insert(strategyVersions)
          .values({
            strategyId: strategy.id,
            version: '0.0.0',
            status: 'DRAFT',
            requirements: { implemented: false, availableInPhase: 3 },
          })
          .onConflictDoNothing();
    }
    const raw = randomBytes(32).toString('base64url');
    await tx.insert(tokens).values({
      userId: owner.id,
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      role: 'OWNER',
      expiresAt: new Date(Date.now() + 30 * 86400000),
    });
    const [account] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.ownerUserId, owner.id));
    await tx.insert(audits).values({
      accountId: account!.id,
      actorId: owner.id,
      eventType: 'security.token.issue',
      correlationId: randomUUID(),
      details: { role: 'OWNER', source: 'bootstrap' },
    });
    return raw;
  });
  console.log('Owner bearer token (shown once; expires in 30 days): ' + raw);
} finally {
  await pool.end();
}
