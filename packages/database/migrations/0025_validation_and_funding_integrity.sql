CREATE OR REPLACE FUNCTION guard_paper_financial_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fact jsonb; t trade_lifecycles; expected numeric; equity numeric; funded numeric;
BEGIN
 PERFORM 1 FROM exchange_accounts WHERE id=NEW.account_id FOR UPDATE;
 IF NEW.kind='FUNDING' THEN
  SELECT equity_baseline+coalesce((SELECT sum(amount) FROM paper_capital_ledger WHERE account_id=NEW.account_id AND kind<>'FUNDING'),0) INTO equity FROM exchange_accounts WHERE id=NEW.account_id;
  SELECT coalesce(sum(amount),0) INTO funded FROM paper_capital_ledger WHERE account_id=NEW.account_id;
  IF funded+NEW.amount>equity*.8 THEN RAISE EXCEPTION 'Initial paper funding exceeds refreshed allocation envelope'; END IF;
 ELSIF NEW.kind='FUNDING_PAYMENT' THEN
  IF NOT EXISTS(SELECT 1 FROM paper_funding_events f JOIN trade_lifecycles tr ON tr.id=f.trade_id WHERE NEW.source='funding:'||f.key AND f.bot_id=NEW.bot_id AND f.trade_id=NEW.trade_id AND tr.account_id=NEW.account_id AND f.amount=NEW.amount AND f.amount=trunc(f.price*f.quantity*f.rate::numeric*CASE WHEN tr.side='LONG' THEN -1 ELSE 1 END,18)) THEN RAISE EXCEPTION 'Funding requires attributed rate/position evidence'; END IF;
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

CREATE UNIQUE INDEX validation_window_unique ON replay_runs(experiment_id,stage,variant,window_index) WHERE experiment_id IS NOT NULL;
ALTER TABLE replay_runs ADD CONSTRAINT replay_experiment_fk FOREIGN KEY(experiment_id) REFERENCES replay_experiments(id);
CREATE FUNCTION protect_validation_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.owner_user_id,NEW.plan,NEW.variants) IS DISTINCT FROM ROW(OLD.owner_user_id,OLD.plan,OLD.variants) OR OLD.selected_variant IS NOT NULL THEN RAISE EXCEPTION 'Validation inputs and holdout selection are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validation_selection BEFORE UPDATE ON replay_experiments FOR EACH ROW EXECUTE FUNCTION protect_validation_selection();
CREATE FUNCTION protect_recovery_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.bot_id,NEW.key,NEW.start_time) IS DISTINCT FROM ROW(OLD.bot_id,OLD.key,OLD.start_time) OR NEW.checkpoint<OLD.checkpoint OR (OLD.status='RESOLVED' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Recovery identity/checkpoint cannot regress'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recovery_checkpoint BEFORE UPDATE ON recovery_gaps FOR EACH ROW EXECUTE FUNCTION protect_recovery_checkpoint();
