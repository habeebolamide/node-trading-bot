import type { Pool } from 'pg';
export async function verifyFinancialIntegrity(pool: Pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const violations = await db.query(`WITH facts AS (
   SELECT t.id,t.bot_id,t.filled_quantity,t.closed_quantity,t.state,t.average_entry,
    coalesce(sum((p.payload->>'quantity')::numeric) FILTER(WHERE p.payload->>'kind'='ENTRY_FILL'),0) AS entered,
    coalesce(sum((p.payload->>'quantity')::numeric) FILTER(WHERE p.payload->>'kind'='EXIT_FILL'),0) AS exited,
    coalesce(sum((p.payload->>'fee')::numeric) FILTER(WHERE p.payload->>'kind' IN ('ENTRY_FILL','EXIT_FILL')),0) AS fees,
    coalesce(sum(trunc(((p.payload->>'price')::numeric-t.average_entry)*(p.payload->>'quantity')::numeric*CASE WHEN t.side='LONG' THEN 1 ELSE -1 END,18)) FILTER(WHERE p.payload->>'kind'='EXIT_FILL'),0) AS gross
   FROM trade_lifecycles t LEFT JOIN (paper_execution_reports p JOIN runtime_events e ON e.bot_id=p.bot_id AND e.event_key='report:'||p.event_key) ON p.payload->>'tradeId'=t.id::text
   WHERE t.execution_backend='PAPER' GROUP BY t.id
  ),booked AS(SELECT trade_id,coalesce(sum(amount) FILTER(WHERE kind='FEE'),0) AS fees,coalesce(sum(amount) FILTER(WHERE kind='GROSS_PNL'),0) AS gross,coalesce(sum(amount) FILTER(WHERE kind='FUNDING_PAYMENT'),0) AS funding FROM paper_capital_ledger WHERE trade_id IS NOT NULL GROUP BY trade_id)
  SELECT f.id FROM facts f LEFT JOIN booked b ON b.trade_id=f.id
  WHERE f.entered<>f.filled_quantity OR f.exited<>f.closed_quantity OR abs(f.fees+coalesce(b.fees,0))>0.00000000000000001 OR abs(f.gross-coalesce(b.gross,0))>0.00000000000000001
   OR coalesce(b.funding,0)<>(SELECT coalesce(sum(amount),0) FROM paper_funding_events WHERE trade_id=f.id)
   OR EXISTS(SELECT 1 FROM paper_reservations r WHERE r.trade_id=f.id AND (r.reserved<0 OR r.committed<0 OR (f.state IN ('CLOSED','CANCELLED','EXPIRED') AND r.reserved+r.committed<>0)))`);
    if (violations.rowCount)
      throw Error(
        `Financial integrity failed for ${violations.rowCount} trade(s); keep entries frozen and investigate`,
      );
    const result = await db.query(
      "SELECT count(*)::int AS paper_trades,count(*) FILTER(WHERE state='UNRESOLVED')::int AS unresolved FROM trade_lifecycles WHERE execution_backend='PAPER'",
    );
    await db.query('COMMIT');
    return result.rows[0] as { paper_trades: number; unresolved: number };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
