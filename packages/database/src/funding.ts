import { and, eq, sql } from 'drizzle-orm';
import {
  accounts,
  bots,
  capitalLedger,
  paperFundingEvents,
  runtimeLeases,
  tradeLifecycles,
  type Database,
} from './index.js';
import { FinancialDecimal as Decimal } from '../../core/src/decimal.js';
import { money } from '../../risk/src/sizing.js';
import { trackEquityPeaks } from './capital.js';
import type { Lease } from '../../runtime/src/contracts.js';
export async function postPaperFunding(
  db: Database,
  lease: Lease,
  input: { period: number; observedAt: number; rate: string; price: string },
) {
  if (
    input.period > input.observedAt ||
    !new Decimal(input.rate).isFinite() ||
    new Decimal(input.rate).abs().gt('.1') ||
    !new Decimal(input.price).gt(0)
  )
    throw Error('Invalid funding observation');
  return db.transaction(async (tx) => {
    const [bot] = await tx.select().from(bots).where(eq(bots.id, lease.botId));
    if (!bot) throw Error('Bot missing');
    await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, bot.accountId))
      .for('update');
    const [owner] = await tx
      .select()
      .from(runtimeLeases)
      .where(
        and(
          eq(runtimeLeases.botId, lease.botId),
          eq(runtimeLeases.ownerId, lease.ownerId),
          eq(runtimeLeases.token, lease.token),
          sql`${runtimeLeases.expiresAt}>clock_timestamp()`,
        ),
      )
      .for('update');
    if (!owner) throw Error('FENCED: funding lease');
    await tx.execute(
      sql`SELECT set_config('platform.runtime_bot',${lease.botId},true),set_config('platform.runtime_owner',${lease.ownerId},true),set_config('platform.runtime_fence',${String(lease.token)},true)`,
    );
    const trades = await tx
      .select()
      .from(tradeLifecycles)
      .where(
        and(
          eq(tradeLifecycles.botId, bot.id),
          eq(tradeLifecycles.executionBackend, 'PAPER'),
        ),
      );
    for (const t of trades) {
      const result = await tx.execute<{ qty: string }>(
        sql`SELECT coalesce(sum(CASE WHEN payload->>'kind'='ENTRY_FILL' THEN (payload->>'quantity')::numeric WHEN payload->>'kind'='EXIT_FILL' THEN -(payload->>'quantity')::numeric ELSE 0 END),0)::text AS qty FROM paper_execution_reports WHERE payload->>'tradeId'=${t.id} AND (payload->>'eventTime')::bigint<=${input.period}`,
      );
      const qty = new Decimal(result.rows[0]!.qty);
      if (
        qty.lte(0) ||
        (bot.market as { marketType: string }).marketType === 'SPOT'
      )
        continue;
      const key = `${t.id}:${input.period}`;
      const amount = money(
        qty
          .mul(input.price)
          .mul(input.rate)
          .mul(t.side === 'LONG' ? -1 : 1),
      );
      const [old] = await tx
        .select()
        .from(paperFundingEvents)
        .where(eq(paperFundingEvents.key, key));
      if (old) {
        if (
          !new Decimal(old.amount).eq(amount) ||
          old.rate !== input.rate ||
          !new Decimal(old.price).eq(input.price)
        )
          throw Error('Funding key conflict');
        continue;
      }
      await tx.insert(paperFundingEvents).values({
        key,
        botId: bot.id,
        tradeId: t.id,
        period: input.period,
        observedAt: input.observedAt,
        quantity: money(qty),
        rate: input.rate,
        price: input.price,
        amount,
      });
      if (!new Decimal(amount).isZero())
        await tx.insert(capitalLedger).values({
          accountId: bot.accountId,
          botId: bot.id,
          tradeId: t.id,
          source: `funding:${key}`,
          kind: 'FUNDING_PAYMENT',
          amount,
          eventTime: input.observedAt,
        });
    }
    await trackEquityPeaks(tx, bot.accountId, input.observedAt);
  });
}
