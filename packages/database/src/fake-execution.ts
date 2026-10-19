// Explicit Phase 4 test-contract backend. It never simulates prices, fees, P&L or exchange orders.
import { and, eq, asc, sql } from 'drizzle-orm';
import { systemClock, type Clock } from '../../core/src/index.js';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  fakeReports,
  runtimeActions,
  runtimeLeases,
  type Database,
} from './index.js';
import type {
  ExecutionAdapter,
  Action,
  ActionKind,
  Lease,
  Report,
} from '../../runtime/src/contracts.js';
import { decimalString, epoch } from '../../market-data/src/contracts.js';
const schema = z
  .object({
    eventId: z.string().min(1).max(250),
    actionId: z.uuid(),
    tradeId: z.uuid(),
    botId: z.uuid(),
    kind: z.enum([
      'ENTRY_OPEN',
      'ENTRY_FILL',
      'ENTRY_CANCELLED',
      'ENTRY_REJECTED',
      'CLOSE_OPEN',
      'EXIT_FILL',
      'STOP_CONFIRMED',
      'REJECTED',
      'UNKNOWN',
    ]),
    eventTime: epoch,
    quantity: decimalString.optional(),
    price: decimalString.optional(),
    stopPrice: decimalString.optional(),
    revision: z.number().int().nonnegative().optional(),
    terminal: z.boolean().optional(),
  })
  .strict();
export class DurableFakeExecutionAdapter implements ExecutionAdapter {
  readonly backend = 'FAKE_CONTRACT' as const;
  constructor(
    private db: Database,
    private behavior: Partial<
      Record<ActionKind, 'ACK' | 'DEFER' | 'UNKNOWN' | 'REJECT'>
    > = {},
    private clock: Clock = systemClock,
  ) {}
  async submit(action: Action, authorization: Lease) {
    if (this.behavior[action.kind] === 'DEFER') return [];
    const mode = this.behavior[action.kind] ?? 'ACK';
    const kind: Report['kind'] =
      mode === 'UNKNOWN'
        ? 'UNKNOWN'
        : mode === 'REJECT'
          ? action.kind === 'ENTRY'
            ? 'ENTRY_REJECTED'
            : 'REJECTED'
          : action.kind === 'ENTRY'
            ? 'ENTRY_OPEN'
            : action.kind === 'CANCEL_ENTRY'
              ? 'ENTRY_CANCELLED'
              : action.kind === 'CLOSE'
                ? 'CLOSE_OPEN'
                : 'STOP_CONFIRMED';
    const report: Report = {
      eventId: `submit:${action.id}`,
      actionId: action.id,
      tradeId: action.tradeId,
      botId: action.botId,
      kind,
      eventTime: this.clock.now().getTime(),
      ...(kind === 'STOP_CONFIRMED'
        ? {
            quantity: action.quantity,
            stopPrice: action.stopPrice!,
            revision: action.revision,
          }
        : {}),
    };
    await this.append(report, authorization);
    return this.reconcile(action.botId);
  }
  async append(input: Report, authorization?: Lease) {
    const report = schema.parse(input);
    await this.db.transaction(async (tx) => {
      if (authorization) {
        const [lease] = await tx
          .select()
          .from(runtimeLeases)
          .where(
            and(
              eq(runtimeLeases.botId, authorization.botId),
              eq(runtimeLeases.ownerId, authorization.ownerId),
              eq(runtimeLeases.token, authorization.token),
              sql`${runtimeLeases.expiresAt}>clock_timestamp()`,
            ),
          )
          .for('share');
        if (!lease || authorization.botId !== report.botId)
          throw Error('FENCED: fake submission authorization expired');
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`fake:${report.botId}`},0))`,
      );
      const [old] = await tx
        .select()
        .from(fakeReports)
        .where(eq(fakeReports.eventKey, report.eventId));
      if (old) {
        if (
          JSON.stringify(old.payload) !== JSON.stringify(report) &&
          canonical(old.payload) !== canonical(report)
        )
          throw Error('Fake report key reused with different content');
        return;
      }
      const [action] = await tx
        .select()
        .from(runtimeActions)
        .where(eq(runtimeActions.id, report.actionId));
      if (
        !action ||
        action.botId !== report.botId ||
        action.tradeId !== report.tradeId
      )
        throw Error('Fake report action mismatch');
      if (action.state === 'CREATED')
        throw Error('Fake intent was not submitted');
      const rows = await tx
        .select()
        .from(fakeReports)
        .where(eq(fakeReports.botId, report.botId))
        .orderBy(asc(fakeReports.sequence));
      const history = rows.map((r) => r.payload as Report);
      const same = history.filter((r) => r.actionId === report.actionId);
      if (report.kind === 'ENTRY_FILL') {
        if (
          action.kind !== 'ENTRY' ||
          !report.quantity ||
          !report.price ||
          new Decimal(report.quantity).lte(0) ||
          new Decimal(report.price).lte(0) ||
          history.some(
            (r) =>
              r.tradeId === report.tradeId &&
              ['ENTRY_CANCELLED', 'ENTRY_REJECTED'].includes(r.kind),
          )
        )
          throw Error('Invalid fake entry fill');
        const total = same
          .filter((r) => r.kind === 'ENTRY_FILL')
          .reduce((n, r) => n.plus(r.quantity!), new Decimal(0));
        if (total.plus(report.quantity).gt(action.quantity))
          throw Error('Fake entry overfill');
      }
      if (
        (report.kind === 'ENTRY_OPEN' && action.kind !== 'ENTRY') ||
        (report.kind === 'CLOSE_OPEN' && action.kind !== 'CLOSE') ||
        (report.kind === 'ENTRY_REJECTED' && action.kind !== 'ENTRY') ||
        (report.kind === 'ENTRY_CANCELLED' &&
          !['ENTRY', 'CANCEL_ENTRY'].includes(action.kind))
      )
        throw Error('Fake acknowledgment kind mismatch');
      if (report.kind === 'EXIT_FILL') {
        if (
          action.kind !== 'CLOSE' ||
          !report.quantity ||
          !report.price ||
          new Decimal(report.quantity).lte(0) ||
          new Decimal(report.price).lte(0) ||
          same.some((r) => r.kind === 'EXIT_FILL' && r.terminal)
        )
          throw Error('Invalid fake exit fill');
        const exits = same
          .filter((r) => r.kind === 'EXIT_FILL')
          .reduce((n, r) => n.plus(r.quantity!), new Decimal(0));
        if (exits.plus(report.quantity).gt(action.quantity))
          throw Error('Fake exit exceeds close intent');
        const tradeFacts = history.filter((r) => r.tradeId === report.tradeId),
          filled = tradeFacts
            .filter((r) => r.kind === 'ENTRY_FILL')
            .reduce((n, r) => n.plus(r.quantity!), new Decimal(0)),
          closed = tradeFacts
            .filter((r) => r.kind === 'EXIT_FILL')
            .reduce((n, r) => n.plus(r.quantity!), new Decimal(0));
        if (closed.plus(report.quantity).gt(filled))
          throw Error('Fake reduce-only exit exceeds filled position');
      }
      if (
        report.kind === 'STOP_CONFIRMED' &&
        (!['PROTECT', 'AMEND_STOP'].includes(action.kind) ||
          report.revision !== action.revision ||
          !report.quantity ||
          !new Decimal(report.quantity).eq(action.quantity) ||
          report.stopPrice !== action.stopPrice)
      )
        throw Error('Invalid fake protection confirmation');
      await tx.insert(fakeReports).values({
        botId: report.botId,
        actionId: report.actionId,
        eventKey: report.eventId,
        payload: report,
      });
    });
    return report;
  }
  async reconcile(botId: string) {
    const rows = await this.db
      .select()
      .from(fakeReports)
      .where(eq(fakeReports.botId, botId))
      .orderBy(asc(fakeReports.sequence));
    return rows.map((r) => r.payload as Report);
  }
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
