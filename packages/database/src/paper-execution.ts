import { trackEquityPeaks } from './capital.js';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { FinancialDecimal as Decimal } from '../../core/src/decimal.js';
import { systemClock, type Clock } from '../../core/src/index.js';
import { paperPolicy, money, type Approval } from '../../risk/src/sizing.js';
import type {
  Action,
  ExecutionAdapter,
  Lease,
  Price,
  Report,
} from '../../runtime/src/contracts.js';
import {
  capitalReservations,
  paperMarks,
  paperPriceEvents,
  paperReports,
  runtimeActions,
  tradeLifecycles,
  type Database,
} from './index.js';
import { DurableFakeExecutionAdapter } from './fake-execution.js';
// The shared journal validates identities, cumulative fills, reduce-only exits and immutable event keys.
// PAPER uses its own table; the Phase 4 fake facts never enter a funded ledger.
export class PaperExecutionAdapter implements ExecutionAdapter {
  readonly backend = 'PAPER' as const;
  private journal: DurableFakeExecutionAdapter;
  constructor(
    private db: Database,
    private clock: Clock = systemClock,
  ) {
    this.journal = new DurableFakeExecutionAdapter(db, {}, clock, paperReports);
  }
  async submit(action: Action, lease: Lease): Promise<Report[]> {
    const [trade] = await this.db
      .select()
      .from(tradeLifecycles)
      .where(eq(tradeLifecycles.id, action.tradeId));
    if (trade?.executionBackend !== 'PAPER')
      throw Error('PAPER_SCOPE_MISMATCH');
    const [reservation] = await this.db
      .select()
      .from(capitalReservations)
      .where(eq(capitalReservations.tradeId, action.tradeId));
    if (!reservation) throw Error('PAPER_RESERVATION_MISSING');
    return this.journal.submit(action, lease);
  }
  reconcile(botId: string) {
    return this.journal.reconcile(botId);
  }
  async onPrice(event: Price, lease: Lease): Promise<Report[]> {
    if (
      event.late ||
      event.observedAt < this.clock.now().getTime() - 5000 ||
      event.observedAt > this.clock.now().getTime() ||
      event.eventTime > event.observedAt
    )
      return [];
    const [trade] = await this.db
      .select()
      .from(tradeLifecycles)
      .where(
        and(
          eq(tradeLifecycles.botId, lease.botId),
          eq(tradeLifecycles.executionBackend, 'PAPER'),
          inArray(tradeLifecycles.state, [
            'PENDING_ENTRY',
            'OPEN',
            'CLOSING',
            'UNRESOLVED',
          ]),
        ),
      );
    if (!trade) return [];
    const [bot] = await this.db
      .execute<{ canonical_market_id: string }>(
        sql`SELECT canonical_market_id FROM bots WHERE id=${lease.botId}`,
      )
      .then((r) => r.rows);
    if (bot?.canonical_market_id !== event.marketKey) return [];
    const accepted = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('platform.runtime_bot',${lease.botId},true),set_config('platform.runtime_owner',${lease.ownerId},true),set_config('platform.runtime_fence',${String(lease.token)},true)`,
      );
      await tx.execute(sql`SELECT assert_runtime_write(${lease.botId})`);
      await tx.execute(
        sql`SELECT id FROM exchange_accounts WHERE id=${trade.accountId} FOR UPDATE`,
      );
      const [mark] = await tx
        .select()
        .from(paperMarks)
        .where(eq(paperMarks.botId, lease.botId));
      if (mark && mark.eventTime > event.eventTime) return false;
      const key = `${lease.botId}:${event.tradeId}`;
      const [prior] = await tx
        .select()
        .from(paperPriceEvents)
        .where(eq(paperPriceEvents.key, key));
      if (prior && !isDeepStrictEqual(prior.payload, event))
        throw Error('PAPER_PRICE_EVENT_CONFLICT');
      await tx
        .insert(paperPriceEvents)
        .values({ key, botId: lease.botId, payload: event })
        .onConflictDoNothing();
      await tx
        .insert(paperMarks)
        .values({
          botId: lease.botId,
          price: event.price,
          eventTime: event.eventTime,
        })
        .onConflictDoUpdate({
          target: paperMarks.botId,
          set: { price: event.price, eventTime: event.eventTime },
          setWhere: sql`${paperMarks.eventTime}<${event.eventTime}`,
        });
      await trackEquityPeaks(tx, trade.accountId, event.observedAt);
      return true;
    });
    if (!accepted) return [];
    const [r] = await this.db
      .select()
      .from(capitalReservations)
      .where(eq(capitalReservations.tradeId, trade.id));
    if (!r) throw Error('PAPER_RESERVATION_MISSING');
    const a = r.approval as Approval,
      policy = a.policy ?? paperPolicy;
    if (
      event.eventTime <= trade.createdAt ||
      event.observedAt < trade.createdAt + policy.latencyMs
    )
      return [];
    const all = await this.reconcile(lease.botId),
      facts = all.filter((f) => f.tradeId === trade.id);
    const actions = await this.db
      .select()
      .from(runtimeActions)
      .where(
        and(
          eq(runtimeActions.tradeId, trade.id),
          inArray(runtimeActions.kind, ['ENTRY', 'CLOSE']),
          inArray(runtimeActions.state, ['OPEN', 'SUBMITTING']),
        ),
      );
    let liquidity = Decimal.max(
      0,
      new Decimal(event.quantity)
        .mul(policy.participation)
        .minus(
          facts
            .filter((f) => f.eventId === `paper:${f.actionId}:${event.tradeId}`)
            .reduce((n, f) => n.plus(f.quantity ?? 0), new Decimal(0)),
        ),
    );
    // Never reuse one public trade's volume across competing local intents.
    for (const action of actions.sort((x, y) =>
      x.kind === 'CLOSE' ? -1 : y.kind === 'CLOSE' ? 1 : 0,
    )) {
      const entry = action.kind === 'ENTRY',
        same = facts.filter((f) => f.actionId === action.id);
      if (
        same.some((f) => f.eventId === `paper:${action.id}:${event.tradeId}`) ||
        (entry &&
          (trade.entryTerminal ||
            event.observedAt >= trade.expiresAt ||
            facts.some(
              (f) =>
                f.kind === 'ENTRY_CANCELLED' || f.kind === 'ENTRY_REJECTED',
            )))
      )
        continue;
      if (
        event.eventTime <= action.createdAt ||
        event.observedAt < action.createdAt + policy.latencyMs
      )
        continue;
      const buy = entry ? trade.side === 'LONG' : trade.side === 'SHORT';
      if (
        entry &&
        trade.orderType === 'LIMIT' &&
        event.side !== (buy ? 'SELL' : 'BUY')
      )
        continue;
      const raw = new Decimal(event.price).mul(
        new Decimal(1).plus(
          buy ? policy.slippageRate : new Decimal(policy.slippageRate).neg(),
        ),
      );
      const price = raw
        .div(a.instrument.tickSize)
        .toDecimalPlaces(0, buy ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR)
        .mul(a.instrument.tickSize);
      if (
        entry &&
        trade.orderType === 'LIMIT' &&
        (buy ? price.gt(action.price!) : price.lt(action.price!))
      )
        continue;
      // Entry slippage cannot exceed approved cost envelope or cross the original stop/target.
      if (
        entry &&
        (price
          .minus(a.entry)
          .abs()
          .gt(
            new Decimal(a.entry)
              .mul(policy.slippageRate)
              .plus(a.instrument.tickSize),
          ) ||
          (buy
            ? price.lte(trade.initialStop) || price.gte(trade.takeProfit)
            : price.gte(trade.initialStop) || price.lte(trade.takeProfit)))
      )
        continue;
      const filled = same
        .filter((f) => f.kind === (entry ? 'ENTRY_FILL' : 'EXIT_FILL'))
        .reduce((n, f) => n.plus(f.quantity!), new Decimal(0));
      let remaining = new Decimal(action.quantity).minus(filled);
      if (!entry)
        remaining = Decimal.min(
          remaining,
          new Decimal(trade.filledQuantity).minus(trade.closedQuantity),
        );
      const qty = Decimal.min(remaining, liquidity)
        .div(a.instrument.quantityStep)
        .floor()
        .mul(a.instrument.quantityStep);
      if (qty.lte(0)) continue;
      const report: Report = {
        eventId: `paper:${action.id}:${event.tradeId}`,
        actionId: action.id,
        tradeId: trade.id,
        botId: lease.botId,
        kind: entry ? 'ENTRY_FILL' : 'EXIT_FILL',
        eventTime: event.observedAt,
        quantity: money(qty),
        price: money(price),
        fee: money(price.mul(qty).mul(policy.feeRate)),
        terminal: qty.eq(remaining),
      };
      await this.journal.append(report, lease);
      liquidity = liquidity.minus(qty);
    }
    return this.reconcile(lease.botId);
  }
}
