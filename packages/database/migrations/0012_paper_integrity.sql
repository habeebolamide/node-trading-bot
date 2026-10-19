CREATE OR REPLACE FUNCTION validate_action_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM trade_lifecycles WHERE id=NEW.trade_id AND bot_id=NEW.bot_id AND execution_backend IN ('FAKE_CONTRACT','PAPER')) THEN
  RAISE EXCEPTION 'Action scope mismatch' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.bot_id,NEW.trade_id,NEW.idempotency_key,NEW.kind,NEW.quantity,NEW.price,NEW.stop_price,NEW.take_profit,NEW.revision)
 IS DISTINCT FROM ROW(OLD.id,OLD.bot_id,OLD.trade_id,OLD.idempotency_key,OLD.kind,OLD.quantity,OLD.price,OLD.stop_price,OLD.take_profit,OLD.revision) THEN
  RAISE EXCEPTION 'Execution intent is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER paper_report_immutable BEFORE UPDATE OR DELETE ON paper_execution_reports FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER capital_immutable BEFORE UPDATE OR DELETE ON paper_capital_ledger FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER fence_paper_mark BEFORE INSERT OR UPDATE ON paper_marks FOR EACH ROW EXECUTE FUNCTION require_runtime_write();
CREATE TRIGGER fence_paper_reservation BEFORE INSERT OR UPDATE ON paper_reservations FOR EACH ROW EXECUTE FUNCTION require_runtime_write();
CREATE FUNCTION guard_execution_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE backend text;
BEGIN
 SELECT t.execution_backend INTO backend FROM runtime_actions a JOIN trade_lifecycles t ON t.id=a.trade_id WHERE a.id=NEW.action_id AND a.bot_id=NEW.bot_id;
 IF backend IS DISTINCT FROM (CASE WHEN TG_TABLE_NAME='paper_execution_reports' THEN 'PAPER' ELSE 'FAKE_CONTRACT' END) THEN RAISE EXCEPTION 'Execution environment mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER paper_fact_scope BEFORE INSERT ON paper_execution_reports FOR EACH ROW EXECUTE FUNCTION guard_execution_scope();
CREATE TRIGGER fake_fact_scope BEFORE INSERT ON fake_execution_reports FOR EACH ROW EXECUTE FUNCTION guard_execution_scope();
--> statement-breakpoint
CREATE FUNCTION validate_capital_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bots; t trade_lifecycles;
BEGIN
 SELECT * INTO b FROM bots WHERE id=NEW.bot_id;
 IF b.exchange_account_id IS DISTINCT FROM NEW.account_id OR b.execution_mode<>'PAPER' THEN RAISE EXCEPTION 'Paper capital attribution mismatch'; END IF;
 IF NEW.kind='FUNDING' THEN
  IF NEW.trade_id IS NOT NULL OR NEW.source<>'initial-funding:'||b.id::text OR NEW.amount<>(SELECT equity_baseline*b.allocation_target_percent/100 FROM exchange_accounts WHERE id=b.exchange_account_id) OR NEW.amount<0 THEN RAISE EXCEPTION 'Invalid initial paper funding'; END IF;
 ELSE
  PERFORM assert_runtime_write(NEW.bot_id);
  SELECT * INTO t FROM trade_lifecycles WHERE id=NEW.trade_id;
  IF t.bot_id IS DISTINCT FROM NEW.bot_id OR t.account_id IS DISTINCT FROM NEW.account_id OR t.execution_backend<>'PAPER' OR NEW.kind NOT IN ('GROSS_PNL','FEE','FUNDING_PAYMENT') OR (NEW.kind='FEE' AND NEW.amount>0) THEN RAISE EXCEPTION 'Invalid paper financial posting'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capital_attribution BEFORE INSERT ON paper_capital_ledger FOR EACH ROW EXECUTE FUNCTION validate_capital_posting();
CREATE FUNCTION initialize_paper_capital() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.execution_mode='PAPER' THEN
  INSERT INTO paper_capital_ledger(account_id,bot_id,source,kind,amount,event_time)
  SELECT NEW.exchange_account_id,NEW.id,'initial-funding:'||NEW.id::text,'FUNDING',equity_baseline*NEW.allocation_target_percent/100,(extract(epoch FROM clock_timestamp())*1000)::bigint FROM exchange_accounts WHERE id=NEW.exchange_account_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER initial_paper_funding AFTER INSERT ON bots FOR EACH ROW EXECUTE FUNCTION initialize_paper_capital();
--> statement-breakpoint
CREATE FUNCTION require_paper_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.execution_backend='PAPER' AND NOT EXISTS(SELECT 1 FROM paper_reservations r WHERE r.trade_id=NEW.id AND r.bot_id=NEW.bot_id AND r.account_id=NEW.account_id AND (r.approval->>'quantity')::numeric=NEW.requested_quantity AND (r.approval->>'entry')::numeric=NEW.entry_reference AND (r.approval->>'stop')::numeric=NEW.initial_stop AND r.approval->>'side'=NEW.side) THEN RAISE EXCEPTION 'Paper intent requires matching risk approval and capital reservation'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER paper_approval AFTER INSERT OR UPDATE ON trade_lifecycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_paper_approval();
CREATE FUNCTION guard_paper_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE equity numeric; principal numeric; total numeric; budget numeric; t trade_lifecycles;
BEGIN
 PERFORM 1 FROM exchange_accounts WHERE id=NEW.account_id FOR UPDATE;
 SELECT * INTO t FROM trade_lifecycles WHERE id=NEW.trade_id;
 IF t.bot_id IS DISTINCT FROM NEW.bot_id OR t.account_id IS DISTINCT FROM NEW.account_id OR t.execution_backend<>'PAPER' THEN RAISE EXCEPTION 'Reservation attribution mismatch'; END IF;
 IF TG_OP='UPDATE' AND (NEW.approval<>OLD.approval OR ROW(NEW.trade_id,NEW.bot_id,NEW.account_id) IS DISTINCT FROM ROW(OLD.trade_id,OLD.bot_id,OLD.account_id)) THEN RAISE EXCEPTION 'Risk approval is immutable'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT equity_baseline+coalesce((SELECT sum(amount) FROM paper_capital_ledger WHERE account_id=NEW.account_id AND kind<>'FUNDING'),0) INTO equity FROM exchange_accounts WHERE id=NEW.account_id;
  SELECT coalesce(sum(amount),0) INTO budget FROM paper_capital_ledger WHERE bot_id=NEW.bot_id;
  IF NEW.reserved+NEW.committed>budget OR NEW.reserved<=(0) OR (NEW.approval->>'leverage')::numeric NOT BETWEEN 1 AND (CASE (SELECT risk_profile FROM bots WHERE id=NEW.bot_id) WHEN 'CONSERVATIVE' THEN 5 WHEN 'MODERATE' THEN 10 ELSE 15 END) THEN RAISE EXCEPTION 'Paper bot capital/leverage exceeded'; END IF;
  SELECT coalesce(sum(reserved+committed),0)+NEW.reserved+NEW.committed INTO total FROM paper_reservations WHERE account_id=NEW.account_id;
  IF total>equity*.4 OR (SELECT coalesce(sum(notional),0)+NEW.notional FROM paper_reservations WHERE account_id=NEW.account_id)>equity OR (SELECT coalesce(sum(stop_exposure),0)+NEW.stop_exposure FROM paper_reservations WHERE account_id=NEW.account_id)>equity*.02 THEN RAISE EXCEPTION 'Paper portfolio capacity exceeded'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER paper_reservation_guard BEFORE INSERT OR UPDATE ON paper_reservations FOR EACH ROW EXECUTE FUNCTION guard_paper_reservation();
CREATE INDEX capital_by_bot_time ON paper_capital_ledger(bot_id,event_time,sequence);
CREATE INDEX paper_facts_by_bot ON paper_execution_reports(bot_id,sequence);
