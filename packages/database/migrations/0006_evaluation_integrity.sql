CREATE TRIGGER evaluation_immutable BEFORE UPDATE OR DELETE ON strategy_evaluations
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE INDEX evaluation_bot_time ON strategy_evaluations (bot_id,event_time DESC);
--> statement-breakpoint
CREATE FUNCTION validate_evaluation_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE config bot_config_versions; strategy strategy_versions; slug text;
BEGIN
 SELECT * INTO config FROM bot_config_versions WHERE id=NEW.config_snapshot_id;
 SELECT * INTO strategy FROM strategy_versions WHERE id=NEW.strategy_version_id;
 SELECT strategies.slug INTO slug FROM strategies WHERE id=strategy.strategy_id;
 IF config.bot_id <> NEW.bot_id OR config.config_version <> NEW.config_version
 OR config.config_json->>'strategyVersionId' IS DISTINCT FROM NEW.strategy_version_id::text
 OR NEW.snapshot->'strategy'->>'id' IS DISTINCT FROM slug
 OR NEW.snapshot->'strategy'->'parameters' IS DISTINCT FROM strategy.requirements->'parameters'
 OR NEW.snapshot->'strategy'->'managementPolicy' IS DISTINCT FROM strategy.requirements->'managementPolicy'
 OR NEW.snapshot->'strategy'->'requirements' IS DISTINCT FROM (strategy.requirements - 'implemented' - 'validationStatus' - 'preset' - 'parameters' - 'managementPolicy')
 OR NEW.snapshot->'context'->>'marketKey' IS DISTINCT FROM config.config_json->>'canonicalMarketId'
 OR strategy.code_hash IS NULL
 OR NEW.snapshot->'strategy'->>'codeHash' IS DISTINCT FROM strategy.code_hash
 OR NEW.snapshot->'strategy'->>'version' IS DISTINCT FROM strategy.version
 OR (NEW.snapshot->>'configVersion')::integer IS DISTINCT FROM NEW.config_version
 OR (NEW.snapshot->'context'->>'marketCutoff')::bigint IS DISTINCT FROM NEW.event_time
 OR (NEW.snapshot->'context'->>'decisionTime')::bigint IS DISTINCT FROM NEW.decision_time
 OR NEW.snapshot->'decision'->>'reason' IS DISTINCT FROM NEW.reason_code
 OR (NEW.decision='NO_TRADE' AND NEW.snapshot->'decision'->>'action' IS DISTINCT FROM 'NO_TRADE')
 OR (NEW.decision IN ('LONG','SHORT') AND (NEW.snapshot->'decision'->>'action' IS DISTINCT FROM 'PROPOSE_ENTRY' OR NEW.snapshot->'decision'->>'side' IS DISTINCT FROM NEW.decision))
 THEN RAISE EXCEPTION 'Evaluation does not match immutable configuration, code or decision snapshot' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_snapshot_matches BEFORE INSERT ON strategy_evaluations
 FOR EACH ROW EXECUTE FUNCTION validate_evaluation_snapshot();
