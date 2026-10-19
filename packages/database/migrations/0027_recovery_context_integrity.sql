ALTER TABLE recovery_gaps ADD CONSTRAINT recovery_gap_range CHECK(end_time IS NULL OR end_time>=start_time);
CREATE OR REPLACE FUNCTION protect_recovery_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.bot_id,NEW.key,NEW.start_time) IS DISTINCT FROM ROW(OLD.bot_id,OLD.key,OLD.start_time) OR NEW.checkpoint<OLD.checkpoint
 OR NEW.coverage->'baseline' IS DISTINCT FROM OLD.coverage->'baseline'
 OR (OLD.checkpoint>=0 AND ROW(NEW.coverage->>'evidenceHash',NEW.coverage->>'contextHash') IS DISTINCT FROM ROW(OLD.coverage->>'evidenceHash',OLD.coverage->>'contextHash'))
 OR (OLD.status='RESOLVED' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Recovery identity, applied evidence/context or checkpoint cannot change'; END IF;
 RETURN NEW;
END $$;
