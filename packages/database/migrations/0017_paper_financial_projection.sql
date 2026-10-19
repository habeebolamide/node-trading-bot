CREATE FUNCTION check_paper_financial_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t trade_lifecycles; target uuid; entered numeric; exited numeric; cost numeric; gross numeric; booked_fee numeric; booked_gross numeric;
BEGIN
 IF TG_TABLE_NAME='trade_lifecycles' THEN target:=NEW.id; ELSE target:=NEW.trade_id; END IF;
 SELECT * INTO t FROM trade_lifecycles WHERE id=target;
 IF t.execution_backend IS DISTINCT FROM 'PAPER' THEN RETURN NEW; END IF;
 SELECT coalesce(sum((p.payload->>'quantity')::numeric) FILTER(WHERE p.payload->>'kind'='ENTRY_FILL'),0),
 coalesce(sum((p.payload->>'quantity')::numeric) FILTER(WHERE p.payload->>'kind'='EXIT_FILL'),0),
 coalesce(sum((p.payload->>'fee')::numeric) FILTER(WHERE p.payload->>'kind' IN ('ENTRY_FILL','EXIT_FILL')),0),
 coalesce(sum(trunc(((p.payload->>'price')::numeric-t.average_entry)*(p.payload->>'quantity')::numeric*CASE WHEN t.side='LONG' THEN 1 ELSE -1 END,18)) FILTER(WHERE p.payload->>'kind'='EXIT_FILL'),0)
 INTO entered,exited,cost,gross FROM paper_execution_reports p JOIN runtime_events e ON e.bot_id=p.bot_id AND e.idempotency_key='report:'||p.event_key WHERE p.payload->>'tradeId'=target::text;
 SELECT coalesce(sum(amount) FILTER(WHERE kind='FEE'),0),coalesce(sum(amount) FILTER(WHERE kind='GROSS_PNL'),0) INTO booked_fee,booked_gross FROM paper_capital_ledger WHERE trade_id=target;
 IF entered<>t.filled_quantity OR exited<>t.closed_quantity OR abs(booked_fee+cost)>0.00000000000000001 OR abs(booked_gross-gross)>0.00000000000000001 THEN RAISE EXCEPTION 'Paper fills, position and capital ledger disagree'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER paper_financial_projection AFTER INSERT OR UPDATE ON trade_lifecycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_paper_financial_projection();
CREATE CONSTRAINT TRIGGER paper_ledger_projection AFTER INSERT ON paper_capital_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_paper_financial_projection();
