import { reconstructedEquity } from './equity.js';
import { eq, sql } from 'drizzle-orm';
import {
  bots,
  evaluations,
  tradeLifecycles,
  capitalLedger,
  capitalReservations,
  runtimeEvents,
  replaySamples,
  recoveryGaps,
  type Database,
} from '../../database/src/index.js';
import { capitalSnapshot } from '../../database/src/capital.js';
import { FinancialDecimal as D } from '../../core/src/decimal.js';
import { money } from '../../risk/src/sizing.js';
import { digest, type ReplayInput } from './contracts.js';
export async function replayReport(
  db: Database,
  runId: string,
  accountId: string,
  input: ReplayInput,
  inputHash: string,
) {
  const botRows = await db
    .select()
    .from(bots)
    .where(eq(bots.accountId, accountId));
  const trades = await db
    .select()
    .from(tradeLifecycles)
    .where(eq(tradeLifecycles.accountId, accountId));
  const decisions = await db
    .select()
    .from(evaluations)
    .where(eq(evaluations.accountId, accountId));
  const ledger = await db
    .select()
    .from(capitalLedger)
    .where(eq(capitalLedger.accountId, accountId));
  const transitions = await db.execute<{
    kind: string;
    details: { reason?: string };
  }>(
    sql`SELECT kind,details FROM runtime_events WHERE bot_id IN (SELECT id FROM bots WHERE exchange_account_id=${accountId})`,
  );
  const gaps = await db.execute<{
    status: string;
    coverage: Record<string, unknown>;
  }>(
    sql`SELECT status,coverage FROM recovery_gaps WHERE bot_id IN (SELECT id FROM bots WHERE exchange_account_id=${accountId}) ORDER BY start_time`,
  );
  const samples = (
    await db.select().from(replaySamples).where(eq(replaySamples.runId, runId))
  ).sort((a, b) => a.ordinal - b.ordinal);
  const curve = await reconstructedEquity(
    db,
    accountId,
    input.equityBaseline,
    samples,
  );
  const balances = await capitalSnapshot(db, accountId, input.end);
  const total = (kind: string) =>
    ledger
      .filter((l) => l.kind === kind)
      .reduce((n, l) => n.plus(l.amount), new D(0));
  const closed = trades
    .filter((t) => t.state === 'CLOSED')
    .sort(
      (a, b) =>
        a.closedAt! - b.closedAt! ||
        botRows
          .find((row) => row.id === a.botId)!
          .name.localeCompare(botRows.find((row) => row.id === b.botId)!.name),
    );
  const nets = closed.map((t) =>
    ledger
      .filter((l) => l.tradeId === t.id)
      .reduce((n, l) => n.plus(l.amount), new D(0)),
  );
  const wins = nets.filter((n) => n.gt(0)),
    losses = nets.filter((n) => n.lt(0));
  const sum = (xs: import('decimal.js').Decimal[]) =>
    xs.reduce((n, x) => n.plus(x), new D(0));
  let peak = new D(input.equityBaseline),
    maxDrawdown = new D(0),
    streak = 0,
    maxStreak = 0;
  for (const s of curve) {
    peak = D.max(peak, s.equity);
    if (peak.gt(0))
      maxDrawdown = D.max(maxDrawdown, peak.minus(s.equity).div(peak));
  }
  for (const n of nets) {
    streak = n.lt(0) ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const realized = total('GROSS_PNL')
    .plus(total('FEE'))
    .plus(total('FUNDING_PAYMENT'));
  const ending =
    curve.at(-1)?.equity ?? money(new D(input.equityBaseline).plus(realized));
  const noTrade: Record<string, number> = {},
    rejections: Record<string, number> = {};
  for (const e of decisions.filter((e) => e.decision === 'NO_TRADE'))
    noTrade[e.reasonCode] = (noTrade[e.reasonCode] ?? 0) + 1;
  for (const e of transitions.rows.filter((e) => e.kind === 'risk.rejected')) {
    const r = e.details.reason ?? 'UNKNOWN';
    rejections[r] = (rejections[r] ?? 0) + 1;
  }
  const slippage = await db.execute<{ total: string }>(
    sql`SELECT coalesce(sum(abs((r.payload->>'price')::numeric-(p.payload->>'price')::numeric)*(r.payload->>'quantity')::numeric),0)::text AS total FROM paper_execution_reports r JOIN runtime_actions a ON a.id=r.action_id JOIN paper_price_events p ON p.bot_id=r.bot_id AND r.event_key='paper:'||a.id::text||':'||(p.payload->>'tradeId') WHERE r.bot_id IN (SELECT id FROM bots WHERE exchange_account_id=${accountId}) AND r.payload->>'kind' IN ('ENTRY_FILL','EXIT_FILL')`,
  );
  return {
    version: 'replay-report-v1',
    inputHash,
    datasetHash: digest(input.dataset),
    seed: input.seed,
    start: input.start,
    end: input.end,
    status:
      gaps.rows.some((g) => g.status !== 'RESOLVED') ||
      botRows.some((b) => b.tradingState === 'UNRESOLVED')
        ? 'RECONCILIATION_UNCERTAIN'
        : 'COMPLETE',
    metrics: {
      evaluations: decisions.length,
      noTrade: decisions.filter((e) => e.decision === 'NO_TRADE').length,
      noTradeReasons: noTrade,
      longProposals: decisions.filter((e) => e.decision === 'LONG').length,
      shortProposals: decisions.filter((e) => e.decision === 'SHORT').length,
      riskRejections: rejections,
      expired: trades.filter((t) => t.state === 'EXPIRED').length,
      filledTrades: trades.filter((t) => new D(t.filledQuantity).gt(0)).length,
      closedTrades: closed.length,
      openTrades: trades.filter((t) =>
        ['OPEN', 'PENDING_ENTRY', 'CLOSING', 'UNRESOLVED'].includes(t.state),
      ).length,
      realizedNet: money(realized),
      endingEquity: money(ending),
      returnPercent: money(
        new D(ending).div(input.equityBaseline).minus(1).mul(100),
      ),
      fees: money(total('FEE').neg()),
      funding: money(total('FUNDING_PAYMENT')),
      slippage: money(slippage.rows[0]!.total),
      winRate: closed.length
        ? money(new D(wins.length).div(closed.length))
        : null,
      profitFactor: losses.length
        ? money(sum(wins).div(sum(losses).abs()))
        : null,
      expectancy: closed.length ? money(sum(nets).div(closed.length)) : null,
      averageWin: wins.length ? money(sum(wins).div(wins.length)) : null,
      averageLoss: losses.length ? money(sum(losses).div(losses.length)) : null,
      maxDrawdown: money(maxDrawdown),
      maxLosingStreak: maxStreak,
      peakReservedAndCommitted: money(
        samples.reduce((max, s) => D.max(max, s.capacity), new D(0)),
      ),
    },
    bots: botRows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => {
        const balance = balances.find((s) => s.bot_id === b.id)!;
        return {
          key: b.name,
          principal: money(balance.principal),
          balance: money(balance.balance),
          unrealized: money(balance.unrealized),
          operational: b.operationalStatus,
          trading: b.tradingState,
        };
      }),
    trades: closed.map((t, n) => ({
      bot: botRows.find((b) => b.id === t.botId)!.name,
      side: t.side,
      entry: money(t.averageEntry!),
      quantity: money(t.filledQuantity),
      net: money(nets[n]!),
      closeReason: t.closeReason,
      holdingMs: t.closedAt! - t.openedAt!,
    })),
    equityCurve: curve,
    coverage: {
      seedCandles: input.dataset.candles.length,
      events: input.dataset.events.length,
      gaps: gaps.rows.map((g) => ({
        status: g.status,
        reason: g.coverage.reason ?? null,
      })),
    },
    warnings: [
      ...(input.dataset.instrumentHistory === 'CURRENT_ASSUMPTION'
        ? ['CURRENT_INSTRUMENT_ASSUMPTION']
        : []),
      ...(input.dataset.fundingCoverage === 'OMITTED'
        ? ['FUNDING_OMITTED']
        : []),
      ...(trades.some((t) =>
        ['OPEN', 'PENDING_ENTRY', 'CLOSING', 'UNRESOLVED'].includes(t.state),
      )
        ? ['OPEN_POSITIONS_AT_WINDOW_END']
        : []),
      ...(input.dataset.tradeCoverage !== 'COMPLETE_ORDERED'
        ? ['INCOMPLETE_TRADE_COVERAGE']
        : []),
      'RESEARCH_UNVALIDATED',
      'SAMPLE_SIZE_REQUIRES_REVIEW',
    ],
  };
}
