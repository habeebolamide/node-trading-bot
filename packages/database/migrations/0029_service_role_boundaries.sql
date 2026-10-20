CREATE FUNCTION enforce_service_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope text; worker boolean; runtime boolean;
BEGIN
 -- Database administrators remain the trusted migration/restore authority.
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RETURN NEW; END IF;
 SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='platform_worker' AND pg_has_role(current_user,oid,'member')),
        EXISTS(SELECT 1 FROM pg_roles WHERE rolname='platform_runtime' AND pg_has_role(current_user,oid,'member')) INTO worker,runtime;
 IF NOT worker AND NOT runtime THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='exchange_accounts' THEN scope:=NEW.replay_scope;
 ELSIF TG_TABLE_NAME='bots' THEN SELECT replay_scope INTO scope FROM exchange_accounts WHERE id=NEW.exchange_account_id;
 ELSIF TG_TABLE_NAME='paper_equity_peaks' THEN SELECT replay_scope INTO scope FROM exchange_accounts WHERE id=NEW.account_id;
 ELSE SELECT a.replay_scope INTO scope FROM bots b JOIN exchange_accounts a ON a.id=b.exchange_account_id WHERE b.id=NEW.bot_id;
 END IF;
 IF (worker AND scope IS DISTINCT FROM 'REPLAY') OR (runtime AND scope IS DISTINCT FROM 'FORWARD') THEN
  RAISE EXCEPTION 'Service role cannot mutate this execution scope' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['exchange_accounts','bots','runtime_leases','runtime_checkpoints','runtime_events','runtime_actions','trade_lifecycles','paper_marks','paper_price_events','paper_reservations','paper_capital_ledger','paper_execution_reports','paper_funding_events','paper_equity_peaks','recovery_gaps'] LOOP
  EXECUTE format('CREATE TRIGGER service_scope BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_service_scope()',target);
 END LOOP;
END $$;
