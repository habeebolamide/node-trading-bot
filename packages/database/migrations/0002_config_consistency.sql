CREATE OR REPLACE FUNCTION enforce_bot_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM bot_config_versions c WHERE c.bot_id=NEW.id AND c.config_version=NEW.config_version
   AND c.config_json->>'canonicalMarketId'=NEW.canonical_market_id
   AND c.config_json->>'name'=NEW.name
   AND c.config_json->'market'=NEW.market
   AND c.config_json->>'accountId'=NEW.exchange_account_id::text
   AND c.config_json->>'strategyVersionId'=NEW.strategy_version_id::text
   AND c.config_json->>'executionMode'=NEW.execution_mode
   AND c.config_json->>'riskProfile'=NEW.risk_profile
   AND (c.config_json->>'version')::integer=NEW.version
   AND (c.config_json->>'allocationTargetPercent')::numeric=NEW.allocation_target_percent
 ) THEN
   RAISE EXCEPTION 'Bot requires a matching immutable configuration snapshot' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM coin_ownership o WHERE o.bot_id=NEW.id AND o.exchange_account_id=NEW.exchange_account_id AND o.canonical_coin_key=NEW.market->>'baseAsset' AND o.released_at IS NULL) THEN
   RAISE EXCEPTION 'Bot requires canonical coin ownership' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION enforce_config_version_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.config_version <> OLD.config_version+1 OR NEW.version <> OLD.version+1 THEN
   RAISE EXCEPTION 'Configuration and record versions must advance by one' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bot_version_step BEFORE UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION enforce_config_version_step();
