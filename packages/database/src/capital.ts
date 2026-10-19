import { eq, sql } from 'drizzle-orm';
import { FinancialDecimal as Decimal } from '../../core/src/decimal.js';
import {
  accounts,
  bots,
  audits,
  capitalLedger,
  capitalReservations,
  instruments,
  paperEquityPeaks,
  type Database,
} from './index.js';
import {
  sizeOrder,
  money,
  paperPolicy,
  type Approval,
  type RiskPolicy,
} from '../../risk/src/sizing.js';
import { DomainError } from '../../core/src/index.js';
import type { Actor } from './bots.js';
import type { Change, View } from '../../runtime/src/contracts.js';
import type { Instrument } from '../../market-data/src/contracts.js';
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const D = (x: import('decimal.js').Decimal.Value) => new Decimal(x);
export async function trackEquityPeaks(tx: Tx, accountId: string, now: number) {
  const snapshots = await capitalSnapshot(tx, accountId, now);
  const [account] = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!account) throw Error('Account missing');
  const sample = async (scope: string, peak: import('decimal.js').Decimal) =>
    tx
      .insert(paperEquityPeaks)
      .values({ scope, accountId, peak: money(peak) })
      .onConflictDoUpdate({
        target: paperEquityPeaks.scope,
        set: {
          peak: sql`greatest(${paperEquityPeaks.peak},${money(peak)}::numeric)`,
        },
      });
  for (const s of snapshots)
    await sample(`bot:${s.bot_id}`, D(s.balance).plus(s.unrealized));
  await sample(
    `account:${accountId}`,
    snapshots.reduce(
      (n, s) => n.plus(D(s.balance).minus(s.principal)).plus(s.unrealized),
      D(account.equityBaseline),
    ),
  );
}
export async function normalizePaperProtection(tx: Tx, c: Change) {
  const t = c.view.trade;
  if (
    !t ||
    t.executionBackend !== 'PAPER' ||
    !c.actions.some((a) => ['PROTECT', 'AMEND_STOP'].includes(a.kind))
  )
    return;
  const [r] = await tx
    .select()
    .from(capitalReservations)
    .where(eq(capitalReservations.tradeId, t.id));
  if (!r) throw Error('PAPER_RESERVATION_MISSING');
  const a = r.approval as Approval;
  const stop = money(
    D(t.desiredStop)
      .div(a.instrument.tickSize)
      .toDecimalPlaces(
        0,
        t.side === 'LONG' ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR,
      )
      .mul(a.instrument.tickSize),
  );
  t.desiredStop = stop;
  t.submittedStop = stop;
  for (const intent of c.actions.filter((a) =>
    ['PROTECT', 'AMEND_STOP'].includes(a.kind),
  ))
    intent.stopPrice = stop;
}

export async function capitalSnapshot(
  tx: Pick<Database, 'execute'>,
  accountId: string,
  now: number,
) {
  const result = await tx.execute<{
    bot_id: string;
    balance: string;
    principal: string;
    daily: string;
    peak: string;
    unrealized: string;
  }>(sql`WITH running AS (
    SELECT bot_id,event_time,sequence,kind,amount,sum(amount) OVER(PARTITION BY bot_id ORDER BY sequence) AS balance
    FROM paper_capital_ledger WHERE account_id=${accountId}
  ) SELECT b.id AS bot_id,coalesce(sum(r.amount),0)::text AS balance,
    coalesce(sum(r.amount) FILTER(WHERE r.kind='FUNDING'),0)::text AS principal,
    coalesce(sum(r.amount) FILTER(WHERE r.kind<>'FUNDING' AND r.event_time>=${Math.floor(now / 86400000) * 86400000}),0)::text AS daily,
    coalesce(max(r.balance),0)::text AS peak,
    coalesce((SELECT sum((m.price-t.average_entry)*(t.filled_quantity-t.closed_quantity)*CASE WHEN t.side='LONG' THEN 1 ELSE -1 END)
      FROM trade_lifecycles t JOIN paper_marks m ON m.bot_id=t.bot_id
      WHERE t.bot_id=b.id AND t.execution_backend='PAPER' AND t.state IN ('OPEN','CLOSING','UNRESOLVED')),0)::text AS unrealized
    FROM bots b LEFT JOIN running r ON r.bot_id=b.id WHERE b.exchange_account_id=${accountId} GROUP BY b.id`);
  return result.rows;
}
export async function approvePaperEntry(
  tx: Tx,
  c: Change,
  previous: View,
  now: number,
  policy: RiskPolicy = paperPolicy,
) {
  const trade = c.view.trade;
  if (!trade || previous.trade || trade.executionBackend !== 'PAPER')
    return null;
  try {
    const [bot] = await tx.select().from(bots).where(eq(bots.id, trade.botId));
    const [account] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, trade.accountId));
    if (!bot || !account) throw Error('ACCOUNT_MISSING');
    const uncertain = await tx.execute(
      sql`SELECT t.id FROM trade_lifecycles t LEFT JOIN paper_marks m ON m.bot_id=t.bot_id WHERE t.account_id=${trade.accountId} AND t.state IN ('PENDING_ENTRY','OPEN','CLOSING','UNRESOLVED') AND (t.execution_backend<>'PAPER' OR t.state='UNRESOLVED' OR (t.filled_quantity>t.closed_quantity AND (t.protection_status<>'CONFIRMED' OR m.event_time IS NULL OR m.event_time<${now - 5000}))) LIMIT 1`,
    );
    if (uncertain.rows.length) throw Error('ACCOUNT_EXPOSURE_UNCERTAIN');
    const snapshots = await capitalSnapshot(tx, trade.accountId, now),
      own = snapshots.find((s) => s.bot_id === bot.id)!;
    if (D(own.principal).lte(0)) throw Error('EXPLICIT_PAPER_FUNDING_REQUIRED');
    const peaks = await tx
      .select()
      .from(paperEquityPeaks)
      .where(eq(paperEquityPeaks.accountId, account.id));
    const botPeak = Decimal.max(
      own.peak,
      peaks.find((p) => p.scope === `bot:${bot.id}`)?.peak ?? 0,
    );
    const equity = D(own.balance).plus(Decimal.min(0, own.unrealized));
    const profile = bot.riskProfile as keyof RiskPolicy['profiles'],
      p = policy.profiles[profile];
    if (
      D(own.daily).lte(D(own.principal).mul(p.daily).neg()) ||
      equity.lte(botPeak.mul(D(1).minus(p.drawdown)))
    )
      throw Error('BOT_LOSS_GUARD');
    const net = snapshots.reduce(
      (n, s) => n.plus(D(s.balance).minus(s.principal)),
      D(0),
    );
    const unrealized = snapshots.reduce((n, s) => n.plus(s.unrealized), D(0));
    const accountEquity = D(account.equityBaseline)
      .plus(net)
      .plus(Decimal.min(0, unrealized));
    const daily = snapshots.reduce((n, s) => n.plus(s.daily), D(0));
    const history = await tx.execute<{ peak: string }>(
      sql`SELECT greatest(${account.equityBaseline}::numeric,coalesce(max(balance),0))::text AS peak FROM (SELECT ${account.equityBaseline}::numeric+sum(amount) OVER(ORDER BY sequence) AS balance FROM paper_capital_ledger WHERE account_id=${account.id} AND kind<>'FUNDING') x`,
    );
    if (
      daily.lte(D(account.equityBaseline).mul(policy.accountDaily).neg()) ||
      accountEquity.lte(
        Decimal.max(
          history.rows[0]!.peak,
          peaks.find((p) => p.scope === `account:${account.id}`)?.peak ?? 0,
        ).mul(D(1).minus(policy.accountDrawdown)),
      )
    )
      throw Error('ACCOUNT_LOSS_GUARD');
    const target = await tx.execute<{ total: string }>(
      sql`SELECT coalesce(sum(allocation_target_percent),0)::text AS total FROM bots WHERE exchange_account_id=${account.id}`,
    );
    const funded = snapshots.reduce((n, s) => n.plus(s.balance), D(0));
    if (
      D(target.rows[0]!.total).gt(80) ||
      (accountEquity.lt(account.equityBaseline) &&
        funded.gt(accountEquity.mul('.8')))
    )
      throw Error('ALLOCATION_ENVELOPE_EXCEEDED');
    const [instrument] = await tx
      .select()
      .from(instruments)
      .where(eq(instruments.canonicalMarketId, previous.marketKey));
    if (!instrument) throw Error('INSTRUMENT_MISSING');
    const spec = instrument.spec as Instrument;
    const round = (value: string, up: boolean) =>
      money(
        D(value)
          .div(spec.tickSize)
          .toDecimalPlaces(0, up ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR)
          .mul(spec.tickSize),
      );
    const long = trade.side === 'LONG';
    trade.entryReference = round(trade.entryReference, long);
    trade.initialStop = round(trade.initialStop, long);
    trade.desiredStop = trade.initialStop;
    trade.takeProfit = round(trade.takeProfit, !long);
    const entryAction = c.actions.find((a) => a.kind === 'ENTRY')!;
    entryAction.price = trade.entryReference;
    entryAction.stopPrice = trade.initialStop;
    entryAction.takeProfit = trade.takeProfit;
    const approval = sizeOrder(
      {
        equity: money(equity),
        entry: trade.entryReference,
        stop: trade.initialStop,
        target: trade.takeProfit,
        side: trade.side,
        profile,
        instrument: instrument.spec as Instrument,
        now,
      },
      policy,
    );
    const outstanding = await tx
      .select()
      .from(capitalReservations)
      .where(eq(capitalReservations.accountId, account.id));
    const sum = (
      field: 'reserved' | 'committed' | 'notional' | 'stopExposure',
    ) => outstanding.reduce((n, r) => n.plus(r[field]), D(0));
    const capacity = sum('reserved').plus(sum('committed'));
    if (
      outstanding.some(
        (r) => r.botId === bot.id && D(r.reserved).plus(r.committed).gt(0),
      )
    )
      throw Error('BOT_CAPITAL_ALREADY_RESERVED');
    if (
      capacity
        .plus(approval.margin)
        .plus(approval.buffer)
        .gt(accountEquity.mul(policy.accountMargin)) ||
      sum('notional')
        .plus(approval.notional)
        .gt(accountEquity.mul(policy.accountNotional)) ||
      sum('stopExposure')
        .plus(approval.stopExposure)
        .gt(accountEquity.mul(policy.accountStop))
    )
      throw Error('PORTFOLIO_EXPOSURE_LIMIT');
    trade.requestedQuantity = approval.quantity;
    c.actions.find((a) => a.kind === 'ENTRY')!.quantity = approval.quantity;
    c.actions.find((a) => a.kind === 'ENTRY')!.reason = 'PAPER_RISK_APPROVED';
    return approval;
  } catch (error) {
    c.view = structuredClone(previous);
    c.actions = [];
    c.kind = 'risk.rejected';
    const reason = String(error instanceof Error ? error.message : error);
    if (
      [
        'BOT_LOSS_GUARD',
        'ACCOUNT_LOSS_GUARD',
        'ACCOUNT_EXPOSURE_UNCERTAIN',
        'ALLOCATION_ENVELOPE_EXCEEDED',
      ].includes(reason)
    )
      c.view.operational = 'RISK_SUSPENDED';
    c.details = { evaluationId: trade.evaluationId, reason };
    return null;
  }
}
export async function settlePaperChange(
  tx: Tx,
  before: View,
  c: Change,
  key: string,
  now: number,
  approval: Approval | null,
) {
  const t = c.view.trade;
  if (!t || t.executionBackend !== 'PAPER') return;
  if (approval)
    await tx.insert(capitalReservations).values({
      tradeId: t.id,
      botId: t.botId,
      accountId: t.accountId,
      approval,
      reserved: money(D(approval.margin).plus(approval.buffer)),
      committed: '0',
      notional: approval.notional,
      stopExposure: approval.stopExposure,
    });
  const [reservation] = await tx
    .select()
    .from(capitalReservations)
    .where(eq(capitalReservations.tradeId, t.id));
  if (!reservation) throw Error('PAPER_RESERVATION_MISSING');
  const a = reservation.approval as Approval,
    old = before.trade;
  if (old) {
    const id = key.replace(/^report:/, '');
    const fact = await tx.execute<{ payload: { price: string; fee?: string } }>(
      sql`SELECT payload FROM paper_execution_reports WHERE event_key=${id} AND bot_id=${t.botId}`,
    );
    const entryQty = D(t.filledQuantity).minus(old.filledQuantity),
      exitQty = D(t.closedQuantity).minus(old.closedQuantity);
    const post = async (kind: string, amount: import('decimal.js').Decimal) => {
      if (!amount.isZero())
        await tx.insert(capitalLedger).values({
          accountId: t.accountId,
          botId: t.botId,
          tradeId: t.id,
          source: `${key}:${kind}`,
          kind,
          amount: money(amount),
          eventTime: now,
        });
    };
    if (entryQty.gt(0)) {
      if (!fact.rows[0]) throw Error('PAPER_FILL_EVIDENCE_MISSING');
      const fill = fact.rows[0].payload;
      await post(
        'FEE',
        D(
          fill.fee ?? money(D(fill.price).mul(entryQty).mul(a.policy.feeRate)),
        ).neg(),
      );
    }
    if (exitQty.gt(0)) {
      // Price is a durable authoritative PAPER fact, never a desired target/stop.
      if (!fact.rows[0]) throw Error('PAPER_FILL_EVIDENCE_MISSING');
      const price = D(fact.rows[0].payload.price);
      await post(
        'GROSS_PNL',
        price
          .minus(old.averageEntry!)
          .mul(exitQty)
          .mul(t.side === 'LONG' ? 1 : -1),
      );
      await post(
        'FEE',
        D(
          fact.rows[0].payload.fee ??
            money(price.mul(exitQty).mul(a.policy.feeRate)),
        ).neg(),
      );
    }
  }
  const unfilled = t.entryTerminal
      ? D(0)
      : D(t.requestedQuantity).minus(t.filledQuantity),
    open = D(t.filledQuantity).minus(t.closedQuantity),
    unit = D(a.margin).plus(a.buffer).div(a.quantity);
  await tx
    .update(capitalReservations)
    .set({
      reserved: money(unfilled.mul(unit)),
      committed: money(open.mul(unit)),
      notional: money(unfilled.plus(open).mul(D(a.notional).div(a.quantity))),
      stopExposure: money(
        unfilled.plus(open).mul(D(a.stopExposure).div(a.quantity)),
      ),
    })
    .where(eq(capitalReservations.tradeId, t.id));
}
export class PaperCapitalRepository {
  constructor(private db: Database) {}
  async snapshot(accountId: string, now = Date.now()) {
    return this.db.transaction(
      async (tx) => {
        const rows = await capitalSnapshot(tx, accountId, now);
        const botRows = await tx
          .select()
          .from(bots)
          .where(eq(bots.accountId, accountId));
        const reservations = await tx
          .select()
          .from(capitalReservations)
          .where(eq(capitalReservations.accountId, accountId));
        return rows.map((row) => {
          const own = reservations.filter((r) => r.botId === row.bot_id);
          const reserved = own.reduce((n, r) => n.plus(r.reserved), D(0)),
            committed = own.reduce((n, r) => n.plus(r.committed), D(0));
          return {
            ...row,
            targetAllocationPercent: botRows.find((b) => b.id === row.bot_id)!
              .allocationTargetPercent,
            reserved: money(reserved),
            committed: money(committed),
            actualEquity: money(D(row.balance).plus(row.unrealized)),
            availableBudget: money(
              Decimal.max(
                0,
                D(row.balance)
                  .plus(Decimal.min(0, row.unrealized))
                  .minus(reserved)
                  .minus(committed),
              ),
            ),
          };
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  async fundInitial(
    actor: Actor,
    botId: string,
    reason: string,
    correlationId: string,
  ) {
    if (actor.role !== 'OWNER')
      throw new DomainError('FORBIDDEN', 'Owner permission required', 403);
    return this.db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.ownerUserId, actor.userId))
        .for('update');
      const [bot] = await tx
        .select()
        .from(bots)
        .where(eq(bots.id, botId))
        .for('update');
      if (!account || bot?.accountId !== account.id)
        throw new DomainError('BOT_NOT_FOUND', 'Bot not found', 404);
      const [existing] = await tx
        .select()
        .from(capitalLedger)
        .where(eq(capitalLedger.source, `initial-funding:${bot.id}`));
      if (existing) return existing;
      if (D(bot.allocationTargetPercent).lte(0))
        throw new DomainError(
          'FUNDING_TARGET_REQUIRED',
          'Set a positive target before initial paper funding',
          409,
        );
      if (
        bot.operationalStatus !== 'STOPPED' ||
        bot.tradingState !== 'IDLE' ||
        bot.executionMode !== 'PAPER'
      )
        throw new DomainError(
          'FUNDING_REQUIRES_IDLE_PAPER',
          'Initial funding requires a stopped idle PAPER bot',
          409,
        );
      const [posting] = await tx
        .insert(capitalLedger)
        .values({
          accountId: account.id,
          botId: bot.id,
          source: `initial-funding:${bot.id}`,
          kind: 'FUNDING',
          amount: money(
            D(account.equityBaseline).mul(bot.allocationTargetPercent).div(100),
          ),
          eventTime: Date.now(),
        })
        .returning();
      await tx.insert(audits).values({
        accountId: account.id,
        botId: bot.id,
        actorId: actor.userId,
        eventType: 'paper.initial_funding',
        correlationId,
        details: { reason, postingId: posting!.id },
      });
      return posting;
    });
  }
}
