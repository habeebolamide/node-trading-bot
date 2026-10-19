import { sql } from 'drizzle-orm';
import type { Database } from '../../database/src/index.js';
import { FinancialDecimal as D } from '../../core/src/decimal.js';
import { money } from '../../risk/src/sizing.js';
// Recovered facts are inserted later, but their economic effects belong to their
// original observation time. Reconstruct reporting only; never rewrite the ledger.
export async function reconstructedEquity(
  db: Database,
  accountId: string,
  baseline: string,
  samples: { eventTime: number; ordinal: number; capacity: string }[],
) {
  const postings = await db.execute<{ amount: string; event_time: number }>(
    sql`SELECT amount::text,event_time FROM paper_capital_ledger WHERE account_id=${accountId} AND kind<>'FUNDING' ORDER BY event_time,sequence`,
  );
  const fills = await db.execute<{
    payload: {
      tradeId: string;
      botId: string;
      eventTime: number;
      quantity: string;
      price: string;
      kind: string;
    };
    side: string;
  }>(
    sql`SELECT p.payload,t.side FROM paper_execution_reports p JOIN trade_lifecycles t ON t.id=(p.payload->>'tradeId')::uuid WHERE t.account_id=${accountId} AND p.payload->>'kind' IN ('ENTRY_FILL','EXIT_FILL') ORDER BY (p.payload->>'eventTime')::bigint,p.sequence`,
  );
  const quotes = await db.execute<{
    bot_id: string;
    payload: { observedAt: number; price: string };
  }>(
    sql`SELECT p.bot_id,p.payload FROM paper_price_events p JOIN bots b ON b.id=p.bot_id WHERE b.exchange_account_id=${accountId} ORDER BY (p.payload->>'observedAt')::bigint,(p.payload->>'eventTime')::bigint,coalesce((p.payload->>'sequence')::bigint,0),p.key`,
  );
  let cash = new D(baseline),
    l = 0,
    f = 0,
    q = 0;
  const positions = new Map<
      string,
      {
        bot: string;
        side: string;
        entered: InstanceType<typeof D>;
        closed: InstanceType<typeof D>;
        cost: InstanceType<typeof D>;
      }
    >(),
    marks = new Map<string, string>();
  return samples.map((sample) => {
    while (
      l < postings.rows.length &&
      Number(postings.rows[l]!.event_time) <= sample.eventTime
    )
      cash = cash.plus(postings.rows[l++]!.amount);
    while (
      f < fills.rows.length &&
      fills.rows[f]!.payload.eventTime <= sample.eventTime
    ) {
      const { payload: e, side } = fills.rows[f++]!;
      const position = positions.get(e.tradeId) ?? {
        bot: e.botId,
        side,
        entered: new D(0),
        closed: new D(0),
        cost: new D(0),
      };
      if (e.kind === 'ENTRY_FILL') {
        position.entered = position.entered.plus(e.quantity);
        position.cost = position.cost
          .plus(new D(e.quantity).mul(e.price))
          .div(position.entered)
          .toDecimalPlaces(18, D.ROUND_HALF_EVEN)
          .mul(position.entered);
      } else position.closed = position.closed.plus(e.quantity);
      positions.set(e.tradeId, position);
    }
    while (
      q < quotes.rows.length &&
      quotes.rows[q]!.payload.observedAt <= sample.eventTime
    ) {
      const quote = quotes.rows[q++]!;
      marks.set(quote.bot_id, quote.payload.price);
    }
    let equity = cash;
    for (const position of positions.values()) {
      const open = position.entered.minus(position.closed);
      if (open.gt(0) && position.entered.gt(0)) {
        const entry = position.cost.div(position.entered),
          mark = marks.get(position.bot);
        if (mark)
          equity = equity.plus(
            new D(mark)
              .minus(entry)
              .mul(open)
              .mul(position.side === 'LONG' ? 1 : -1),
          );
      }
    }
    return {
      ordinal: sample.ordinal,
      time: sample.eventTime,
      equity: money(equity),
      capacity: money(sample.capacity),
    };
  });
}
