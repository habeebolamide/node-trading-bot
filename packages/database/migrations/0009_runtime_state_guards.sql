CREATE FUNCTION check_operational_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
 IF NEW.operational_status=OLD.operational_status OR NEW.operational_status='ERROR' THEN RETURN NEW; END IF;
 allowed:=CASE OLD.operational_status
 WHEN 'STOPPED' THEN ARRAY['STARTING']
 WHEN 'STARTING' THEN ARRAY['RECONCILING','WARMING_UP','PAUSED','STOP_REQUESTED','STOPPED']
 WHEN 'WARMING_UP' THEN ARRAY['RUNNING','RECONCILING','PAUSED','STOP_REQUESTED','STOPPED']
 WHEN 'RUNNING' THEN ARRAY['PAUSED','STOP_REQUESTED','STOPPED','RECONCILING','WARMING_UP','RISK_SUSPENDED']
 WHEN 'PAUSED' THEN ARRAY['RECONCILING','STOP_REQUESTED','STOPPED']
 WHEN 'STOP_REQUESTED' THEN ARRAY['STOPPED','RECONCILING','PAUSED']
 WHEN 'RECONCILING' THEN ARRAY['WARMING_UP','PAUSED','STOP_REQUESTED','STOPPED']
 WHEN 'RISK_SUSPENDED' THEN ARRAY['PAUSED','STOP_REQUESTED','STOPPED','RECONCILING']
 WHEN 'ERROR' THEN ARRAY['RECONCILING','STOP_REQUESTED','STOPPED','PAUSED']
 ELSE ARRAY[]::text[] END;
 IF NOT NEW.operational_status=ANY(allowed) THEN RAISE EXCEPTION 'Illegal bot operational transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bot_operational_transition BEFORE UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION check_operational_transition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION check_runtime_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; bot bots; active trade_lifecycles; expected text;
BEGIN
 IF TG_TABLE_NAME='bots' THEN target:=NEW.id; ELSE target:=NEW.bot_id; END IF;
 SELECT * INTO bot FROM bots WHERE id=target;
 SELECT * INTO active FROM trade_lifecycles WHERE bot_id=target AND state IN ('PENDING_ENTRY','OPEN','CLOSING','UNRESOLVED');
 expected:=CASE active.state WHEN 'PENDING_ENTRY' THEN 'PENDING_ENTRY' WHEN 'OPEN' THEN 'IN_TRADE' WHEN 'CLOSING' THEN 'CLOSING' WHEN 'UNRESOLVED' THEN 'UNRESOLVED' ELSE 'IDLE' END;
 IF bot.trading_state<>expected OR (bot.operational_status='STOPPED' AND expected<>'IDLE') OR EXISTS(
   SELECT 1 FROM trade_lifecycles t JOIN runtime_actions a ON a.trade_id=t.id
   WHERE t.bot_id=target AND t.state IN ('CLOSED','CANCELLED','EXPIRED') AND a.state IN ('CREATED','SUBMITTING','OPEN','UNKNOWN')
 ) THEN RAISE EXCEPTION 'Bot, durable exposure or unresolved execution state disagree' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER action_runtime_projection AFTER INSERT OR UPDATE ON runtime_actions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_runtime_projection();
--> statement-breakpoint
CREATE FUNCTION check_fence_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.fencing_token<OLD.fencing_token OR (NEW.owner_instance_id<>OLD.owner_instance_id AND NEW.fencing_token<>OLD.fencing_token+1) THEN
 RAISE EXCEPTION 'Fencing token must increase on takeover' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lease_fence_monotonic BEFORE UPDATE ON runtime_leases FOR EACH ROW EXECUTE FUNCTION check_fence_monotonic();
