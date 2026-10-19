-- Always acquire the account coordinator before checking the aggregate envelope.
CREATE FUNCTION enforce_allocation_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocated numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.exchange_account_id <> OLD.exchange_account_id THEN
    RAISE EXCEPTION 'Account reassignment is forbidden' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM exchange_accounts WHERE id = NEW.exchange_account_id FOR UPDATE;
  SELECT COALESCE(sum(allocation_target_percent),0) INTO allocated
    FROM bots WHERE exchange_account_id = NEW.exchange_account_id AND id <> NEW.id;
  IF allocated + NEW.allocation_target_percent > 80 THEN
    RAISE EXCEPTION 'Total target allocation exceeds 80 percent'
      USING ERRCODE='23514', CONSTRAINT='account_allocation_cap';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bot_allocation_cap BEFORE INSERT OR UPDATE ON bots
  FOR EACH ROW EXECUTE FUNCTION enforce_allocation_cap();
--> statement-breakpoint
CREATE FUNCTION reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Append-only record cannot be modified' USING ERRCODE='23514'; END $$;
CREATE TRIGGER config_immutable BEFORE UPDATE OR DELETE ON bot_config_versions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER strategy_version_immutable BEFORE UPDATE OR DELETE ON strategy_versions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
-- No safe ownership release workflow exists until the exposure modules are implemented.
CREATE TRIGGER ownership_immutable BEFORE UPDATE OR DELETE ON coin_ownership FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE FUNCTION enforce_bot_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM bot_config_versions c WHERE c.bot_id=NEW.id AND c.config_version=NEW.config_version AND c.config_json->>'canonicalMarketId'=NEW.canonical_market_id AND c.config_json->>'name'=NEW.name AND (c.config_json->>'allocationTargetPercent')::numeric=NEW.allocation_target_percent) THEN
   RAISE EXCEPTION 'Bot requires a matching immutable configuration snapshot' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM coin_ownership o WHERE o.bot_id=NEW.id AND o.exchange_account_id=NEW.exchange_account_id AND o.canonical_coin_key=NEW.market->>'baseAsset' AND o.released_at IS NULL) THEN
   RAISE EXCEPTION 'Bot requires canonical coin ownership' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER bot_snapshot_required AFTER INSERT OR UPDATE ON bots
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_bot_snapshot();
