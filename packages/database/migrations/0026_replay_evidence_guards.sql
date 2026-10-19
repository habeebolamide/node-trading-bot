CREATE TRIGGER replay_sample_immutable BEFORE UPDATE OR DELETE ON replay_samples FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE OR REPLACE FUNCTION protect_recovery_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.bot_id,NEW.key,NEW.start_time) IS DISTINCT FROM ROW(OLD.bot_id,OLD.key,OLD.start_time) OR NEW.checkpoint<OLD.checkpoint
 OR NEW.coverage->'baseline' IS DISTINCT FROM OLD.coverage->'baseline'
 OR (OLD.checkpoint>=0 AND NEW.coverage->>'evidenceHash' IS DISTINCT FROM OLD.coverage->>'evidenceHash')
 OR (OLD.status='RESOLVED' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Recovery identity, applied evidence or checkpoint cannot change'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION validate_replay_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM exchange_accounts a WHERE a.id=NEW.account_id AND a.replay_scope=NEW.id::text) THEN RAISE EXCEPTION 'Replay requires its own simulation account'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.experiment_id,NEW.stage,NEW.variant,NEW.window_index) IS DISTINCT FROM ROW(OLD.experiment_id,OLD.stage,OLD.variant,OLD.window_index) OR (OLD.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id)) THEN RAISE EXCEPTION 'Replay provenance and account are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER replay_account_scope BEFORE INSERT OR UPDATE ON replay_runs FOR EACH ROW EXECUTE FUNCTION validate_replay_account();
