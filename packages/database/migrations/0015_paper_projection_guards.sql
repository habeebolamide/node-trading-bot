CREATE TRIGGER paper_price_immutable BEFORE UPDATE OR DELETE ON paper_price_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER fence_paper_price BEFORE INSERT ON paper_price_events FOR EACH ROW EXECUTE FUNCTION require_runtime_write();
CREATE TRIGGER reservation_no_delete BEFORE DELETE ON paper_reservations FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE FUNCTION fence_paper_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM assert_runtime_write(NEW.bot_id);
 IF NEW.payload->>'botId' IS DISTINCT FROM NEW.bot_id::text OR NEW.payload->>'actionId' IS DISTINCT FROM NEW.action_id::text OR NEW.payload->>'eventId' IS DISTINCT FROM NEW.event_key THEN RAISE EXCEPTION 'Paper fact identity mismatch'; END IF;
 IF NEW.payload->>'kind' IN ('ENTRY_FILL','EXIT_FILL') AND (NOT (NEW.payload ? 'fee') OR (NEW.payload->>'fee')::numeric<0 OR (NEW.payload->>'quantity')::numeric<=0 OR (NEW.payload->>'price')::numeric<=0) THEN RAISE EXCEPTION 'Paper fills require explicit simulated costs'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER paper_fact_fence BEFORE INSERT ON paper_execution_reports FOR EACH ROW EXECUTE FUNCTION fence_paper_fact();
CREATE FUNCTION protect_equity_peak() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM bots b WHERE b.id::text=current_setting('platform.runtime_bot',true) AND b.exchange_account_id=NEW.account_id) THEN RAISE EXCEPTION 'Paper equity peak account mismatch'; END IF;
 PERFORM assert_runtime_write(current_setting('platform.runtime_bot')::uuid);
 IF TG_OP='UPDATE' AND (NEW.peak<OLD.peak OR NEW.scope<>OLD.scope OR NEW.account_id<>OLD.account_id) THEN RAISE EXCEPTION 'Equity peak cannot regress'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER paper_peak_guard BEFORE INSERT OR UPDATE ON paper_equity_peaks FOR EACH ROW EXECUTE FUNCTION protect_equity_peak();
--> statement-breakpoint
CREATE FUNCTION check_paper_reservation_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r paper_reservations; t trade_lifecycles; unit numeric; outstanding numeric; open_qty numeric;
BEGIN
 IF TG_TABLE_NAME='trade_lifecycles' THEN
  IF NEW.execution_backend<>'PAPER' THEN RETURN NEW; END IF;
  SELECT * INTO r FROM paper_reservations WHERE trade_id=NEW.id;
 ELSE SELECT * INTO r FROM paper_reservations WHERE trade_id=NEW.trade_id;
 END IF;
 SELECT * INTO t FROM trade_lifecycles WHERE id=r.trade_id;
 unit:=((r.approval->>'margin')::numeric+(r.approval->>'buffer')::numeric)/(r.approval->>'quantity')::numeric;
 outstanding:=CASE WHEN t.entry_terminal THEN 0 ELSE t.requested_quantity-t.filled_quantity END;
 open_qty:=t.filled_quantity-t.closed_quantity;
 IF abs(r.reserved-trunc(outstanding*unit,18))>0.00000000000000001 OR abs(r.committed-trunc(open_qty*unit,18))>0.00000000000000001
 OR abs(r.notional-trunc((outstanding+open_qty)*(r.approval->>'entry')::numeric,18))>0.00000000000000001 THEN RAISE EXCEPTION 'Capital reservation disagrees with durable exposure'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER reservation_projection AFTER INSERT OR UPDATE ON paper_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_paper_reservation_projection();
CREATE CONSTRAINT TRIGGER paper_trade_capacity AFTER INSERT OR UPDATE ON trade_lifecycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_paper_reservation_projection();
CREATE FUNCTION guard_paper_financial_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fact jsonb; t trade_lifecycles; expected numeric; equity numeric; funded numeric;
BEGIN
 PERFORM 1 FROM exchange_accounts WHERE id=NEW.account_id FOR UPDATE;
 IF NEW.kind='FUNDING' THEN
  SELECT equity_baseline+coalesce((SELECT sum(amount) FROM paper_capital_ledger WHERE account_id=NEW.account_id AND kind<>'FUNDING'),0) INTO equity FROM exchange_accounts WHERE id=NEW.account_id;
  SELECT coalesce(sum(amount),0) INTO funded FROM paper_capital_ledger WHERE account_id=NEW.account_id;
  IF funded+NEW.amount>equity*.8 THEN RAISE EXCEPTION 'Initial paper funding exceeds refreshed allocation envelope'; END IF;
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
CREATE TRIGGER capital_evidence BEFORE INSERT ON paper_capital_ledger FOR EACH ROW EXECUTE FUNCTION guard_paper_financial_evidence();
