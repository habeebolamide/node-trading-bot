CREATE TRIGGER paper_funding_immutable BEFORE UPDATE OR DELETE ON paper_funding_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER paper_funding_fence BEFORE INSERT ON paper_funding_events FOR EACH ROW EXECUTE FUNCTION require_runtime_write();
CREATE OR REPLACE FUNCTION guard_paper_financial_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fact jsonb; t trade_lifecycles; expected numeric; equity numeric; funded numeric;
BEGIN
 PERFORM 1 FROM exchange_accounts WHERE id=NEW.account_id FOR UPDATE;
 IF NEW.kind='FUNDING' THEN
  SELECT equity_baseline+coalesce((SELECT sum(amount) FROM paper_capital_ledger WHERE account_id=NEW.account_id AND kind<>'FUNDING'),0) INTO equity FROM exchange_accounts WHERE id=NEW.account_id;
  SELECT coalesce(sum(amount),0) INTO funded FROM paper_capital_ledger WHERE account_id=NEW.account_id;
  IF funded+NEW.amount>equity*.8 THEN RAISE EXCEPTION 'Initial paper funding exceeds refreshed allocation envelope'; END IF;
 ELSIF NEW.kind='FUNDING_PAYMENT' THEN
  IF NOT EXISTS(SELECT 1 FROM paper_funding_events f JOIN trade_lifecycles t ON t.id=f.trade_id WHERE NEW.source='funding:'||f.key AND f.bot_id=NEW.bot_id AND f.trade_id=NEW.trade_id AND t.account_id=NEW.account_id AND f.amount=NEW.amount AND f.amount=trunc(f.price*f.quantity*f.rate::numeric*CASE WHEN t.side='LONG' THEN -1 ELSE 1 END,18)) THEN RAISE EXCEPTION 'Funding requires attributed rate/position evidence'; END IF;
 ELSE
  SELECT payload INTO fact FROM paper_execution_reports WHERE event_key=regexp_replace(NEW.source,'^report:(.*):(FEE|GROSS_PNL)$','\1') AND bot_id=NEW.bot_id;
  SELECT * INTO t FROM trade_lifecycles WHERE id=NEW.trade_id;
  IF fact IS NULL OR fact->>'tradeId' IS DISTINCT FROM NEW.trade_id::text THEN RAISE EXCEPTION 'Capital posting requires its own paper fill evidence'; END IF;
  IF NEW.kind='FEE' AND fact->>'kind' IN ('ENTRY_FILL','EXIT_FILL') THEN expected:=-(fact->>'fee')::numeric;
  ELSIF NEW.kind='GROSS_PNL' AND fact->>'kind'='EXIT_FILL' THEN expected:=((fact->>'price')::numeric-t.average_entry)*(fact->>'quantity')::numeric*CASE WHEN t.side='LONG' THEN 1 ELSE -1 END;
  ELSE RAISE EXCEPTION 'Financial posting kind does not match fill'; END IF;
  IF abs(NEW.amount-trunc(expected,18))>0.00000000000000001 THEN RAISE EXCEPTION 'Financial posting amount disagrees with fill'; END IF;
 END IF;
 RETURN NEW;
END $$;
