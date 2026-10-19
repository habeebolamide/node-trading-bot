import { randomUUID } from 'node:crypto';
import { FinancialDecimal as Decimal } from '../../core/src/decimal.js';
import type { Decimal as DecimalValue } from 'decimal.js';
import type {
  View,
  Change,
  Action,
  ActionKind,
  Price,
  Trade,
  EntryProposal,
  Report,
  Command,
  PositionInput,
} from './contracts.js';
const live = (a: Action) =>
  ['CREATED', 'SUBMITTING', 'OPEN', 'UNKNOWN'].includes(a.state);
const decimal = (s: string) => new Decimal(s);
const text = (d: DecimalValue) =>
  d.toFixed(18, Decimal.ROUND_HALF_EVEN).replace(/\.?0+$/, '') || '0';
export const openQuantity = (t: Trade) =>
  decimal(t.filledQuantity).minus(t.closedQuantity);
function change(view: View, kind: string): Change {
  return { view: structuredClone(view), actions: [], kind, details: {} };
}
function action(
  c: Change,
  kind: ActionKind,
  key: string,
  quantity: string,
  reason: string,
  now: number,
) {
  const t = c.view.trade!;
  if (c.view.actions.some((a) => a.key === key)) return;
  const a: Action = {
    id: randomUUID(),
    botId: c.view.botId,
    tradeId: t.id,
    key,
    kind,
    state: 'CREATED',
    quantity,
    price: kind === 'ENTRY' ? t.entryReference : null,
    stopPrice: ['PROTECT', 'AMEND_STOP', 'ENTRY'].includes(kind)
      ? t.desiredStop
      : null,
    takeProfit: ['PROTECT', 'ENTRY'].includes(kind) ? t.takeProfit : null,
    revision: t.protectionRevision,
    reason,
    createdAt: now,
  };
  c.actions.push(a);
  c.view.actions.push(a);
  return a;
}
function active(c: Change, kind: ActionKind) {
  return c.view.actions.some(
    (a) => a.tradeId === c.view.trade?.id && a.kind === kind && live(a),
  );
}
function cancelRemainder(c: Change, reason: string, now: number) {
  const t = c.view.trade!;
  if (!t.entryTerminal && !active(c, 'CANCEL_ENTRY')) {
    t.pendingCancelReason = reason;
    action(
      c,
      'CANCEL_ENTRY',
      `cancel:${t.id}`,
      text(decimal(t.requestedQuantity).minus(t.filledQuantity)),
      reason,
      now,
    );
  }
}
function protection(c: Change, now: number) {
  const t = c.view.trade!,
    qty = openQuantity(t);
  if (
    c.view.fault ||
    qty.lte(0) ||
    active(c, 'PROTECT') ||
    active(c, 'AMEND_STOP')
  )
    return;
  if (
    !t.confirmedStop ||
    decimal(t.protectedQuantity).lt(qty) ||
    !decimal(t.desiredStop).eq(t.confirmedStop)
  ) {
    t.protectionRevision++;
    t.submittedStop = t.desiredStop;
    t.protectionStatus = 'REQUESTED';
    action(
      c,
      t.confirmedStop ? 'AMEND_STOP' : 'PROTECT',
      `protect:${t.id}:${t.protectionRevision}`,
      text(qty),
      'PROTECT_FILLED_EXPOSURE',
      now,
    );
  }
}
function finish(c: Change, now: number) {
  const t = c.view.trade;
  if (!t) return;
  const qty = openQuantity(t);
  if (
    qty.isZero() &&
    t.entryTerminal &&
    !c.view.actions.some(
      (a) => a.tradeId === t.id && live(a) && a.kind !== 'ENTRY',
    )
  ) {
    t.state = decimal(t.filledQuantity).gt(0)
      ? 'CLOSED'
      : t.pendingCancelReason === 'ENTRY_EXPIRED'
        ? 'EXPIRED'
        : 'CANCELLED';
    t.closedAt = now;
    c.view.trading = 'IDLE';
    if (c.view.desired === 'STOPPED') c.view.operational = 'STOPPED';
  } else if (
    t.closeReason &&
    qty.gt(0) &&
    !active(c, 'CLOSE') &&
    !c.view.actions.some((a) => a.kind === 'CLOSE' && a.state === 'REJECTED')
  ) {
    t.state = 'CLOSING';
    c.view.trading = 'CLOSING';
    t.closeGeneration++;
    action(
      c,
      'CLOSE',
      `close:${t.id}:${t.closeGeneration}`,
      text(qty),
      t.closeReason,
      now,
    );
  }
}
function requestClose(c: Change, reason: string, now: number) {
  const t = c.view.trade!;
  t.closeReason ??= reason;
  cancelRemainder(c, reason, now);
  finish(c, now);
}
export class PositionManager {
  command(view: View, command: Command, now: number) {
    const c = change(view, `command.${command.kind.toLowerCase()}`);
    c.commandId = command.id;
    const reject = (error: string) => {
      c.commandError = error;
      c.details = { error };
      return c;
    };
    switch (command.kind) {
      case 'START':
        if (view.operational !== 'STOPPED' || view.trading !== 'IDLE')
          return reject('START_REQUIRES_STOPPED_IDLE');
        c.view.desired = 'RUNNING';
        c.view.operational = 'STARTING';
        break;
      case 'PAUSE':
        if (view.operational === 'STOPPED') return reject('BOT_IS_STOPPED');
        c.view.desired = 'PAUSED';
        c.view.operational = 'PAUSED';
        if (c.view.trade) cancelRemainder(c, 'PAUSE', now);
        break;
      case 'RESUME':
        if (view.desired !== 'PAUSED' || view.fault)
          return reject('RESUME_REQUIRES_PAUSED_AND_RECONCILED');
        c.view.desired = 'RUNNING';
        c.view.operational = 'RECONCILING';
        break;
      case 'STOP':
        c.view.desired = 'STOPPED';
        c.view.operational =
          c.view.trading === 'IDLE' ? 'STOPPED' : 'STOP_REQUESTED';
        if (c.view.trade) cancelRemainder(c, 'STOP_REQUESTED', now);
        break;
    }
    return c;
  }
  restore(view: View) {
    const c = change(view, 'runtime.restoring');
    if (
      (view.operational === 'STOPPED' && view.trading === 'IDLE') ||
      view.operational === 'RISK_SUSPENDED'
    )
      return c;
    c.view.operational = 'RECONCILING';
    return c;
  }
  readiness(view: View, ready: boolean, now: number) {
    const c = change(view, 'runtime.readiness');
    if (view.operational === 'RISK_SUSPENDED' && view.desired === 'RUNNING')
      return c;
    const unresolved =
      view.actions.some(
        (a) => a.state === 'UNKNOWN' || a.state === 'SUBMITTING',
      ) ||
      view.trade?.protectionStatus === 'UNKNOWN' ||
      view.trading === 'UNRESOLVED';
    if (unresolved || view.fault) {
      c.view.operational = 'RECONCILING';
      return c;
    }
    if (view.desired === 'STOPPED') {
      c.view.operational =
        view.trading === 'IDLE' ? 'STOPPED' : 'STOP_REQUESTED';
      return c;
    }
    if (view.desired === 'PAUSED') {
      c.view.operational = 'PAUSED';
      return c;
    }
    if (view.operational === 'STARTING' || view.operational === 'RECONCILING') {
      c.view.operational = 'WARMING_UP';
      return c;
    }
    c.view.operational = ready ? 'RUNNING' : 'WARMING_UP';
    if (c.view.trade) protection(c, now);
    return c;
  }
  entry(
    view: View,
    proposal: EntryProposal,
    evaluationId: string,
    policy: Trade['policy'],
    now: number,
    atr?: number,
  ) {
    const c = change(view, 'trade.entry_requested');
    if (
      view.operational !== 'RUNNING' ||
      view.trading !== 'IDLE' ||
      view.fault ||
      view.executionMode !== 'PAPER'
    )
      return c;
    if (proposal.expiresAt <= now) return c;
    const t: Trade = {
      id: randomUUID(),
      botId: view.botId,
      accountId: view.accountId,
      evaluationId,
      state: 'PENDING_ENTRY',
      side: proposal.side,
      orderType: proposal.orderType,
      requestedQuantity: '1',
      filledQuantity: '0',
      closedQuantity: '0',
      entryReference: proposal.entryPrice,
      averageEntry: null,
      initialStop: proposal.stopLoss,
      desiredStop: proposal.stopLoss,
      submittedStop: null,
      confirmedStop: null,
      takeProfit: proposal.takeProfit,
      protectedQuantity: '0',
      protectionRevision: 0,
      confirmedRevision: 0,
      protectionStatus: 'UNCONFIRMED',
      entryTerminal: false,
      expiresAt: proposal.expiresAt,
      openedAt: null,
      createdAt: now,
      closedAt: null,
      closeReason: null,
      closeGeneration: 0,
      pendingCancelReason: null,
      trailingDistance:
        atr && policy.trailingStop.enabled
          ? text(
              new Decimal(String(atr))
                .toSignificantDigits(12)
                .mul(policy.trailingStop.atrMultiplier),
            )
          : null,
      policy: structuredClone(policy),
      executionBackend: 'FAKE_CONTRACT',
    };
    c.view.trade = t;
    c.view.trading = 'PENDING_ENTRY';
    action(
      c,
      'ENTRY',
      `entry:${evaluationId}`,
      '1',
      'FAKE_CONTRACT_NOT_RISK_SIZED',
      now,
    );
    return c;
  }
  timer(view: View, now: number) {
    const c = change(view, 'trade.timer');
    if (
      c.view.trade &&
      ['PENDING_ENTRY', 'OPEN', 'CLOSING', 'UNRESOLVED'].includes(
        c.view.trade.state,
      )
    ) {
      if (!c.view.trade.entryTerminal && now >= c.view.trade.expiresAt) {
        cancelRemainder(c, 'ENTRY_EXPIRED', now);
      }
      if (openQuantity(c.view.trade).gt(0)) protection(c, now);
      finish(c, now);
    }
    return c;
  }
  pendingInvalidated(view: View, reason: string, now: number) {
    const c = change(view, 'trade.pending_invalidated');
    if (c.view.trade && !c.view.trade.entryTerminal) {
      cancelRemainder(c, reason, now);
    }
    return c;
  }
  close(view: View, reason: string, now: number) {
    const c = change(view, 'position.close_requested');
    if (c.view.trade && openQuantity(c.view.trade).gt(0))
      requestClose(c, reason, now);
    return c;
  }
  price(view: View, event: Price) {
    const c = change(view, 'position.price');
    c.details = {
      sourceTime: event.eventTime,
      observedAt: event.observedAt,
      tradeEventId: event.tradeId,
    };
    const t = c.view.trade;
    if (
      !t ||
      openQuantity(t).lte(0) ||
      event.marketKey !== view.marketKey ||
      event.late ||
      event.eventTime < view.lastPriceTime ||
      event.eventTime < (t.openedAt ?? 0)
    )
      return c;
    c.view.lastPriceTime = event.eventTime;
    const p = decimal(event.price),
      long = t.side === 'LONG';
    if (
      t.confirmedStop &&
      decimal(t.protectedQuantity).gte(openQuantity(t)) &&
      (long ? p.lte(t.confirmedStop) : p.gte(t.confirmedStop))
    )
      requestClose(c, 'STOP_LOSS', event.observedAt);
    else if (
      decimal(t.protectedQuantity).gte(openQuantity(t)) &&
      (long ? p.gte(t.takeProfit) : p.lte(t.takeProfit))
    )
      requestClose(c, 'TAKE_PROFIT', event.observedAt);
    else if (!t.closeReason && t.averageEntry) {
      const entry = decimal(t.averageEntry),
        risk = entry.minus(t.initialStop).abs(),
        profit = p.minus(entry).mul(long ? 1 : -1);
      if (
        t.policy.breakEven.enabled &&
        risk.gt(0) &&
        profit.gte(risk.mul(t.policy.breakEven.triggerR))
      ) {
        const candidate = entry.plus(
          risk.mul(t.policy.breakEven.offsetR).mul(long ? 1 : -1),
        );
        if (
          long
            ? candidate.gt(t.desiredStop) && candidate.lt(p)
            : candidate.lt(t.desiredStop) && candidate.gt(p)
        )
          t.desiredStop = text(candidate);
      }
      if (t.policy.trailingStop.enabled && t.trailingDistance) {
        const candidate = p.minus(
          decimal(t.trailingDistance).mul(long ? 1 : -1),
        );
        if (
          candidate.gt(0) &&
          (long
            ? candidate.gt(t.desiredStop) && candidate.lt(p)
            : candidate.lt(t.desiredStop) && candidate.gt(p))
        )
          t.desiredStop = text(candidate);
      }
      protection(c, event.observedAt);
    }
    return c;
  }
  assessment(view: View, input: PositionInput, now: number) {
    const c = change(view, 'position.assessed'),
      t = c.view.trade;
    if (!t || openQuantity(t).lte(0)) return c;
    const atr = input.context.indicators.atr?.latest.outReal;
    if (atr && t.policy.trailingStop.enabled)
      t.trailingDistance = text(
        new Decimal(String(atr))
          .toSignificantDigits(12)
          .mul(t.policy.trailingStop.atrMultiplier),
      );
    const a = input.assessment;
    if (
      a.action === 'CLOSE_EARLY' &&
      (a.reason === 'MAX_HOLDING_TIME'
        ? t.policy.timeExit.enabled
        : t.policy.earlyExit.enabled)
    )
      requestClose(c, a.reason, now);
    else if (a.action === 'SUGGEST_STOP' && t.policy.trailingStop.enabled) {
      const p = decimal(a.newStopPrice),
        better = t.side === 'LONG' ? p.gt(t.desiredStop) : p.lt(t.desiredStop);
      if (better && p.gt(0)) {
        t.desiredStop = text(p);
        protection(c, now);
      }
    }
    c.details = {
      assessment: a,
      sourceTime: input.context.marketCutoff,
      observedAt: now,
    };
    return c;
  }
  report(view: View, report: Report, now: number) {
    const c = change(view, `execution.${report.kind.toLowerCase()}`),
      t = c.view.trade,
      a = c.view.actions.find((a) => a.id === report.actionId);
    if (
      !t ||
      t.id !== report.tradeId ||
      !a ||
      a.tradeId !== t.id ||
      report.botId !== view.botId
    )
      throw Error('Execution report does not match active trade/action');
    c.details.report = structuredClone(report);
    switch (report.kind) {
      case 'ENTRY_OPEN':
        a.state = 'OPEN';
        if (t.state === 'UNRESOLVED') {
          t.state = decimal(t.filledQuantity).gt(0) ? 'OPEN' : 'PENDING_ENTRY';
          c.view.trading = t.state === 'OPEN' ? 'IN_TRADE' : 'PENDING_ENTRY';
        }
        break;
      case 'ENTRY_FILL': {
        if (a.kind !== 'ENTRY' || !report.quantity || !report.price)
          throw Error('Invalid entry fill');
        const qty = decimal(report.quantity),
          price = decimal(report.price),
          filled = decimal(t.filledQuantity);
        if (
          qty.lte(0) ||
          price.lte(0) ||
          filled.plus(qty).gt(t.requestedQuantity)
        )
          throw Error('Invalid/overfilled entry');
        t.averageEntry = text(
          (t.averageEntry ? decimal(t.averageEntry).mul(filled) : decimal('0'))
            .plus(price.mul(qty))
            .div(filled.plus(qty)),
        );
        t.filledQuantity = text(filled.plus(qty));
        t.openedAt ??= report.eventTime;
        t.entryTerminal = filled.plus(qty).eq(t.requestedQuantity);
        a.state = t.entryTerminal ? 'FILLED' : 'OPEN';
        t.state = t.closeReason ? 'CLOSING' : 'OPEN';
        c.view.trading = t.closeReason ? 'CLOSING' : 'IN_TRADE';
        t.protectionStatus = 'UNCONFIRMED';
        protection(c, now);
        break;
      }
      case 'ENTRY_CANCELLED':
      case 'ENTRY_REJECTED':
        t.entryTerminal = true;
        {
          const entry = c.view.actions.find(
            (x) => x.tradeId === t.id && x.kind === 'ENTRY',
          );
          if (entry)
            entry.state =
              report.kind === 'ENTRY_REJECTED'
                ? 'REJECTED'
                : decimal(t.filledQuantity).eq(t.requestedQuantity)
                  ? 'FILLED'
                  : 'CANCELLED';
        }
        a.state =
          report.kind === 'ENTRY_REJECTED'
            ? 'REJECTED'
            : a.kind === 'ENTRY'
              ? decimal(t.filledQuantity).eq(t.requestedQuantity)
                ? 'FILLED'
                : 'CANCELLED'
              : 'CONFIRMED';
        if (openQuantity(t).gt(0)) protection(c, now);
        break;
      case 'CLOSE_OPEN':
        if (a.kind !== 'CLOSE') throw Error('Mismatched close acknowledgment');
        a.state = 'OPEN';
        break;
      case 'EXIT_FILL': {
        if (a.kind !== 'CLOSE' || !report.quantity || !report.price)
          throw Error('Invalid exit fill');
        const qty = decimal(report.quantity);
        if (qty.lte(0) || qty.gt(openQuantity(t)))
          throw Error('Exit cannot exceed position');
        t.closedQuantity = text(decimal(t.closedQuantity).plus(qty));
        a.state = report.terminal ? 'FILLED' : 'OPEN';
        if (openQuantity(t).isZero()) a.state = 'FILLED';
        t.protectedQuantity = text(
          Decimal.min(decimal(t.protectedQuantity), openQuantity(t)),
        );
        break;
      }
      case 'STOP_CONFIRMED': {
        if (
          !['PROTECT', 'AMEND_STOP'].includes(a.kind) ||
          report.revision !== a.revision ||
          report.stopPrice !== a.stopPrice ||
          !report.quantity ||
          !decimal(report.quantity).eq(a.quantity)
        )
          throw Error('Protection acknowledgment mismatch');
        a.state = 'CONFIRMED';
        if (a.revision >= t.confirmedRevision) {
          const p = decimal(report.stopPrice);
          if (
            t.confirmedStop &&
            (t.side === 'LONG' ? p.lt(t.confirmedStop) : p.gt(t.confirmedStop))
          )
            throw Error('Confirmed stop cannot widen');
          t.confirmedStop = report.stopPrice;
          t.confirmedRevision = a.revision;
          t.protectedQuantity = text(
            Decimal.min(decimal(report.quantity), openQuantity(t)),
          );
          t.protectionStatus = decimal(t.protectedQuantity).gte(openQuantity(t))
            ? 'CONFIRMED'
            : 'UNCONFIRMED';
        }
        protection(c, now);
        break;
      }
      case 'REJECTED':
      case 'UNKNOWN':
        a.state = report.kind === 'REJECTED' ? 'REJECTED' : 'UNKNOWN';
        t.state = 'UNRESOLVED';
        c.view.trading = 'UNRESOLVED';
        c.view.operational = 'RECONCILING';
        if (['PROTECT', 'AMEND_STOP'].includes(a.kind))
          t.protectionStatus = 'UNKNOWN';
        c.view.fault = 'EXECUTION_RECONCILIATION_REQUIRED';
        break;
    }
    if (
      !c.view.actions.some(
        (x) =>
          x.state === 'UNKNOWN' ||
          (x.state === 'REJECTED' && x.kind !== 'ENTRY'),
      ) &&
      report.kind !== 'UNKNOWN' &&
      report.kind !== 'REJECTED'
    ) {
      c.view.fault = null;
      if (t.state === 'UNRESOLVED') {
        t.state = openQuantity(t).gt(0) ? 'OPEN' : 'PENDING_ENTRY';
        c.view.trading = t.state === 'OPEN' ? 'IN_TRADE' : 'PENDING_ENTRY';
      }
    }
    finish(c, now);
    return c;
  }
}
