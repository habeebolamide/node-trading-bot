CREATE FUNCTION assert_runtime_write(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('platform.runtime_bot',true) IS DISTINCT FROM target::text OR NOT EXISTS (
  SELECT 1 FROM runtime_leases WHERE bot_id=target
   AND owner_instance_id::text=current_setting('platform.runtime_owner',true)
   AND fencing_token::text=current_setting('platform.runtime_fence',true)
   AND expires_at>clock_timestamp()
 ) THEN RAISE EXCEPTION 'FENCED: runtime ownership is absent, expired or stale' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION require_runtime_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM assert_runtime_write(NEW.bot_id); RETURN NEW; END $$;
CREATE TRIGGER fence_trade BEFORE INSERT OR UPDATE ON trade_lifecycles FOR EACH ROW EXECUTE FUNCTION require_runtime_write();
CREATE TRIGGER fence_action BEFORE INSERT OR UPDATE ON runtime_actions FOR EACH ROW EXECUTE FUNCTION require_runtime_write();
CREATE TRIGGER fence_checkpoint BEFORE INSERT OR UPDATE ON runtime_checkpoints FOR EACH ROW EXECUTE FUNCTION require_runtime_write();
CREATE TRIGGER fence_event BEFORE INSERT ON runtime_events FOR EACH ROW EXECUTE FUNCTION require_runtime_write();
CREATE TRIGGER runtime_event_immutable BEFORE UPDATE OR DELETE ON runtime_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER fake_report_immutable BEFORE UPDATE OR DELETE ON fake_execution_reports FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_config_version_step() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean;
BEGIN
 changed := ROW(NEW.name,NEW.canonical_market_id,NEW.market,NEW.exchange_account_id,NEW.strategy_version_id,NEW.execution_mode,NEW.risk_profile,NEW.allocation_target_percent)
 IS DISTINCT FROM ROW(OLD.name,OLD.canonical_market_id,OLD.market,OLD.exchange_account_id,OLD.strategy_version_id,OLD.execution_mode,OLD.risk_profile,OLD.allocation_target_percent);
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Record version must advance by one' USING ERRCODE='23514'; END IF;
 IF changed THEN
  IF OLD.operational_status<>'STOPPED' OR OLD.trading_state<>'IDLE' OR NEW.config_version<>OLD.config_version+1
    OR EXISTS(SELECT 1 FROM trade_lifecycles WHERE bot_id=OLD.id AND state IN ('PENDING_ENTRY','OPEN','CLOSING','UNRESOLVED')) THEN
   RAISE EXCEPTION 'Configuration changes require stopped idle state and a new version' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.config_version<>OLD.config_version THEN RAISE EXCEPTION 'Runtime must preserve configuration version' USING ERRCODE='23514'; END IF;
  PERFORM assert_runtime_write(NEW.id);
 END IF;
 IF NEW.operational_status IS DISTINCT FROM OLD.operational_status OR NEW.trading_state IS DISTINCT FROM OLD.trading_state THEN
  PERFORM assert_runtime_write(NEW.id);
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_bot_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM bot_config_versions c WHERE c.bot_id=NEW.id AND c.config_version=NEW.config_version
   AND c.config_json->>'canonicalMarketId'=NEW.canonical_market_id AND c.config_json->>'name'=NEW.name
   AND c.config_json->'market'=NEW.market AND c.config_json->>'accountId'=NEW.exchange_account_id::text
   AND c.config_json->>'strategyVersionId'=NEW.strategy_version_id::text AND c.config_json->>'executionMode'=NEW.execution_mode
   AND c.config_json->>'riskProfile'=NEW.risk_profile AND (c.config_json->>'allocationTargetPercent')::numeric=NEW.allocation_target_percent
 ) THEN RAISE EXCEPTION 'Bot requires matching immutable configuration' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (SELECT 1 FROM coin_ownership o WHERE o.bot_id=NEW.id AND o.exchange_account_id=NEW.exchange_account_id AND o.canonical_coin_key=NEW.market->>'baseAsset' AND o.released_at IS NULL) THEN
  RAISE EXCEPTION 'Bot requires canonical ownership' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION check_runtime_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; bot bots; active trade_lifecycles; expected text;
BEGIN
 IF TG_TABLE_NAME='bots' THEN target:=NEW.id; ELSE target:=NEW.bot_id; END IF;
 SELECT * INTO bot FROM bots WHERE id=target;
 SELECT * INTO active FROM trade_lifecycles WHERE bot_id=target AND state IN ('PENDING_ENTRY','OPEN','CLOSING','UNRESOLVED');
 expected:=CASE active.state WHEN 'PENDING_ENTRY' THEN 'PENDING_ENTRY' WHEN 'OPEN' THEN 'IN_TRADE' WHEN 'CLOSING' THEN 'CLOSING' WHEN 'UNRESOLVED' THEN 'UNRESOLVED' ELSE 'IDLE' END;
 IF bot.trading_state<>expected OR (bot.operational_status='STOPPED' AND expected<>'IDLE') THEN
  RAISE EXCEPTION 'Bot and durable exposure state disagree' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER bot_runtime_projection AFTER INSERT OR UPDATE ON bots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_runtime_projection();
CREATE CONSTRAINT TRIGGER trade_runtime_projection AFTER INSERT OR UPDATE ON trade_lifecycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_runtime_projection();
--> statement-breakpoint
CREATE FUNCTION validate_trade_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evaluation strategy_evaluations;
BEGIN
 SELECT * INTO evaluation FROM strategy_evaluations WHERE id=NEW.evaluation_id;
 IF evaluation.bot_id IS DISTINCT FROM NEW.bot_id OR evaluation.account_id IS DISTINCT FROM NEW.account_id OR evaluation.decision IS DISTINCT FROM NEW.side THEN
  RAISE EXCEPTION 'Trade requires its own actionable evaluation' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.bot_id,NEW.account_id,NEW.evaluation_id,NEW.requested_quantity,NEW.side,NEW.initial_stop,NEW.execution_backend)
 IS DISTINCT FROM ROW(OLD.bot_id,OLD.account_id,OLD.evaluation_id,OLD.requested_quantity,OLD.side,OLD.initial_stop,OLD.execution_backend) THEN
  RAISE EXCEPTION 'Trade identity and initial risk cannot change' USING ERRCODE='23514'; END IF;
 IF NEW.state IN ('CLOSED','CANCELLED','EXPIRED') AND (NOT NEW.entry_terminal OR NEW.filled_quantity<>NEW.closed_quantity) THEN
  RAISE EXCEPTION 'Unresolved exposure cannot become terminal' USING ERRCODE='23514'; END IF;
 IF NEW.protection_status='CONFIRMED' AND (NEW.confirmed_stop IS NULL OR NEW.protected_quantity<NEW.filled_quantity-NEW.closed_quantity) THEN
  RAISE EXCEPTION 'Protection cannot be claimed without confirmed coverage' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trade_identity BEFORE INSERT OR UPDATE ON trade_lifecycles FOR EACH ROW EXECUTE FUNCTION validate_trade_identity();
--> statement-breakpoint
CREATE FUNCTION validate_action_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM trade_lifecycles WHERE id=NEW.trade_id AND bot_id=NEW.bot_id AND execution_backend='FAKE_CONTRACT') THEN
  RAISE EXCEPTION 'Action scope mismatch' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.bot_id,NEW.trade_id,NEW.idempotency_key,NEW.kind,NEW.quantity,NEW.price,NEW.stop_price,NEW.take_profit,NEW.revision)
 IS DISTINCT FROM ROW(OLD.id,OLD.bot_id,OLD.trade_id,OLD.idempotency_key,OLD.kind,OLD.quantity,OLD.price,OLD.stop_price,OLD.take_profit,OLD.revision) THEN
  RAISE EXCEPTION 'Execution intent is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER action_identity BEFORE INSERT OR UPDATE ON runtime_actions FOR EACH ROW EXECUTE FUNCTION validate_action_identity();
CREATE FUNCTION guard_command_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM assert_runtime_write(NEW.bot_id);
 IF OLD.status<>'PENDING' OR ROW(NEW.bot_id,NEW.account_id,NEW.actor_id,NEW.kind,NEW.idempotency_key,NEW.reason)
 IS DISTINCT FROM ROW(OLD.bot_id,OLD.account_id,OLD.actor_id,OLD.kind,OLD.idempotency_key,OLD.reason) THEN
  RAISE EXCEPTION 'Command identity/terminal status is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER command_completion BEFORE UPDATE ON runtime_commands FOR EACH ROW EXECUTE FUNCTION guard_command_completion();
CREATE FUNCTION fence_active_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM bots WHERE id=NEW.bot_id AND operational_status<>'STOPPED') THEN PERFORM assert_runtime_write(NEW.bot_id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_fencing BEFORE INSERT ON strategy_evaluations FOR EACH ROW EXECUTE FUNCTION fence_active_evaluation();
CREATE INDEX runtime_pending_commands ON runtime_commands (bot_id,sequence) WHERE status='PENDING';
