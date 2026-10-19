CREATE FUNCTION enforce_ownership_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM exchange_accounts WHERE id=NEW.exchange_account_id AND replay_scope=NEW.scope) THEN RAISE EXCEPTION 'Coin ownership scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ownership_scope BEFORE INSERT OR UPDATE ON coin_ownership FOR EACH ROW EXECUTE FUNCTION enforce_ownership_scope();
CREATE FUNCTION immutable_account_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.replay_scope,NEW.owner_user_id) IS DISTINCT FROM ROW(OLD.replay_scope,OLD.owner_user_id) THEN RAISE EXCEPTION 'Account simulation boundary is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_scope BEFORE UPDATE ON exchange_accounts FOR EACH ROW EXECUTE FUNCTION immutable_account_scope();
CREATE TRIGGER replay_instrument_immutable BEFORE UPDATE OR DELETE ON replay_instruments FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
ALTER TABLE replay_runs ADD CONSTRAINT replay_status CHECK(status IN ('QUEUED','RUNNING','COMPLETED','UNCERTAIN','FAILED'));
ALTER TABLE recovery_gaps ADD CONSTRAINT recovery_status CHECK(status IN ('OPEN','REPLAYING','RESOLVED','UNCERTAIN'));
CREATE TRIGGER recovery_fence BEFORE INSERT OR UPDATE ON recovery_gaps FOR EACH ROW EXECUTE FUNCTION require_runtime_write();
CREATE FUNCTION guard_replay_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.input,NEW.input_hash,NEW.owner_user_id) IS DISTINCT FROM ROW(OLD.input,OLD.input_hash,OLD.owner_user_id) OR NEW.checkpoint<OLD.checkpoint OR (OLD.status IN ('COMPLETED','UNCERTAIN','FAILED') AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Replay identity/report is immutable or checkpoint regressed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER replay_identity BEFORE UPDATE ON replay_runs FOR EACH ROW EXECUTE FUNCTION guard_replay_identity();
